import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { coreRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpFold } from "@nc/process";
import { chatsFold } from "@nc/folds";

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

const chatUid = "11111111-2222-4333-8444-555555555555";

describe("chats fold", () => {
  test("chat events fold into a titled chat with ordered turns", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.chat.message_sent",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: "2026-08-23T10:00:00.000Z",
        payload: { chatUid, text: "find my papers about diffusion models please" },
        idempotencyKey: "c1",
      },
      {
        type: "agent.chat.replied",
        schemaVersion: 1,
        source: "agent:chat",
        occurredAt: "2026-08-23T10:00:30.000Z",
        payload: {
          chatUid,
          reply: "You have **70** diffusion papers.",
          trace: [{ tool: "query", summary: "query (70 rows): select …", isError: false }],
          apiMessages: [
            { role: "assistant", content: [{ type: "text", text: "You have **70**…" }] },
          ],
        },
        idempotencyKey: "c2",
      },
    ]);
    await catchUpFold(sql, coreRegistry, chatsFold);

    const chats = await sql`select title, created_at, last_at from chats`;
    expect(chats).toHaveLength(1);
    expect(chats[0]!["title"]).toBe("find my papers about diffusion models please");
    expect(new Date(chats[0]!["last_at"]).toISOString()).toBe("2026-08-23T10:00:30.000Z");

    const turns = await sql`
      select role, text, trace, api_messages from chat_turns
      where chat_uid = ${chatUid} order by event_seq`;
    expect(turns.map((t) => t["role"])).toEqual(["user", "assistant"]);
    expect(turns[1]!["trace"]).toHaveLength(1);
    expect(turns[1]!["api_messages"]).toHaveLength(1);
  });
});
