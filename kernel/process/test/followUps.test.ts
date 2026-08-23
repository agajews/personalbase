import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import type { Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { makeRegistry, type SchemaRegistry } from "@nc/schema";
import {
  claimJob,
  enqueueJob,
  runReactor,
  type Reactor,
  type ReactorResult,
} from "@nc/process";

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

const registry: SchemaRegistry = makeRegistry([
  { type: "test.thing.happened", versions: [{ schema: z.object({ n: z.number() }) }] },
]);

describe("enqueueJob dedupe and delay", () => {
  test("dedupe_key drops duplicate enqueues", async () => {
    const first = await enqueueJob(sql, "reactor:x", { a: 1 }, { dedupeKey: "chain:1" });
    expect(first).not.toBeNull();
    const second = await enqueueJob(sql, "reactor:x", { a: 2 }, { dedupeKey: "chain:1" });
    expect(second).toBeNull();
    const rows = await sql`select count(*)::int as n from jobs where dedupe_key = 'chain:1'`;
    expect(rows[0]!["n"]).toBe(1);
  });

  test("runAfterSeconds delays the job past claimJob's due filter", async () => {
    await sql`delete from jobs`;
    await enqueueJob(sql, "reactor:x", {}, { runAfterSeconds: 3600 });
    expect(await claimJob(sql)).toBeNull();
    await sql`update jobs set run_after = now()`;
    expect(await claimJob(sql)).not.toBeNull();
  });
});

describe("reactor followUps", () => {
  test("followUps enqueue after events append; retried run cannot fork the chain", async () => {
    await sql`delete from jobs`;
    const chained: Reactor = {
      kind: "reactor",
      name: "chained",
      trigger: { kind: "manual" },
      async run(): Promise<ReactorResult> {
        return {
          events: [
            {
              type: "test.thing.happened",
              schemaVersion: 1,
              occurredAt: new Date().toISOString(),
              payload: { n: 1 },
              idempotencyKey: "thing:1",
            },
          ],
          followUps: [
            {
              process: "reactor:chained",
              payload: { step: 2 },
              runAfterSeconds: 0,
              dedupeKey: "chained:step:2",
            },
          ],
        };
      },
    };

    const first = await runReactor(sql, registry, chained, { kind: "job", payload: {} });
    expect(first.emitted).toBe(1);
    expect(first.appended).toBe(1);

    // A retry of the same logical step: event deduped, follow-up deduped.
    const retry = await runReactor(sql, registry, chained, { kind: "job", payload: {} });
    expect(retry.appended).toBe(0);
    const jobs = await sql`
      select count(*)::int as n from jobs where dedupe_key = 'chained:step:2'`;
    expect(jobs[0]!["n"]).toBe(1);
  });

  test("plain event-array returns still work", async () => {
    const plain: Reactor = {
      kind: "reactor",
      name: "plain",
      trigger: { kind: "manual" },
      run: async () => [
        {
          type: "test.thing.happened",
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          payload: { n: 2 },
        },
      ],
    };
    const result = await runReactor(sql, registry, plain, { kind: "job", payload: {} });
    expect(result.emitted).toBe(1);
    expect(result.appended).toBe(1);
  });
});
