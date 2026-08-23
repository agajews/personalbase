import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { coreRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpFold } from "@nc/process";
import { entityId, marksFold, paperRef } from "@nc/folds";

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

const paperId = entityId("paper", paperRef("2102.09672"));

function markEvent(mark: string, key: string) {
  return {
    type: "user.paper.marked",
    schemaVersion: 1,
    source: "ui:web",
    occurredAt: new Date().toISOString(),
    payload: { arxivId: "2102.09672", mark },
    idempotencyKey: key,
  };
}

const paperpileEvent = {
  type: "paperpile.item.imported",
  schemaVersion: 1,
  source: "reactor:paperpile-import",
  occurredAt: "2026-08-01T00:00:00.000Z",
  payload: {
    paperpileId: "pp-1",
    pubtype: "PP_PREPRINT",
    title: "Improved DDPM",
    authors: ["Alex Nichol"],
    arxivId: "2102.09672",
    addedAt: "2026-08-01T00:00:00.000Z",
  },
  idempotencyKey: "paperpile:pp-1",
};

async function markOf(): Promise<string | null> {
  const rows = await sql`select mark from paper_marks where entity_id = ${paperId}`;
  return rows[0]?.["mark"] ?? null;
}

describe("marks fold", () => {
  test("user marks upsert; none deletes; imports never downgrade", async () => {
    // User promotes to want_to_read...
    await appendEvents(sql, coreRegistry, [markEvent("want_to_read", "m1")]);
    await catchUpFold(sql, coreRegistry, marksFold);
    expect(await markOf()).toBe("want_to_read");

    // ...then a library import of the same paper arrives: no downgrade.
    await appendEvents(sql, coreRegistry, [paperpileEvent]);
    await catchUpFold(sql, coreRegistry, marksFold);
    expect(await markOf()).toBe("want_to_read");

    // Explicit user demotion and unmark work.
    await appendEvents(sql, coreRegistry, [markEvent("saved", "m2")]);
    await catchUpFold(sql, coreRegistry, marksFold);
    expect(await markOf()).toBe("saved");
    await appendEvents(sql, coreRegistry, [markEvent("none", "m3")]);
    await catchUpFold(sql, coreRegistry, marksFold);
    expect(await markOf()).toBeNull();
  });

  test("library imports auto-save unmarked papers with the library added date", async () => {
    await appendEvents(sql, coreRegistry, [
      { ...paperpileEvent, idempotencyKey: "paperpile:pp-1-again", payload: { ...paperpileEvent.payload, paperpileId: "pp-1b" } },
    ]);
    await catchUpFold(sql, coreRegistry, marksFold);
    const rows = await sql`select mark, marked_at from paper_marks where entity_id = ${paperId}`;
    expect(rows[0]!["mark"]).toBe("saved");
    expect(new Date(rows[0]!["marked_at"]).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});
