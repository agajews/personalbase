import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Reactor, ReactorEvent, ReactorInput } from "@nc/process";
import { parseArxivAtom, type ArxivEntry } from "./arxivAtom.js";

export const arxivJobPayload = z.object({
  /** Explicit arXiv ids to ingest; when present, the date range is ignored. */
  ids: z.array(z.string().min(1)).optional(),
  /** Defaults to a trailing window ending now (arXiv indexing lags 1-2 days). */
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** arXiv categories, e.g. ["cs.LG", "cs.CL"]. Omit to ingest all of arXiv. */
  categories: z.array(z.string()).optional(),
});
export type ArxivJobPayload = z.infer<typeof arxivJobPayload>;

/** What the daily cron sweep covers. */
export const dailyCategories = ["cs.LG", "cs.CL", "cs.AI"];
const defaultWindowDays = 3;

const pageSize = 200;
const pageDelayMs = 3000; // arXiv API etiquette
const apiUrl = "https://export.arxiv.org/api/query";

function submittedDateRange(fromIso: string, toIso: string): string {
  const stamp = (iso: string): string =>
    new Date(iso).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `submittedDate:[${stamp(fromIso)} TO ${stamp(toIso)}]`;
}

function searchQuery(payload: ArxivJobPayload): string {
  const to = payload.to ?? new Date().toISOString();
  const from =
    payload.from ??
    new Date(new Date(to).getTime() - defaultWindowDays * 86_400_000).toISOString();
  const range = submittedDateRange(from, to);
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

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Resolves a paper title to its arXiv entry via title search, accepting only
 * an exact normalized-title match. Returns null when the paper is not on
 * arXiv (or its lab-page title differs from the arXiv title).
 */
export async function resolveArxivByTitle(title: string): Promise<ArxivEntry | null> {
  const url = new URL(apiUrl);
  url.searchParams.set("search_query", `ti:"${title.replace(/"/g, "")}"`);
  url.searchParams.set("max_results", "5");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`arxiv API returned ${response.status} for title search`);
  }
  const { entries } = parseArxivAtom(await response.text());
  const wanted = normalizeTitle(title);
  return entries.find((e) => normalizeTitle(e.title) === wanted) ?? null;
}

/** Fetches canonical metadata for specific papers via the id_list API. */
export async function fetchArxivByIds(ids: readonly string[]): Promise<ArxivEntry[]> {
  const entries: ArxivEntry[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const url = new URL(apiUrl);
    url.searchParams.set("id_list", ids.slice(i, i + 50).join(","));
    url.searchParams.set("max_results", "50");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`arxiv API returned ${response.status} for id_list`);
    }
    entries.push(...parseArxivAtom(await response.text()).entries);
    if (i + 50 < ids.length) {
      await sleep(pageDelayMs);
    }
  }
  return entries;
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
  // Daily sweep with a trailing window; idempotency makes the overlap free.
  trigger: { kind: "cron", intervalHours: 24, payload: { categories: dailyCategories } },
  async run(_ctx, input: ReactorInput): Promise<ReactorEvent[]> {
    if (input.kind !== "job") {
      throw new Error("arxiv reactor only supports job triggers");
    }
    const payload = arxivJobPayload.parse(input.payload);
    if (payload.ids !== undefined && payload.ids.length > 0) {
      const entries = await fetchArxivByIds(payload.ids);
      const found = new Set(entries.map((e) => e.arxivId));
      const unresolved = payload.ids.filter((id) => !found.has(id.replace(/v\d+$/, "")));
      if (unresolved.length > 0) {
        console.log(`arxiv: ${unresolved.length} ids not returned: ${unresolved.join(", ")}`);
      }
      return entries.map(entryToEvent);
    }
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
