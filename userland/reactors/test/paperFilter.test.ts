import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { coreRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpFolds, runReactor } from "@nc/process";
import { filterResultsFold, filtersFold, papersFold } from "@nc/folds";
import { makePaperFilterReactor, type JudgeFn, type PaperForJudging } from "@nc/reactors";

const folds = [papersFold, filtersFold, filterResultsFold];

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

function paperEvent(arxivId: string, title: string, updatedAt: string) {
  return {
    type: "arxiv.paper.ingested",
    schemaVersion: 1,
    source: "test",
    occurredAt: updatedAt,
    payload: {
      arxivId,
      arxivVersion: 1,
      title,
      abstract: `Abstract of ${title}.`,
      authors: ["A. Author"],
      categories: ["cs.LG"],
      publishedAt: updatedAt,
      updatedAt,
    },
    idempotencyKey: `arxiv:${arxivId}v1`,
  };
}

function filterEvent(prompt: string) {
  return {
    type: "user.filter.defined",
    schemaVersion: 1,
    source: "test",
    occurredAt: new Date().toISOString(),
    payload: { name: "ssm", prompt, model: "test-model" },
  };
}

/** Judges "match" iff the title contains the filter prompt as a substring. */
const judgedBatches: PaperForJudging[][] = [];
const substringJudge: JudgeFn = async (_model, filterPrompt, papers) => {
  judgedBatches.push([...papers]);
  return {
    judgments: papers.map((p) => ({
      arxivId: p.arxivId,
      verdict: p.title.includes(filterPrompt) ? ("match" as const) : ("reject" as const),
      confidence: 0.9,
      reason: "substring test judge",
    })),
    usage: { tokensIn: 10, tokensOut: 5 },
  };
};

const reactor = makePaperFilterReactor(substringJudge);
const range = { from: "2025-08-21T00:00:00.000Z", to: "2025-08-22T00:00:00.000Z" };

describe("paper-filter reactor", () => {
  test("judges papers in range against the current prompt", async () => {
    await appendEvents(sql, coreRegistry, [
      paperEvent("2508.00001", "State space models for audio", "2025-08-21T10:00:00.000Z"),
      paperEvent("2508.00002", "A survey of transformers", "2025-08-21T11:00:00.000Z"),
      paperEvent("2507.99999", "Out of range paper", "2025-07-01T00:00:00.000Z"),
      filterEvent("State space"),
    ]);
    await catchUpFolds(sql, coreRegistry, folds);

    const result = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { ...range, filter: "ssm" },
    });
    expect(result.emitted).toBe(2); // out-of-range paper is not judged
    await catchUpFolds(sql, coreRegistry, folds);

    const rows = await sql`
      select arxiv_id, verdict from filter_results order by arxiv_id`;
    expect(rows.map((r) => [r["arxiv_id"], r["verdict"]])).toEqual([
      ["2508.00001", "match"],
      ["2508.00002", "reject"],
    ]);
  });

  test("an ingested paper schedules one shared sweep job per burst", async () => {
    const event = {
      seq: 1n,
      eventUid: crypto.randomUUID(),
      type: "arxiv.paper.ingested",
      schemaVersion: 1,
      source: "test",
      occurredAt: new Date(),
      recordedAt: new Date(),
      payload: {},
      causedByUid: null,
      correctsUid: null,
    };
    await runReactor(sql, coreRegistry, reactor, { kind: "event", event });
    await runReactor(sql, coreRegistry, reactor, { kind: "event", event });
    const jobs = await sql`
      select job_id from jobs where process = 'reactor:paper-filter' and status = 'pending'`;
    expect(jobs).toHaveLength(1); // the second event deduped into the same sweep
    await sql`delete from jobs where process = 'reactor:paper-filter'`;
  });

  test("rerunning with an unchanged prompt judges nothing (no LLM spend)", async () => {
    const batchesBefore = judgedBatches.length;
    const result = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { ...range, filter: "ssm" },
    });
    expect(result.emitted).toBe(0);
    expect(judgedBatches.length).toBe(batchesBefore);
  });

  test("editing the prompt re-judges the range under the new prompt hash", async () => {
    await appendEvents(sql, coreRegistry, [filterEvent("survey")]);
    await catchUpFolds(sql, coreRegistry, folds);

    const result = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { ...range, filter: "ssm" },
    });
    expect(result.emitted).toBe(2);
    await catchUpFolds(sql, coreRegistry, folds);

    // Old verdicts remain attributed to the old hash; new hash flips them.
    const hashes = await sql`select distinct prompt_hash from filter_results`;
    expect(hashes).toHaveLength(2);
    const current = await sql`
      select r.arxiv_id, r.verdict
      from filter_results r
      join filters f on f.name = r.filter_name and f.prompt_hash = r.prompt_hash
      order by r.arxiv_id`;
    expect(current.map((r) => [r["arxiv_id"], r["verdict"]])).toEqual([
      ["2508.00001", "reject"],
      ["2508.00002", "match"],
    ]);
  });

  test("a default sweep judges by arrival, not submission date", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.filter.defined",
        schemaVersion: 1,
        source: "test",
        occurredAt: new Date().toISOString(),
        payload: { name: "arrivals", prompt: "State space", model: "test-model" },
      },
    ]);
    await catchUpFolds(sql, coreRegistry, folds);

    // No from/to: the sweep covers recent ingested_at. Every test paper was
    // ingested just now, including the one submitted back in July.
    const result = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { filter: "arrivals" },
    });
    expect(result.emitted).toBe(3);
  });

  test("naming a missing filter is an error", async () => {
    await expect(
      runReactor(sql, coreRegistry, reactor, {
        kind: "job",
        payload: { ...range, filter: "nope" },
      }),
    ).rejects.toThrow("no filter named nope");
  });
});
