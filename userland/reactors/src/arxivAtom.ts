import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

export interface ArxivEntry {
  readonly arxivId: string;
  readonly arxivVersion: number;
  readonly title: string;
  readonly abstract: string;
  readonly authors: readonly string[];
  readonly categories: readonly string[];
  readonly publishedAt: string;
  readonly updatedAt: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const idPattern = /\/abs\/(.+)v(\d+)$/;

const rawEntry = z.object({
  id: z.string(),
  title: z.union([z.string(), z.number()]).transform(String),
  summary: z.union([z.string(), z.number()]).transform(String),
  published: z.string(),
  updated: z.string(),
  author: z.unknown(),
  category: z.unknown(),
});

export function parseArxivAtom(xml: string): { total: number; entries: ArxivEntry[] } {
  const doc = parser.parse(xml);
  const feed = doc["feed"];
  if (feed === undefined) {
    throw new Error("arxiv response is not an Atom feed");
  }
  const total = Number(feed["opensearch:totalResults"]?.["#text"] ?? feed["opensearch:totalResults"]);
  if (!Number.isFinite(total)) {
    throw new Error("arxiv feed is missing opensearch:totalResults");
  }
  const entries = asArray(feed["entry"]).map((raw): ArxivEntry => {
    const entry = rawEntry.parse(raw);
    const match = idPattern.exec(entry.id);
    if (match === null) {
      throw new Error(`unparseable arxiv entry id: ${entry.id}`);
    }
    return {
      arxivId: match[1]!,
      arxivVersion: Number(match[2]),
      title: normalizeWhitespace(entry.title),
      abstract: normalizeWhitespace(entry.summary),
      authors: asArray(entry.author as { name: string } | { name: string }[]).map(
        (a) => String(a.name),
      ),
      categories: asArray(entry.category as { "@_term": string } | { "@_term": string }[]).map(
        (c) => c["@_term"],
      ),
      publishedAt: entry.published,
      updatedAt: entry.updated,
    };
  });
  return { total, entries };
}
