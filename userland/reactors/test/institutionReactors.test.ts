import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { coreRegistry } from "@nc/schema";
import { appendEvents, readEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpEventReactors, runReactor } from "@nc/process";
import {
  labs,
  makeAffiliationsReactor,
  makeLabPublicationsReactor,
  type AffiliationExtractor,
  type LabLister,
} from "@nc/reactors";
import type { ArxivEntry } from "@nc/reactors";

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

describe("affiliations reactor (event-triggered)", () => {
  const extracted: string[] = [];
  const fakeExtractor: AffiliationExtractor = async (input) => {
    extracted.push(input.arxivId);
    return {
      authors: [
        { name: "Ada Lovelace", affiliations: [{ raw: "Anthropic", org: "anthropic" }], email: "ada@anthropic.com" },
      ],
      usage: { tokensIn: 5, tokensOut: 5 },
    };
  };
  const fakeFetchText = async (arxivId: string): Promise<string | null> =>
    arxivId === "2608.00002" ? null : "Title Author Anthropic ada@anthropic.com";
  const reactor = makeAffiliationsReactor(fakeExtractor, fakeFetchText);

  test("processes ingested papers via checkpoints and skips html-less ones", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "arxiv.paper.ingested",
        schemaVersion: 1,
        source: "test",
        occurredAt: "2026-08-20T00:00:00.000Z",
        payload: {
          arxivId: "2608.00001", arxivVersion: 1, title: "P1", abstract: "a",
          authors: ["Ada Lovelace"], categories: ["cs.LG"],
          publishedAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
        },
        idempotencyKey: "arxiv:2608.00001v1",
      },
      {
        type: "arxiv.paper.ingested",
        schemaVersion: 1,
        source: "test",
        occurredAt: "2026-08-20T00:00:00.000Z",
        payload: {
          arxivId: "2608.00002", arxivVersion: 1, title: "P2 (no html)", abstract: "b",
          authors: ["Alan Turing"], categories: ["cs.LG"],
          publishedAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
        },
        idempotencyKey: "arxiv:2608.00002v1",
      },
    ]);
    await catchUpEventReactors(sql, coreRegistry, [reactor]);
    expect(extracted).toEqual(["2608.00001"]);

    const events = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["agent.paper.affiliations_extracted"],
      limit: 10,
    });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { arxivId: string }).arxivId).toBe("2608.00001");

    // Catching up again processes nothing new.
    await catchUpEventReactors(sql, coreRegistry, [reactor]);
    expect(extracted).toEqual(["2608.00001"]);
  });
});

describe("lab-publications reactor", () => {
  const listed: string[] = [];
  const resolved: string[] = [];
  const fakeLister: LabLister = async (lab) => {
    listed.push(lab.org);
    return {
      items:
        lab.org === "anthropic"
          ? [
              { title: "New SSM Paper", arxivId: "2608.10001" },
              { title: "Title Only Paper", arxivId: null },   // resolvable by title
              { title: "Blog-only thing", arxivId: null },    // not on arxiv
            ]
          : [],
      usage: { tokensIn: 3, tokensOut: 3 },
    };
  };
  const makeEntry = (id: string, title: string): ArxivEntry => ({
    arxivId: id,
    arxivVersion: 1,
    title,
    abstract: "abs",
    authors: ["Ada Lovelace"],
    categories: ["cs.LG"],
    publishedAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const fakeFetchByIds = async (ids: readonly string[]): Promise<ArxivEntry[]> =>
    ids.map((id) => makeEntry(id, "New SSM Paper"));
  const fakeResolve = async (title: string): Promise<ArxivEntry | null> => {
    resolved.push(title);
    return title === "Title Only Paper" ? makeEntry("2608.10002", title) : null;
  };
  const reactor = makeLabPublicationsReactor(fakeLister, fakeFetchByIds, fakeResolve);

  test("ingests arxiv-linked items with published_by links; reruns skip seen ids", async () => {
    const first = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { lab: "anthropic" },
    });
    expect(first.emitted).toBe(4); // 2 papers (1 explicit id, 1 title-resolved) x (paper + link)
    expect(first.appended).toBe(4);
    expect(resolved).toEqual(["Title Only Paper", "Blog-only thing"]);

    const links = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["agent.link.asserted"],
      limit: 10,
    });
    expect(links).toHaveLength(2);
    const payload = links[0]!.payload as { to: { ref: string }; linkType: string };
    expect(payload.to.ref).toBe("anthropic");
    expect(payload.linkType).toBe("published_by");

    // Second run: ids and titles are in reactor state — nothing fetched,
    // nothing re-resolved, nothing emitted.
    const second = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { lab: "anthropic" },
    });
    expect(second.emitted).toBe(0);
    expect(resolved).toEqual(["Title Only Paper", "Blog-only thing"]);
  });

  test("all four labs are configured", () => {
    expect(labs.map((l) => l.org).sort()).toEqual(["anthropic", "deepmind", "meta", "openai"]);
  });
});
