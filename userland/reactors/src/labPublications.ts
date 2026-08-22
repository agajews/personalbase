import { setTimeout as sleep } from "node:timers/promises";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Reactor, ReactorEvent } from "@nc/process";
import type { ArxivEntry } from "./arxivAtom.js";
import { entryToEvent, fetchArxivByIds, resolveArxivByTitle } from "./arxiv.js";

// Reads each lab's publications index with Claude + web fetch (the pages are
// JS-heavy and change shape; judgment beats brittle scraping) and ingests any
// arXiv-linked papers, asserting a published_by link to the lab's org entity.

export interface LabConfig {
  readonly org: string;   // canonical slug, matches the affiliation extractor
  readonly name: string;
  readonly url: string;
  readonly domains: readonly string[];
}

export const labs: readonly LabConfig[] = [
  {
    org: "openai",
    name: "OpenAI",
    url: "https://openai.com/research/",
    domains: ["openai.com"],
  },
  {
    org: "deepmind",
    name: "DeepMind",
    url: "https://deepmind.google/research/publications/",
    domains: ["deepmind.google"],
  },
  {
    org: "anthropic",
    name: "Anthropic",
    url: "https://www.anthropic.com/research",
    domains: ["anthropic.com", "www.anthropic.com"],
  },
  {
    org: "meta",
    name: "Meta",
    url: "https://ai.meta.com/results/?content_types[0]=publication",
    domains: ["ai.meta.com"],
  },
];

export interface LabListing {
  readonly items: readonly { title: string; arxivId: string | null }[];
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number };
}

export type LabLister = (lab: LabConfig) => Promise<LabListing>;

const listingSchema = z.array(
  z.object({ title: z.string(), arxivId: z.string().nullable() }),
);

const listerSystem = `You read a research lab's publications page and list its
most recent publications. Use web_fetch on the given URL. For each publication
you can see, report its title and its arXiv id if one is discoverable — bare
id like "2508.12345", no version suffix, null if the paper is not on arXiv.
If the index itself does not show arXiv links (many lab pages link to a post
per publication), spend your remaining fetches on the most recent individual
publication pages, newest first, and look for arxiv.org links inside them.
Recent-first, at most 40 items.

Reply with ONLY a JSON array: [{"title": "...", "arxivId": "2508.12345" | null}, ...]
No prose, no code fences.`;

let client: Anthropic | undefined;

export const anthropicLabLister: LabLister = async (lab) => {
  client ??= new Anthropic();
  const usage = { tokensIn: 0, tokensOut: 0 };
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `List recent publications from ${lab.name}: ${lab.url}` },
  ];
  while (true) {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: listerSystem,
      tools: [
        {
          type: "web_fetch_20260209",
          name: "web_fetch",
          max_uses: 6,
          allowed_domains: [...lab.domains, "arxiv.org"],
        },
      ],
      messages,
    });
    usage.tokensIn += response.usage.input_tokens;
    usage.tokensOut += response.usage.output_tokens;
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const jsonText = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    return { items: listingSchema.parse(JSON.parse(jsonText)), usage };
  }
};

export const labJobPayload = z.object({ lab: z.string().optional() });

interface LabState {
  seen: Record<string, string[]>;       // org -> arxiv ids already ingested
  seenTitles: Record<string, string[]>; // org -> titles already resolved (or unresolvable)
}

const titleResolveDelayMs = 3000; // arXiv API etiquette

export function makeLabPublicationsReactor(
  lister: LabLister,
  fetchByIds: typeof fetchArxivByIds,
  resolveByTitle: typeof resolveArxivByTitle,
): Reactor {
  return {
    kind: "reactor",
    name: "lab-publications",
    trigger: { kind: "cron", intervalHours: 24, payload: {} }, // all labs, daily
    async run(ctx, input): Promise<ReactorEvent[]> {
      if (input.kind !== "job") {
        throw new Error("lab-publications reactor only supports job triggers");
      }
      const payload = labJobPayload.parse(input.payload);
      const selected =
        payload.lab === undefined ? labs : labs.filter((l) => l.org === payload.lab);
      if (selected.length === 0) {
        throw new Error(`no lab configured as ${payload.lab}`);
      }
      const state = ((await ctx.getState()) ?? {}) as Partial<LabState>;
      const seenByOrg = state.seen ?? {};
      const seenTitlesByOrg = state.seenTitles ?? {};
      const events: ReactorEvent[] = [];
      for (const lab of selected) {
        const listing = await lister(lab);
        ctx.recordUsage(listing.usage);
        const seen = new Set(seenByOrg[lab.org] ?? []);
        const seenTitles = new Set(seenTitlesByOrg[lab.org] ?? []);

        // Lab indexes rarely expose arXiv links directly, so titles are the
        // reliable signal; ids are resolved through arXiv's own title search.
        const entries: ArxivEntry[] = [];
        const explicitIds = [
          ...new Set(
            listing.items
              .map((i) => i.arxivId)
              .filter((id): id is string => id !== null && !seen.has(id)),
          ),
        ];
        if (explicitIds.length > 0) {
          entries.push(...(await fetchByIds(explicitIds)));
        }
        const toResolve = listing.items.filter(
          (i) => i.arxivId === null && !seenTitles.has(i.title),
        );
        let unresolved = 0;
        for (const item of toResolve) {
          const entry = await resolveByTitle(item.title);
          if (entry === null) {
            unresolved += 1;
          } else if (!seen.has(entry.arxivId)) {
            entries.push(entry);
          }
          seenTitles.add(item.title);
          await sleep(titleResolveDelayMs);
        }
        console.log(
          `lab ${lab.org}: ${listing.items.length} listed, ${entries.length} new on arxiv, ` +
            `${unresolved} not found on arxiv`,
        );
        for (const entry of entries) {
          seen.add(entry.arxivId);
          events.push(entryToEvent(entry));
          events.push({
            type: "agent.link.asserted",
            schemaVersion: 1,
            occurredAt: new Date().toISOString(),
            payload: {
              from: { kind: "paper", ref: `arxiv:${entry.arxivId}`, displayName: entry.title },
              to: { kind: "org", ref: lab.org, displayName: lab.name },
              linkType: "published_by",
              confidence: 1,
              evidence: { source: lab.url },
            },
            idempotencyKey: `lab:${lab.org}:${entry.arxivId}:published_by`,
          });
        }
        seenByOrg[lab.org] = [...seen].slice(-500);
        seenTitlesByOrg[lab.org] = [...seenTitles].slice(-500);
      }
      await ctx.setState({ seen: seenByOrg, seenTitles: seenTitlesByOrg });
      return events;
    },
  };
}

export const labPublicationsReactor: Reactor = makeLabPublicationsReactor(
  anthropicLabLister,
  fetchArxivByIds,
  resolveArxivByTitle,
);
