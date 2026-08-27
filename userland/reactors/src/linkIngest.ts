import { userLinkSubmittedV1 } from "@nc/schema";
import { arxivIdFromUrl } from "@nc/folds";
import type { Reactor, ReactorEvent } from "@nc/process";
import { entryToEvent, fetchArxivByIds } from "./arxiv.js";

// A link the user pasted becomes a named thing in the graph. arXiv links go
// down the arXiv path we already have — same API, same events, same entity —
// so pasting one converges with the daily sweep instead of minting a
// look-alike resource. Everything else is one HTTP GET and the page's own
// metadata; a title is what a link needs to be readable in a list, and no
// LLM is required to read a <title> tag.

export interface PageMetadata {
  readonly title: string | null;
  readonly siteName?: string;
  readonly description?: string;
  readonly publishedAt?: string;
}

export type PageFetcher = (url: string) => Promise<PageMetadata>;

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") || body.startsWith("#X")
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return entities[body.toLowerCase()] ?? whole;
  });
}

function clean(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const text = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    "i",
  ).exec(tag);
  return match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
}

/**
 * What the page says about itself: Open Graph first (it is what the author
 * wrote for other readers), then the plain <title>. Regexes rather than a DOM
 * — the head of a document is shallow, and this keeps the reactor dependency-
 * free and unit-testable.
 */
export function extractMetadata(html: string): PageMetadata {
  const meta = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = attribute(tag, "property") ?? attribute(tag, "name");
    const content = clean(attribute(tag, "content"));
    if (key !== undefined && content !== undefined && !meta.has(key.toLowerCase())) {
      meta.set(key.toLowerCase(), content);
    }
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title =
    meta.get("og:title") ?? meta.get("twitter:title") ?? clean(titleTag?.[1]) ?? null;
  const siteName = meta.get("og:site_name");
  const description = meta.get("og:description") ?? meta.get("description");
  const published = meta.get("article:published_time") ?? meta.get("citation_publication_date");
  const publishedAt = published === undefined ? undefined : parseDate(published);
  return {
    title,
    ...(siteName === undefined ? {} : { siteName }),
    ...(description === undefined ? {} : { description }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
  };
}

/** Pages date themselves every which way; keep only what parses. */
function parseDate(raw: string): string | undefined {
  const at = new Date(raw.replace(/\//g, "-"));
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

// Enough of the document to hold its <head>; whole pages are megabytes of
// body we have no use for.
const maxHtmlBytes = 400_000;
const userAgent = "personalbase-link-ingest/1.0 (+personal reading list)";

export const fetchPageMetadata: PageFetcher = async (url) => {
  const response = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`fetching ${url} returned ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/html|xml/i.test(contentType)) {
    // A PDF or an image has no title to read; the URL stays its name.
    return { title: null };
  }
  return extractMetadata((await response.text()).slice(0, maxHtmlBytes));
};

export function makeLinkIngestReactor(fetchPage: PageFetcher): Reactor {
  return {
    kind: "reactor",
    name: "link-ingest",
    trigger: { kind: "event", consumes: ["user.link.submitted"] },
    async run(_ctx, input): Promise<ReactorEvent[]> {
      if (input.kind !== "event") {
        throw new Error("link-ingest reactor is event-triggered only");
      }
      const link = userLinkSubmittedV1.parse(input.event.payload);
      const arxivId = arxivIdFromUrl(link.url);
      if (arxivId !== null) {
        const entries = await fetchArxivByIds([arxivId]);
        if (entries.length === 0) {
          console.log(`link-ingest: arxiv has no ${arxivId} (${link.url})`);
          return [];
        }
        // Deliberately the same event arXiv ingestion emits, down to its
        // idempotency key: a paper already in the log is simply not appended.
        return entries.map((entry) => ({
          ...entryToEvent(entry),
          causedByUid: input.event.eventUid,
        }));
      }
      const page = await fetchPage(link.url);
      return [
        {
          type: "web.page.ingested",
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          payload: { url: link.url, ...page },
          // One fetch per URL, however many times it is pasted.
          idempotencyKey: `web:${link.url}`,
          causedByUid: input.event.eventUid,
        },
      ];
    },
  };
}

export const linkIngestReactor: Reactor = makeLinkIngestReactor(fetchPageMetadata);
