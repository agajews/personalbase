import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { makeRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpFold, type Fold } from "@nc/process";

const registry = makeRegistry([
  { type: "test.count.incremented", versions: [{ schema: z.object({ by: z.number() }) }] },
]);

function makeCounterFold(version: number, multiplier: number): Fold {
  return {
    kind: "fold",
    name: "counter",
    version,
    consumes: ["test.count.incremented"],
    tables: ["counter_total"],
    async init(tx) {
      await tx`create table counter_total (id int primary key, total int not null)`;
      await tx`insert into counter_total values (1, 0)`;
    },
    async apply(tx, event) {
      const { by } = z.object({ by: z.number() }).parse(event.payload);
      await tx`update counter_total set total = total + ${by * multiplier} where id = 1`;
    },
  };
}

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

async function total(): Promise<number> {
  const rows = await sql`select total from counter_total where id = 1`;
  return rows[0]!["total"];
}

async function increment(by: number, key: string): Promise<void> {
  await appendEvents(sql, registry, [
    {
      type: "test.count.incremented",
      schemaVersion: 1,
      source: "test",
      occurredAt: new Date().toISOString(),
      payload: { by },
      idempotencyKey: key,
    },
  ]);
}

describe("fold runner", () => {
  test("applies incrementally and advances the checkpoint", async () => {
    const fold = makeCounterFold(1, 1);
    await increment(2, "a");
    await increment(3, "b");
    expect(await catchUpFold(sql, registry, fold)).toBe(2);
    expect(await total()).toBe(5);

    // Catching up again applies nothing.
    expect(await catchUpFold(sql, registry, fold)).toBe(0);
    expect(await total()).toBe(5);

    await increment(10, "c");
    expect(await catchUpFold(sql, registry, fold)).toBe(1);
    expect(await total()).toBe(15);
  });

  test("version bump truncates and replays from seq 0", async () => {
    const foldV2 = makeCounterFold(2, 100);
    await catchUpFold(sql, registry, foldV2);
    expect(await total()).toBe(1500); // (2+3+10) * 100, rebuilt from scratch
  });
});
