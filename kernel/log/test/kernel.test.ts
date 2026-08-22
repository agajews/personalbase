import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { makeRegistry, upcastToLatest } from "@nc/schema";
import { appendEvents, readEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";

const registry = makeRegistry([
  {
    type: "test.thing.happened",
    versions: [
      { schema: z.object({ value: z.number() }) },
      {
        schema: z.object({ value: z.number(), label: z.string() }),
        upcast: (prev) => ({ ...(prev as { value: number }), label: "unlabeled" }),
      },
    ],
  },
  { type: "test.other.happened", versions: [{ schema: z.object({}) }] },
]);

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

describe("append + read", () => {
  test("appends validate, assign contiguous seqs, and dedupe on idempotency key", async () => {
    const base = {
      schemaVersion: 2,
      source: "test",
      occurredAt: new Date().toISOString(),
    };
    const first = await appendEvents(sql, registry, [
      { ...base, type: "test.thing.happened", payload: { value: 1, label: "a" }, idempotencyKey: "k1" },
      { ...base, type: "test.thing.happened", payload: { value: 2, label: "b" }, idempotencyKey: "k2" },
    ]);
    expect(first).toBe(2);

    const duplicate = await appendEvents(sql, registry, [
      { ...base, type: "test.thing.happened", payload: { value: 1, label: "a" }, idempotencyKey: "k1" },
    ]);
    expect(duplicate).toBe(0);

    const events = await readEvents(sql, registry, { afterSeq: 0n, limit: 10 });
    expect(events.map((e) => e.payload)).toEqual([
      { value: 1, label: "a" },
      { value: 2, label: "b" },
    ]);
    expect(events[1]!.seq - events[0]!.seq).toBe(1n);
  });

  test("rejects payloads that do not match the schema", async () => {
    await expect(
      appendEvents(sql, registry, [
        {
          type: "test.thing.happened",
          schemaVersion: 2,
          source: "test",
          occurredAt: new Date().toISOString(),
          payload: { wrong: true },
        },
      ]),
    ).rejects.toThrow();
  });

  test("old-version payloads are upcast on read", async () => {
    await appendEvents(sql, registry, [
      {
        type: "test.thing.happened",
        schemaVersion: 1,
        source: "test",
        occurredAt: new Date().toISOString(),
        payload: { value: 7 },
        idempotencyKey: "old-v1",
      },
    ]);
    const events = await readEvents(sql, registry, { afterSeq: 0n, limit: 100 });
    const upcast = events.find((e) => e.payload !== null && (e.payload as { value: number }).value === 7);
    expect(upcast?.schemaVersion).toBe(2);
    expect(upcast?.payload).toEqual({ value: 7, label: "unlabeled" });
  });

  test("type patterns filter reads", async () => {
    await appendEvents(sql, registry, [
      {
        type: "test.other.happened",
        schemaVersion: 1,
        source: "test",
        occurredAt: new Date().toISOString(),
        payload: {},
        idempotencyKey: "other-1",
      },
    ]);
    const things = await readEvents(sql, registry, {
      afterSeq: 0n,
      patterns: ["test.thing.*"],
      limit: 100,
    });
    expect(things.every((e) => e.type === "test.thing.happened")).toBe(true);
    expect(things.length).toBeGreaterThan(0);
  });
});

describe("upcast chain", () => {
  test("upcastToLatest walks versions in order", () => {
    const result = upcastToLatest(registry, "test.thing.happened", 1, { value: 3 });
    expect(result).toEqual({ schemaVersion: 2, payload: { value: 3, label: "unlabeled" } });
  });
});
