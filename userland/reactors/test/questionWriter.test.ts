import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { coreRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpFolds, runReactor } from "@nc/process";
import { chatsFold, questionsFold } from "@nc/folds";
import { makeQuestionWriterReactor, type QuestionHistoryItem } from "@nc/reactors";

const folds = [questionsFold, chatsFold];

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

describe("question-writer", () => {
  test("poses one question per day, feeding history + discussion to the generator", async () => {
    // The reactor reads the questions and chats folds; initialize their tables.
    await catchUpFolds(sql, coreRegistry, folds);
    const seenHistories: QuestionHistoryItem[][] = [];
    let level = 1;
    const reactor = makeQuestionWriterReactor(async (history) => {
      seenHistories.push([...history]);
      return {
        generated: {
          level,
          question: `Compute $\\nabla_x (x^T A x)$ — level ${level}`,
          notes: "quadratic forms",
        },
        usage: { tokensIn: 10, tokensOut: 5 },
      };
    });

    const first = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { day: "2026-08-23" },
    });
    expect(first.emitted).toBe(1);
    expect(first.appended).toBe(1);
    expect(seenHistories[0]).toEqual([]);
    await catchUpFolds(sql, coreRegistry, folds);

    // Same-day rerun dedupes on the daily idempotency key.
    const again = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { day: "2026-08-23" },
    });
    expect(again.appended).toBe(0);

    // Discuss day 1's question in its chat (uid = question uid).
    const rows = await sql`select question_uid from study_questions where day = '2026-08-23'`;
    const questionUid = rows[0]!["question_uid"] as string;
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.chat.message_sent",
        schemaVersion: 1,
        source: "test",
        occurredAt: "2026-08-23T12:00:00.000Z",
        payload: { chatUid: questionUid, text: "I get 2Ax assuming A symmetric" },
      },
      {
        type: "agent.chat.replied",
        schemaVersion: 1,
        source: "agent:chat",
        occurredAt: "2026-08-23T12:01:00.000Z",
        payload: { chatUid: questionUid, reply: "Correct.", trace: [], apiMessages: [] },
      },
    ]);
    await catchUpFolds(sql, coreRegistry, folds);

    // Day 2: the generator sees day 1's question with its discussion.
    level = 2;
    const second = await runReactor(sql, coreRegistry, reactor, {
      kind: "job",
      payload: { day: "2026-08-24" },
    });
    expect(second.appended).toBe(1);
    const history = seenHistories[seenHistories.length - 1]!;
    expect(history).toHaveLength(1);
    expect(history[0]!.day).toBe("2026-08-23");
    expect(history[0]!.level).toBe(1);
    expect(history[0]!.discussion).toContain("2Ax");
    expect(history[0]!.discussion).toContain("Correct.");
    await catchUpFolds(sql, coreRegistry, folds);

    const all = await sql`select day, level from study_questions order by day`;
    expect(all).toHaveLength(2);
    expect(all[1]!["level"]).toBe(2);
  });
});
