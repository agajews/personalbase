import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { coreRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpFolds, runReactor } from "@nc/process";
import { graphFold, libraryFold, marksFold, papersFold, tagsFold } from "@nc/folds";
import { makeTaggerReactor, type TagFn, type VocabFn } from "@nc/reactors";

const folds = [papersFold, graphFold, libraryFold, marksFold, tagsFold];

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

function paperEvent(arxivId: string, title: string) {
  return {
    type: "arxiv.paper.ingested",
    schemaVersion: 1,
    source: "test",
    occurredAt: "2026-08-20T00:00:00.000Z",
    payload: {
      arxivId, arxivVersion: 1, title, abstract: `About ${title}.`,
      authors: ["A. Author"], categories: ["cs.LG"],
      publishedAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
    },
    idempotencyKey: `arxiv:${arxivId}v1`,
  };
}

function saveEvent(arxivId: string, key: string) {
  return {
    type: "user.paper.marked",
    schemaVersion: 2,
    source: "ui:web",
    occurredAt: "2026-08-20T01:00:00.000Z",
    payload: { target: { kind: "paper", ref: `arxiv:${arxivId}` }, mark: "saved" },
    idempotencyKey: key,
  };
}

let vocabCalls = 0;
const fakeVocab: VocabFn = async () => {
  vocabCalls += 1;
  return {
    tags: [
      { slug: "ddpm", name: "DDPM", description: "Denoising diffusion.", facet: "method" },
      { slug: "samplers", name: "Samplers", description: "Sampling schedules.", facet: "method" },
      { slug: "mamba", name: "Mamba", description: "Selective state spaces.", facet: "architecture" },
    ],
    usage: { tokensIn: 10, tokensOut: 10 },
  };
};

const seen: string[] = [];
const fakeTag: TagFn = async (_vocab, items) => {
  items.forEach((i) => seen.push(i.title));
  return {
    tagged: items.map((i) => ({
      index: i.index,
      slugs: i.title.toLowerCase().includes("diffusion")
        ? ["ddpm", "samplers", "not-in-vocab"]
        : ["mamba"],
    })),
    usage: { tokensIn: 5, tokensOut: 5 },
  };
};

const reactor = makeTaggerReactor(fakeVocab, fakeTag);

describe("tagger reactor", () => {
  test("proposes a vocabulary and hangs several tags on each saved item", async () => {
    await appendEvents(sql, coreRegistry, [
      paperEvent("2608.00001", "Diffusion for images"),
      paperEvent("2608.00002", "Mamba variants"),
      paperEvent("2608.00003", "Unsaved paper"), // not marked: not tagged
      saveEvent("2608.00001", "s1"),
      saveEvent("2608.00002", "s2"),
    ]);
    await catchUpFolds(sql, coreRegistry, folds);

    const first = await runReactor(sql, coreRegistry, reactor, { kind: "job", payload: {} });
    expect(vocabCalls).toBe(1);
    expect(first.emitted).toBe(3); // 1 vocabulary + 2 taggings
    await catchUpFolds(sql, coreRegistry, folds);

    const vocab = await sql`select slug, facet from tag_vocab order by position`;
    expect(vocab.map((v) => v["slug"])).toEqual(["ddpm", "samplers", "mamba"]);

    // A slug outside the vocabulary is dropped by the fold's join.
    const tagged = await sql`
      select e.display_name, it.slug, it.confidence from item_tags it
      join entities e on e.entity_id = it.entity_id
      order by e.display_name, it.confidence desc`;
    expect(tagged.map((t) => [t["display_name"], t["slug"]])).toEqual([
      ["Diffusion for images", "ddpm"],
      ["Diffusion for images", "samplers"],
      ["Mamba variants", "mamba"],
    ]);
    // Confidence decays with the order the model listed the slugs in.
    expect(Number(tagged[0]!["confidence"])).toBeCloseTo(1);
    expect(Number(tagged[1]!["confidence"])).toBeCloseTo(0.75);
  });

  test("rerun tags only newly saved items under the same vocabulary", async () => {
    await appendEvents(sql, coreRegistry, [saveEvent("2608.00003", "s3")]);
    await catchUpFolds(sql, coreRegistry, folds);
    seen.length = 0;

    const second = await runReactor(sql, coreRegistry, reactor, { kind: "job", payload: {} });
    expect(vocabCalls).toBe(1); // vocabulary reused
    expect(second.emitted).toBe(1);
    expect(seen).toEqual(["Unsaved paper"]);
  });

  test("regenerate re-derives the vocabulary and re-tags everything", async () => {
    const third = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { regenerate: true },
    });
    expect(vocabCalls).toBe(2);
    // The fake vocabulary is unchanged, so its id — and every emission's
    // idempotency key — matches the first run and nothing new is appended.
    expect(third.emitted).toBe(4);
    expect(third.appended).toBe(0);
  });

  test("a new vocabulary replaces the old one and takes its assignments with it", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "agent.tagvocab.proposed",
        schemaVersion: 1,
        source: "test",
        occurredAt: "2026-08-21T00:00:00.000Z",
        payload: {
          vocabId: "v2",
          tags: [{ slug: "flows", name: "Flows", description: "Flow matching.", facet: "method" }],
        },
        idempotencyKey: "tags:vocab:v2",
      },
    ]);
    await catchUpFolds(sql, coreRegistry, folds);

    const vocab = await sql`select slug from tag_vocab`;
    expect(vocab.map((v) => v["slug"])).toEqual(["flows"]);
    const remaining = await sql`select count(*)::int as n from item_tags`;
    expect(remaining[0]!["n"]).toBe(0);
  });
});
