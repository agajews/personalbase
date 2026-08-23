import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Reactor, ReactorEvent } from "@nc/process";

// Invents a classification scheme for the saved library and assigns each
// saved item to a group. The scheme is a fact (agent.taxonomy.proposed);
// assignments are classified_as links to topic entities, carrying the
// schemeId in evidence. Re-runs classify only unassigned items; regenerate
// re-derives the scheme from scratch and reassigns everything.

export interface SavedItem {
  readonly entityId: string;
  readonly kind: string;
  readonly ref: string;
  readonly title: string;
  readonly abstract: string | null;
}

export interface SchemeCategory {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
}

export interface Usage {
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export type SchemeFn = (
  titles: readonly string[],
) => Promise<{ categories: SchemeCategory[]; usage: Usage }>;

export interface Assignment {
  readonly index: number;
  readonly slug: string;
  readonly confidence: number;
}

export type AssignFn = (
  categories: readonly SchemeCategory[],
  items: readonly { index: number; title: string; abstract: string | null }[],
) => Promise<{ assignments: Assignment[]; usage: Usage }>;

const schemeOutput = z.object({
  categories: z.array(
    z.object({
      slug: z.string().regex(/^[a-z0-9-]+$/),
      name: z.string().min(1),
      description: z.string(),
    }),
  ),
});

const schemeSystem = `You are organizing a researcher's personal library of
papers and resources. Given every title in the collection, invent a
classification scheme that fits THIS collection: 8 to 16 groups, each with a
kebab-case slug, a short name, and a one-sentence description. Groups should
reflect the actual clusters of interest in the collection (not generic
academic taxonomy), be roughly balanced where possible, and together cover
everything; a final catch-all group is acceptable if genuinely needed.`;

let client: Anthropic | undefined;

export const anthropicSchemeFn: SchemeFn = async (titles) => {
  client ??= new Anthropic();
  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,
    system: schemeSystem,
    messages: [
      { role: "user", content: titles.map((t, i) => `${i + 1}. ${t}`).join("\n") },
    ],
    output_config: { format: zodOutputFormat(schemeOutput) },
  });
  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new Error(`scheme response did not parse (stop_reason ${response.stop_reason})`);
  }
  return {
    categories: parsed.categories,
    usage: { tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens },
  };
};

const assignOutput = z.object({
  assignments: z.array(
    z.object({
      index: z.number().int(),
      slug: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

function assignSystem(categories: readonly SchemeCategory[]): string {
  return `You assign items from a researcher's library to the single
best-fitting group of this classification scheme:

${categories.map((c) => `- ${c.slug}: ${c.name} — ${c.description}`).join("\n")}

For each numbered item (title, sometimes an abstract excerpt), return its
index, the chosen group slug (exactly as listed), and a confidence in [0, 1].
Return exactly one assignment per item.`;
}

async function assignOnce(
  categories: readonly SchemeCategory[],
  items: readonly { index: number; title: string; abstract: string | null }[],
): Promise<{ byIndex: Map<number, Assignment>; usage: Usage }> {
  client ??= new Anthropic();
  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,
    system: [{ type: "text", text: assignSystem(categories), cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: items
          .map(
            (item) =>
              `${item.index}. ${item.title}` +
              (item.abstract === null ? "" : `\n   ${item.abstract.slice(0, 300)}`),
          )
          .join("\n\n"),
      },
    ],
    output_config: { format: zodOutputFormat(assignOutput) },
  });
  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new Error(`assignment response did not parse (stop_reason ${response.stop_reason})`);
  }
  const valid = new Set(categories.map((c) => c.slug));
  const byIndex = new Map(
    parsed.assignments.filter((a) => valid.has(a.slug)).map((a) => [a.index, a]),
  );
  return {
    byIndex,
    usage: { tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens },
  };
}

export const anthropicAssignFn: AssignFn = async (categories, items) => {
  const first = await assignOnce(categories, items);
  let tokensIn = first.usage.tokensIn;
  let tokensOut = first.usage.tokensOut;
  const byIndex = first.byIndex;
  // Re-ask once for anything omitted or assigned an invalid slug.
  const missing = items.filter((item) => !byIndex.has(item.index));
  if (missing.length > 0) {
    const retry = await assignOnce(categories, missing);
    tokensIn += retry.usage.tokensIn;
    tokensOut += retry.usage.tokensOut;
    for (const [index, a] of retry.byIndex) {
      byIndex.set(index, a);
    }
  }
  const assignments = items.map((item) => {
    const a = byIndex.get(item.index);
    if (a === undefined) {
      throw new Error(`no assignment for item ${item.index} even after retry`);
    }
    return a;
  });
  return { assignments, usage: { tokensIn, tokensOut } };
};

export const taxonomyJobPayload = z.object({ regenerate: z.boolean().optional() });

const batchSize = 20;

export function makeTaxonomyReactor(schemeFn: SchemeFn, assignFn: AssignFn): Reactor {
  return {
    kind: "reactor",
    name: "taxonomy",
    trigger: { kind: "manual" },
    async run(ctx, input): Promise<ReactorEvent[]> {
      if (input.kind !== "job") {
        throw new Error("taxonomy reactor only supports job triggers");
      }
      const payload = taxonomyJobPayload.parse(input.payload);
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
        console.log("taxonomy: nothing saved yet, nothing to classify");
        return [];
      }

      const events: ReactorEvent[] = [];
      const existing = await ctx.sql`
        select slug, name, description, scheme_id from taxonomy_categories order by position`;
      let categories: SchemeCategory[];
      let schemeId: string;
      if (payload.regenerate === true || existing.length === 0) {
        const proposed = await schemeFn(saved.map((s) => s.title));
        ctx.recordUsage(proposed.usage);
        categories = proposed.categories;
        schemeId = createHash("sha256")
          .update(JSON.stringify(categories))
          .digest("hex")
          .slice(0, 12);
        events.push({
          type: "agent.taxonomy.proposed",
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          payload: { schemeId, categories },
          idempotencyKey: `taxonomy:scheme:${schemeId}`,
        });
        console.log(`taxonomy: proposed scheme ${schemeId} with ${categories.length} groups`);
      } else {
        categories = existing.map((r) => ({
          slug: r["slug"],
          name: r["name"],
          description: r["description"],
        }));
        schemeId = existing[0]!["scheme_id"];
      }

      // Under an unchanged scheme, only classify items not yet assigned.
      const classified =
        payload.regenerate === true
          ? new Set<string>()
          : new Set(
              (
                await ctx.sql`
                  select from_id from links
                  where link_type = 'classified_as' and evidence->>'schemeId' = ${schemeId}`
              ).map((r) => r["from_id"] as string),
            );
      const targets = saved.filter((s) => !classified.has(s.entityId));
      console.log(`taxonomy: classifying ${targets.length} of ${saved.length} saved items`);
      const byName = new Map(categories.map((c) => [c.slug, c.name]));
      for (let i = 0; i < targets.length; i += batchSize) {
        const batch = targets.slice(i, i + batchSize);
        const result = await assignFn(
          categories,
          batch.map((item, j) => ({ index: j, title: item.title, abstract: item.abstract })),
        );
        ctx.recordUsage(result.usage);
        const assignedAt = new Date().toISOString();
        for (const a of result.assignments) {
          const item = batch[a.index]!;
          events.push({
            type: "agent.link.asserted",
            schemaVersion: 1,
            occurredAt: assignedAt,
            payload: {
              from: { kind: item.kind, ref: item.ref },
              to: {
                kind: "topic",
                ref: `taxonomy:${a.slug}`,
                displayName: byName.get(a.slug),
              },
              linkType: "classified_as",
              confidence: a.confidence,
              evidence: { schemeId },
            },
            idempotencyKey: `taxonomy:${schemeId}:${item.entityId}`,
          });
        }
      }
      return events;
    },
  };
}

export const taxonomyReactor: Reactor = makeTaxonomyReactor(anthropicSchemeFn, anthropicAssignFn);
