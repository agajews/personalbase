import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Reactor, ReactorEvent, ReactorInput } from "@nc/process";
import { parseArxivAtom, type ArxivEntry } from "./arxivAtom.js";

export const arxivJobPayload = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  /** arXiv categories, e.g. ["cs.LG", "cs.CL"]. Omit to ingest all of arXiv. */
  categories: z.array(z.string()).optional(),
});
export type ArxivJobPayload = z.infer<typeof arxivJobPayload>;

const pageSize = 200;
const pageDelayMs = 3000; // arXiv API etiquette
const apiUrl = "https://export.arxiv.org/api/query";

function submittedDateRange(fromIso: string, toIso: string): string {
  const stamp = (iso: string): string =>
    new Date(iso).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `submittedDate:[${stamp(fromIso)} TO ${stamp(toIso)}]`;
}

function searchQuery(payload: ArxivJobPayload): string {
  const range = submittedDateRange(payload.from, payload.to);
  if (payload.categories === undefined || payload.categories.length === 0) {
    return range;
  }
  const cats = payload.categories.map((c) => `cat:${c}`).join(" OR ");
  return `(${cats}) AND ${range}`;
}

async function fetchPage(query: string, start: number): Promise<{ total: number; entries: ArxivEntry[] }> {
  const url = new URL(apiUrl);
  url.searchParams.set("search_query", query);
  url.searchParams.set("start", String(start));
  url.searchParams.set("max_results", String(pageSize));
  url.searchParams.set("sortBy", "submittedDate");
  url.searchParams.set("sortOrder", "ascending");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`arxiv API returned ${response.status} for ${url}`);
  }
  return parseArxivAtom(await response.text());
}

export function entryToEvent(entry: ArxivEntry): ReactorEvent {
  return {
    type: "arxiv.paper.ingested",
    schemaVersion: 1,
    occurredAt: entry.updatedAt,
    payload: {
      arxivId: entry.arxivId,
      arxivVersion: entry.arxivVersion,
      title: entry.title,
      abstract: entry.abstract,
      authors: entry.authors,
      categories: entry.categories,
      publishedAt: entry.publishedAt,
      updatedAt: entry.updatedAt,
    },
    idempotencyKey: `arxiv:${entry.arxivId}v${entry.arxivVersion}`,
  };
}

export const arxivReactor: Reactor = {
  kind: "reactor",
  name: "arxiv",
  trigger: { kind: "manual" },
  async run(_ctx, input: ReactorInput): Promise<ReactorEvent[]> {
    if (input.kind !== "job") {
      throw new Error("arxiv reactor only supports manual job triggers");
    }
    const payload = arxivJobPayload.parse(input.payload);
    const query = searchQuery(payload);
    const events: ReactorEvent[] = [];
    let start = 0;
    while (true) {
      const page = await fetchPage(query, start);
      events.push(...page.entries.map(entryToEvent));
      start += pageSize;
      // The API sometimes returns short pages; only totalResults is reliable.
      if (start >= page.total || page.entries.length === 0) {
        return events;
      }
      await sleep(pageDelayMs);
    }
  },
};
