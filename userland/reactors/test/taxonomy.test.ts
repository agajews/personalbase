import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { coreRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpFolds, runReactor } from "@nc/process";
import { graphFold, libraryFold, marksFold, papersFold, taxonomyFold } from "@nc/folds";
import { makeTaxonomyReactor, type AssignFn, type SchemeFn } from "@nc/reactors";

const folds = [papersFold, graphFold, libraryFold, marksFold, taxonomyFold];

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

let schemeCalls = 0;
const fakeScheme: SchemeFn = async () => {
  schemeCalls += 1;
  return {
    categories: [
      { slug: "diffusion", name: "Diffusion", description: "Diffusion models." },
      { slug: "ssm", name: "State space models", description: "Subquadratic sequence models." },
    ],
    usage: { tokensIn: 10, tokensOut: 10 },
  };
};
const assigned: string[] = [];
const fakeAssign: AssignFn = async (_categories, items) => {
  items.forEach((i) => assigned.push(i.title));
  return {
    assignments: items.map((i) => ({
      index: i.index,
      slug: i.title.toLowerCase().includes("diffusion") ? "diffusion" : "ssm",
      confidence: 0.9,
    })),
    usage: { tokensIn: 5, tokensOut: 5 },
  };
};
const reactor = makeTaxonomyReactor(fakeScheme, fakeAssign);

describe("taxonomy reactor", () => {
  test("proposes a scheme and classifies saved items into topic links", async () => {
    await appendEvents(sql, coreRegistry, [
      paperEvent("2608.00001", "Diffusion for images"),
      paperEvent("2608.00002", "Mamba variants"),
      paperEvent("2608.00003", "Unsaved paper"), // not marked: not classified
      saveEvent("2608.00001", "s1"),
      saveEvent("2608.00002", "s2"),
    ]);
    await catchUpFolds(sql, coreRegistry, folds);

    const first = await runReactor(sql, coreRegistry, reactor, { kind: "job", payload: {} });
    expect(schemeCalls).toBe(1);
    expect(first.emitted).toBe(3); // 1 scheme + 2 assignments
    await catchUpFolds(sql, coreRegistry, folds);

    const groups = await sql`select slug from taxonomy_categories order by position`;
    expect(groups.map((g) => g["slug"])).toEqual(["diffusion", "ssm"]);
    const links = await sql`
      select e.display_name from links l
      join entities t on t.entity_id = l.to_id and t.kind = 'topic'
      join entities e on e.entity_id = l.from_id
      where l.link_type = 'classified_as' and t.ref = 'taxonomy:diffusion'`;
    expect(links.map((l) => l["display_name"])).toEqual(["Diffusion for images"]);
  });

  test("rerun classifies only newly saved items under the same scheme", async () => {
    await appendEvents(sql, coreRegistry, [saveEvent("2608.00003", "s3")]);
    await catchUpFolds(sql, coreRegistry, folds);
    assigned.length = 0;

    const second = await runReactor(sql, coreRegistry, reactor, { kind: "job", payload: {} });
    expect(schemeCalls).toBe(1); // scheme reused
    expect(second.emitted).toBe(1); // only the new item
    expect(assigned).toEqual(["Unsaved paper"]);
  });

  test("regenerate re-derives the scheme and reassigns everything", async () => {
    const third = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { regenerate: true },
    });
    expect(schemeCalls).toBe(2);
    // Same fake scheme content → same schemeId → every emission (1 scheme +
    // 3 assignments) dedupes against earlier runs via idempotency keys.
    expect(third.emitted).toBe(4);
    expect(third.appended).toBe(0);
  });
});
