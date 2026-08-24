import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { claimJob, completeJob, enqueueDueCronJobs, type Reactor } from "@nc/process";

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

const reactor: Reactor = {
  kind: "reactor",
  name: "ticker",
  trigger: { kind: "cron", schedule: { intervalHours: 24 }, payload: { tick: true } },
  run: async () => [],
};

describe("cron scheduling", () => {
  test("enqueues once, then holds while a job is pending or a recent run exists", async () => {
    const first = await enqueueDueCronJobs(sql, [reactor]);
    expect(first).toHaveLength(1);

    // Pending job → no duplicate.
    expect(await enqueueDueCronJobs(sql, [reactor])).toHaveLength(0);

    // Simulate the worker completing it, with a run record just now.
    const job = await claimJob(sql);
    await sql`insert into runs (process, status, started_at) values ('reactor:ticker', 'done', now())`;
    await completeJob(sql, job!.jobId);

    // Recent run → still held.
    expect(await enqueueDueCronJobs(sql, [reactor])).toHaveLength(0);

    // Backdate the run past the interval → due again.
    await sql`update runs set started_at = now() - interval '25 hours'`;
    const again = await enqueueDueCronJobs(sql, [reactor]);
    expect(again).toHaveLength(1);
    const jobs = await sql`select payload from jobs where status = 'pending'`;
    expect(jobs[0]!["payload"]).toEqual({ tick: true });
  });

  test("a recent failed run also holds the schedule (no hot retry loop)", async () => {
    await sql`delete from jobs`;
    await sql`update runs set started_at = now(), status = 'failed'`;
    expect(await enqueueDueCronJobs(sql, [reactor])).toHaveLength(0);
  });

  test("a daily schedule is due once per tick of its fixed hour", async () => {
    // A tick at the current UTC hour is always in the recent past, making
    // the assertions below time-independent.
    const daily: Reactor = {
      kind: "reactor",
      name: "dailyer",
      trigger: {
        kind: "cron",
        schedule: { dailyAtHour: new Date().getUTCHours(), timeZone: "UTC" },
        payload: {},
      },
      run: async () => [],
    };

    // Never ran → due.
    expect(await enqueueDueCronJobs(sql, [daily])).toHaveLength(1);
    const job = await claimJob(sql);
    await sql`insert into runs (process, status, started_at) values ('reactor:dailyer', 'done', now())`;
    await completeJob(sql, job!.jobId);

    // Ran since the last tick → held.
    expect(await enqueueDueCronJobs(sql, [daily])).toHaveLength(0);

    // Last run before the tick (a day old) → due again.
    await sql`update runs set started_at = now() - interval '24 hours'
              where process = 'reactor:dailyer'`;
    expect(await enqueueDueCronJobs(sql, [daily])).toHaveLength(1);
  });
});
