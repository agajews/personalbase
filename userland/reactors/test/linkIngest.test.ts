import { describe, expect, test } from "vitest";
import { extractMetadata, makeLinkIngestReactor, type PageMetadata } from "@nc/reactors";
import { entityId, normalizeSubmittedUrl, submittedLinkEntity } from "@nc/folds";
import type { ReactorCtx, ReactorEvent } from "@nc/process";
import type { StoredEvent } from "@nc/log";

const ctx = {
  sql: null as never,
  getState: async () => null,
  setState: async () => undefined,
  recordUsage: () => undefined,
} satisfies ReactorCtx;

function submitted(url: string, mark = "want_to_read"): StoredEvent {
  return {
    seq: 1n,
    eventUid: "11111111-1111-4111-8111-111111111111",
    type: "user.link.submitted",
    schemaVersion: 1,
    source: "ui:web",
    occurredAt: new Date("2026-08-27T12:00:00Z"),
    recordedAt: new Date("2026-08-27T12:00:00Z"),
    payload: { url, mark },
    causedByUid: null,
    correctsUid: null,
  };
}

function run(url: string, page: PageMetadata): Promise<readonly ReactorEvent[]> {
  const reactor = makeLinkIngestReactor(async () => page);
  return reactor.run(ctx, { kind: "event", event: submitted(url) }) as Promise<
    readonly ReactorEvent[]
  >;
}

describe("normalizeSubmittedUrl", () => {
  test("tidies what a human pasted, and nothing more", () => {
    expect(normalizeSubmittedUrl("  https://metr.org/blog/x/  ")).toBe("https://metr.org/blog/x/");
    expect(normalizeSubmittedUrl("metr.org/blog/x")).toBe("https://metr.org/blog/x");
    // Query strings and fragments are part of the identity, not noise.
    expect(normalizeSubmittedUrl("https://a.dev/p?utm_source=x#top")).toBe(
      "https://a.dev/p?utm_source=x#top",
    );
  });

  test("rejects what isn't a link", () => {
    expect(normalizeSubmittedUrl("   ")).toBeNull();
    expect(normalizeSubmittedUrl("how do transformers work")).toBeNull();
    expect(normalizeSubmittedUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeSubmittedUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("extractMetadata", () => {
  test("prefers Open Graph, decodes entities, and reads the date", () => {
    const html = `<!doctype html><html><head>
      <meta charset="utf-8">
      <title>METR &#8212; fallback title</title>
      <meta property="og:title" content="OpenAI &amp; Hugging Face incident">
      <meta property='og:site_name' content='METR'>
      <meta name="description" content="An   investigation.">
      <meta property="article:published_time" content="2026-08-26T00:00:00Z">
      </head><body><h1>ignored</h1></body></html>`;
    expect(extractMetadata(html)).toEqual({
      title: "OpenAI & Hugging Face incident",
      siteName: "METR",
      description: "An investigation.",
      publishedAt: "2026-08-26T00:00:00.000Z",
    });
  });

  test("falls back to <title>, and to nothing at all", () => {
    expect(extractMetadata("<html><head><title>\n  A  Journey\n</title></head>")).toEqual({
      title: "A Journey",
    });
    expect(extractMetadata("<html><body>no head</body></html>")).toEqual({ title: null });
  });

  test("drops a date that doesn't parse", () => {
    const html = `<meta property="og:title" content="X">
      <meta property="article:published_time" content="sometime last spring">`;
    expect(extractMetadata(html)).toEqual({ title: "X" });
  });
});

describe("link-ingest reactor", () => {
  test("an ordinary page becomes web.page.ingested, keyed by its URL", async () => {
    const url = "https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/";
    const events = await run(url, { title: "Incident investigation", siteName: "METR" });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("web.page.ingested");
    expect(event.payload).toEqual({
      url,
      title: "Incident investigation",
      siteName: "METR",
    });
    expect(event.idempotencyKey).toBe(`web:${url}`);
    expect(event.causedByUid).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("a page with no title still lands, so the mark has an entity", async () => {
    const events = await run("https://example.com/paper.pdf", { title: null });
    expect((events[0]!.payload as { title: string | null }).title).toBeNull();
  });

  test("the entity a submission marks is the one ingestion names", () => {
    // The METR link Alex pasted: its mark and its page must converge.
    const url = "https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/";
    const target = submittedLinkEntity(url);
    expect(target).toEqual({ kind: "resource", ref: `url:${url}` });
    expect(entityId(target.kind, target.ref)).toBe("8d6b9262-e680-5d21-827e-3f285982afcf");
  });

  test("arXiv links reuse the arXiv path instead of minting a resource", () => {
    for (const url of [
      "https://arxiv.org/abs/2508.12345",
      "https://arxiv.org/abs/2508.12345v3",
      "http://www.arxiv.org/pdf/2508.12345.pdf",
      "https://arxiv.org/html/2508.12345v1",
    ]) {
      expect(submittedLinkEntity(url)).toEqual({ kind: "paper", ref: "arxiv:2508.12345" });
    }
    expect(submittedLinkEntity("https://arxiv.org/abs/hep-th/9901001")).toEqual({
      kind: "paper",
      ref: "arxiv:hep-th/9901001",
    });
    // Not a paper page — arxiv.org/list/cs.LG is a listing.
    expect(submittedLinkEntity("https://arxiv.org/list/cs.LG/recent").kind).toBe("resource");
  });
});
