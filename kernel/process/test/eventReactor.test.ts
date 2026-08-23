import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { makeRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpEventReactors, type Reactor } from "@nc/process";

const registry = makeRegistry([
  { type: "test.thing.happened", versions: [{ schema: z.object({ n: z.number() }) }] },
]);

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

const processed: number[] = [];
const reactor: Reactor = {
  kind: "reactor",
  name: "fragile",
  trigger: { kind: "event", consumes: ["test.thing.happened"] },
  run: async (_ctx, input) => {
    if (input.kind !== "event") {
      throw new Error("unexpected input");
    }
    const { n } = z.object({ n: z.number() }).parse(input.event.payload);
    if (n === 2) {
      throw new Error("poison event");
    }
    processed.push(n);
    return [];
  },
};

describe("event-triggered reactor failure handling", () => {
  test("a poison event is retried a bounded number of times, then skipped", async () => {
    await appendEvents(
      sql,
      registry,
      [1, 2, 3].map((n) => ({
        type: "test.thing.happened",
        schemaVersion: 1,
        source: "test",
        occurredAt: new Date().toISOString(),
        payload: { n },
        idempotencyKey: `t${n}`,
      })),
    );

    // Never throws out of the catch-up, even while the poison event fails.
    await catchUpEventReactors(sql, registry, [reactor]); // attempt 1 → retry
    expect(processed).toEqual([1]);
    await catchUpEventReactors(sql, registry, [reactor]); // attempt 2 → retry
    await catchUpEventReactors(sql, registry, [reactor]); // attempt 3 → skip
    // Next pass moves on to the event after the poison one.
    await catchUpEventReactors(sql, registry, [reactor]);
    expect(processed).toEqual([1, 3]);

    const failed = await sql`
      select count(*)::int as n from runs
      where process = 'reactor:fragile' and status = 'failed'`;
    expect(failed[0]!["n"]).toBe(3);
  });
});
