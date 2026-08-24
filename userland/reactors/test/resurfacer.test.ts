import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { coreRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpFolds, runReactor } from "@nc/process";
import { graphFold, libraryFold, marksFold, papersFold, resurfacedFold } from "@nc/folds";
import { resurfacerReactor } from "@nc/reactors";

const folds = [papersFold, graphFold, libraryFold, marksFold, resurfacedFold];

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

describe("resurfacer", () => {
  test("records the day's sample as a fact; reruns dedupe; fold keeps history", async () => {
    // Three saved papers.
    const events = [1, 2, 3].flatMap((n) => [
      {
        type: "arxiv.paper.ingested",
        schemaVersion: 1,
        source: "test",
        occurredAt: "2026-08-20T00:00:00.000Z",
        payload: {
          arxivId: `2608.0000${n}`, arxivVersion: 1, title: `Paper ${n}`, abstract: "a",
          authors: ["A"], categories: ["cs.LG"],
          publishedAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
        },
        idempotencyKey: `arxiv:2608.0000${n}v1`,
      },
      {
        type: "user.paper.marked",
        schemaVersion: 2,
        source: "ui:web",
        occurredAt: "2026-08-21T00:00:00.000Z",
        payload: { target: { kind: "paper", ref: `arxiv:2608.0000${n}` }, mark: "saved" },
        idempotencyKey: `save-${n}`,
      },
    ]);
    await appendEvents(sql, coreRegistry, events);
    await catchUpFolds(sql, coreRegistry, folds);

    const first = await runReactor(sql, coreRegistry, resurfacerReactor, {
      kind: "job",
      payload: { day: "2026-08-24", count: 2 },
    });
    expect(first.emitted).toBe(1);
    expect(first.appended).toBe(1);

    // Same day rerun: identical deterministic sample, deduped by the daily key.
    const again = await runReactor(sql, coreRegistry, resurfacerReactor, {
      kind: "job",
      payload: { day: "2026-08-24", count: 2 },
    });
    expect(again.appended).toBe(0);

    // A different day records separately: history accumulates.
    await runReactor(sql, coreRegistry, resurfacerReactor, {
      kind: "job",
      payload: { day: "2026-08-25", count: 2 },
    });
    await catchUpFolds(sql, coreRegistry, folds);
    const rows = await sql`
      select day, count(*)::int as n from resurfaced_items group by day order by day`;
    expect(rows.map((r) => [new Date(r["day"]).toISOString().slice(0, 10), r["n"]])).toEqual([
      ["2026-08-24", 2],
      ["2026-08-25", 2],
    ]);
  });
});
