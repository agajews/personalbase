import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Reactor, ReactorEvent } from "@nc/process";
import type { SavedItem } from "./taxonomy.js";

// Granular topic tags over the saved library. Where the taxonomy reactor
// invents a dozen broad groups and files each item under exactly one, this
// one invents a few hundred specific tags and hangs several on every item —
// enough overlap that co-occurrence between tags is itself a graph. The
// vocabulary is a fact (agent.tagvocab.proposed); each item's tags are one
// fact per item (agent.item.tagged). Re-runs tag only untagged items;
// regenerate re-derives the vocabulary and re-tags everything.

/** Facets colour the graph and keep the vocabulary from drifting into prose. */
export const facets = [
  "task",
  "method",
  "architecture",
  "theory",
  "training",
  "evaluation",
  "systems",
  "application",
] as const;

export interface VocabTag {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly facet: string;
}

export interface Usage {
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export type VocabFn = (
  titles: readonly string[],
) => Promise<{ tags: VocabTag[]; usage: Usage }>;

export interface ItemTags {
  readonly index: number;
  readonly slugs: readonly string[];
}

export type TagFn = (
  vocab: readonly VocabTag[],
  items: readonly { index: number; title: string; abstract: string | null }[],
) => Promise<{ tagged: ItemTags[]; usage: Usage }>;

const vocabOutput = z.object({
  tags: z.array(
    z.object({
      slug: z.string().regex(/^[a-z0-9-]+$/),
      name: z.string().min(1),
      description: z.string(),
      facet: z.enum(facets),
    }),
  ),
});

const vocabSystem = `You are building a tag vocabulary for a researcher's
personal library of papers and resources. Given every title in the collection,
propose 150 to 250 GRANULAR tags — the kind a careful reader would attach to a
single paper, not broad fields.

Rules:
- Specific, not generic: "speculative-decoding", "grokking", "mixture-of-experts",
  "rlhf-reward-hacking" — never "machine-learning", "deep-learning", "ai", "nlp".
- Each tag must plausibly fit several papers in THIS collection; drop ideas that
  would only ever match one paper, and drop ideas nothing here would match.
- No near-duplicates: pick one of "chain-of-thought" / "cot-prompting", never both.
- Together they should cover the collection densely enough that a typical paper
  earns 3 to 8 of them.
- Give each tag a kebab-case slug, a short human name, a one-sentence
  description, and one facet from: task, method, architecture, theory, training,
  evaluation, systems, application.`;

let client: Anthropic | undefined;

export const anthropicVocabFn: VocabFn = async (titles) => {
  client ??= new Anthropic();
  // Streamed: a whole-library vocabulary is a long generation, and the SDK
  // refuses non-streaming requests that may outlast its 10-minute ceiling.
  const response = await client.messages
    .stream({
      model: "claude-opus-5",
      max_tokens: 32000,
      system: vocabSystem,
      messages: [
        { role: "user", content: titles.map((t, i) => `${i + 1}. ${t}`).join("\n") },
      ],
      output_config: { format: zodOutputFormat(vocabOutput) },
    })
    .finalMessage();
  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new Error(`vocabulary response did not parse (stop_reason ${response.stop_reason})`);
  }
  // Slugs are the vocabulary's primary key; a duplicate would collide.
  const bySlug = new Map(parsed.tags.map((t) => [t.slug, t]));
  return {
    tags: [...bySlug.values()],
    usage: { tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens },
  };
};

const tagOutput = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      slugs: z.array(z.string()),
    }),
  ),
});

function tagSystem(vocab: readonly VocabTag[]): string {
  return `You tag items in a researcher's library using this fixed vocabulary:

${vocab.map((t) => `- ${t.slug}: ${t.name} — ${t.description}`).join("\n")}

For each numbered item (title, usually an abstract excerpt) return its index
and the slugs that genuinely apply — typically 3 to 8, ordered most to least
central. Use slugs exactly as listed and invent nothing; an item that fits
none gets an empty list. Tag what the work IS about, not what it mentions in
passing. Return exactly one entry per item.`;
}

async function tagOnce(
  vocab: readonly VocabTag[],
  items: readonly { index: number; title: string; abstract: string | null }[],
): Promise<{ byIndex: Map<number, string[]>; usage: Usage }> {
  client ??= new Anthropic();
  const response = await client.messages
    .stream({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: [{ type: "text", text: tagSystem(vocab), cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: items
            .map(
              (item) =>
                `${item.index}. ${item.title}` +
                (item.abstract === null ? "" : `\n   ${item.abstract.slice(0, 700)}`),
            )
            .join("\n\n"),
        },
      ],
      output_config: { format: zodOutputFormat(tagOutput) },
    })
    .finalMessage();
  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new Error(`tagging response did not parse (stop_reason ${response.stop_reason})`);
  }
  const valid = new Set(vocab.map((t) => t.slug));
  const byIndex = new Map(
    parsed.items.map((item) => [item.index, [...new Set(item.slugs)].filter((s) => valid.has(s))]),
  );
  return {
    byIndex,
    usage: { tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens },
  };
}

export const anthropicTagFn: TagFn = async (vocab, items) => {
  const first = await tagOnce(vocab, items);
  let tokensIn = first.usage.tokensIn;
  let tokensOut = first.usage.tokensOut;
  const byIndex = first.byIndex;
  // Re-ask once for anything the model omitted; an item it declines twice is
  // simply untagged, and the next run will try it again.
  const missing = items.filter((item) => !byIndex.has(item.index));
  if (missing.length > 0) {
    const retry = await tagOnce(vocab, missing);
    tokensIn += retry.usage.tokensIn;
    tokensOut += retry.usage.tokensOut;
    for (const [index, slugs] of retry.byIndex) {
      byIndex.set(index, slugs);
    }
  }
  return {
    tagged: [...byIndex.entries()].map(([index, slugs]) => ({ index, slugs })),
    usage: { tokensIn, tokensOut },
  };
};

export const taggerJobPayload = z.object({ regenerate: z.boolean().optional() });

const batchSize = 20;
/** Batches in flight at once: the whole library is ~60 calls sequentially. */
const concurrency = 4;

/** Confidence decays with position: the model orders slugs most-central first. */
function confidenceFor(rank: number, total: number): number {
  return total <= 1 ? 1 : Number((1 - (0.5 * rank) / (total - 1)).toFixed(2));
}

/** Runs `worker` over the batches, at most `concurrency` at a time, in order. */
async function forEachBatch<T>(
  batches: readonly T[],
  worker: (batch: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, batches.length) }, async () => {
    while (next < batches.length) {
      const index = next++;
      await worker(batches[index]!, index);
    }
  });
  await Promise.all(lanes);
}

export function makeTaggerReactor(vocabFn: VocabFn, tagFn: TagFn): Reactor {
  return {
    kind: "reactor",
    name: "tagger",
    trigger: { kind: "manual" },
    async run(ctx, input): Promise<ReactorEvent[]> {
      if (input.kind !== "job") {
        throw new Error("tagger reactor only supports job triggers");
      }
      const payload = taggerJobPayload.parse(input.payload);
      const saved: SavedItem[] = (
        await ctx.sql`
          select distinct on (e.entity_id)
                 e.entity_id, e.kind, e.ref, e.display_name,
                 coalesce(p.abstract, li.abstract) as abstract
          from paper_marks m
          join entities e on e.entity_id = m.entity_id
          left join papers p on p.entity_id = e.entity_id
          left join library_items li on li.entity_id = e.entity_id
          order by e.entity_id`
      ).map((r) => ({
        entityId: r["entity_id"],
        kind: r["kind"],
        ref: r["ref"],
        title: r["display_name"] ?? r["ref"],
        abstract: r["abstract"],
      }));
      if (saved.length === 0) {
        console.log("tagger: nothing saved yet, nothing to tag");
        return [];
      }

      const events: ReactorEvent[] = [];
      const existing = await ctx.sql`
        select slug, name, description, facet, vocab_id from tag_vocab order by position`;
      let vocab: VocabTag[];
      let vocabId: string;
      if (payload.regenerate === true || existing.length === 0) {
        const proposed = await vocabFn(saved.map((s) => s.title));
        ctx.recordUsage(proposed.usage);
        vocab = proposed.tags;
        vocabId = createHash("sha256").update(JSON.stringify(vocab)).digest("hex").slice(0, 12);
        events.push({
          type: "agent.tagvocab.proposed",
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          payload: { vocabId, tags: vocab },
          idempotencyKey: `tags:vocab:${vocabId}`,
        });
        console.log(`tagger: proposed vocabulary ${vocabId} with ${vocab.length} tags`);
      } else {
        vocab = existing.map((r) => ({
          slug: r["slug"],
          name: r["name"],
          description: r["description"],
          facet: r["facet"],
        }));
        vocabId = existing[0]!["vocab_id"];
      }

      // Under an unchanged vocabulary, only tag items that have no tags yet.
      const tagged =
        payload.regenerate === true
          ? new Set<string>()
          : new Set(
              (
                await ctx.sql`
                  select distinct entity_id from item_tags where vocab_id = ${vocabId}`
              ).map((r) => r["entity_id"] as string),
            );
      const targets = saved.filter((s) => !tagged.has(s.entityId));
      console.log(`tagger: tagging ${targets.length} of ${saved.length} saved items`);
      const batches: SavedItem[][] = [];
      for (let i = 0; i < targets.length; i += batchSize) {
        batches.push(targets.slice(i, i + batchSize));
      }
      let done = 0;
      await forEachBatch(batches, async (batch) => {
        // A batch that fails is left untagged rather than losing the whole
        // run's work: re-running picks up exactly what is still missing.
        let result;
        try {
          result = await tagFn(
            vocab,
            batch.map((item, j) => ({ index: j, title: item.title, abstract: item.abstract })),
          );
        } catch (e) {
          console.error(`tagger: batch failed, leaving it untagged — ${String(e)}`);
          return;
        }
        ctx.recordUsage(result.usage);
        const taggedAt = new Date().toISOString();
        for (const entry of result.tagged) {
          const item = batch[entry.index];
          if (item === undefined || entry.slugs.length === 0) {
            continue;
          }
          events.push({
            type: "agent.item.tagged",
            schemaVersion: 1,
            occurredAt: taggedAt,
            payload: {
              vocabId,
              target: { kind: item.kind, ref: item.ref },
              tags: entry.slugs.map((slug, rank) => ({
                slug,
                confidence: confidenceFor(rank, entry.slugs.length),
              })),
            },
            idempotencyKey: `tags:${vocabId}:${item.entityId}`,
          });
        }
        done += batch.length;
        console.log(`tagger: ${done}/${targets.length} items tagged`);
      });
      return events;
    },
  };
}

export const taggerReactor: Reactor = makeTaggerReactor(anthropicVocabFn, anthropicTagFn);
