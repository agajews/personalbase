import { jsonb, type Sql } from "@nc/log";
import type { Reactor } from "./types.js";

const maxAttempts = 3;
const retryDelaySeconds = 60;

export interface ClaimedJob {
  readonly jobId: string;
  readonly process: string;
  readonly payload: unknown;
  readonly attempts: number;
}

export interface EnqueueOptions {
  /** Seconds before the job becomes due (default 0). */
  readonly runAfterSeconds?: number;
  /** Unique key; an enqueue whose key already exists is dropped (returns null). */
  readonly dedupeKey?: string;
}

export async function enqueueJob(
  sql: Sql,
  process: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const rows = await sql`
    insert into jobs (process, payload, run_after, dedupe_key)
    values (${process}, ${jsonb(sql, payload)},
            now() + make_interval(secs => ${options.runAfterSeconds ?? 0}),
            ${options.dedupeKey ?? null})
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning job_id`;
  return rows[0]?.["job_id"] ?? null;
}

/** Claims one due pending job with FOR UPDATE SKIP LOCKED semantics. */
export async function claimJob(sql: Sql): Promise<ClaimedJob | null> {
  const rows = await sql`
    update jobs set status = 'running', attempts = attempts + 1
    where job_id = (
      select job_id from jobs
      where status = 'pending' and run_after <= now()
      order by run_after
      for update skip locked
      limit 1
    )
    returning job_id, process, payload, attempts`;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    jobId: row["job_id"],
    process: row["process"],
    payload: row["payload"],
    attempts: row["attempts"],
  };
}

export async function completeJob(sql: Sql, jobId: string): Promise<void> {
  await sql`update jobs set status = 'done' where job_id = ${jobId}`;
}

/**
 * Enqueues a job for each cron reactor that is due: no pending/running job
 * and no run started since the schedule's most recent tick — `now() -
 * interval` for rolling schedules, the last occurrence of the fixed hour (in
 * its time zone) for daily ones. Guarding on any run (including failed ones)
 * means a persistently failing reactor retries at most once per tick rather
 * than hot-looping on LLM spend.
 */
export async function enqueueDueCronJobs(
  sql: Sql,
  reactors: readonly Reactor[],
): Promise<string[]> {
  const enqueued: string[] = [];
  for (const reactor of reactors) {
    if (reactor.trigger.kind !== "cron") {
      continue;
    }
    const process = `reactor:${reactor.name}`;
    const schedule = reactor.trigger.schedule;
    const lastTick =
      "intervalHours" in schedule
        ? sql`now() - make_interval(hours => ${schedule.intervalHours})`
        : sql`(date_trunc('day', now() at time zone ${schedule.timeZone})
              + make_interval(hours => ${schedule.dailyAtHour})
              - case when extract(hour from now() at time zone ${schedule.timeZone})
                          < ${schedule.dailyAtHour}
                     then interval '1 day' else interval '0 hours' end
              ) at time zone ${schedule.timeZone}`;
    const rows = await sql`
      insert into jobs (process, payload)
      select ${process}, ${jsonb(sql, reactor.trigger.payload)}
      where not exists (
          select 1 from jobs where process = ${process} and status in ('pending', 'running'))
        and not exists (
          select 1 from runs where process = ${process} and started_at >= ${lastTick})
      returning job_id`;
    if (rows[0] !== undefined) {
      console.log(`cron: enqueued ${process}`);
      enqueued.push(rows[0]["job_id"]);
    }
  }
  return enqueued;
}

/** Retries with a delay until maxAttempts, then marks the job dead. */
export async function failJob(sql: Sql, job: ClaimedJob, error: string): Promise<void> {
  if (job.attempts < maxAttempts) {
    await sql`
      update jobs
      set status = 'pending',
          run_after = now() + make_interval(secs => ${retryDelaySeconds}),
          last_error = ${error}
      where job_id = ${job.jobId}`;
  } else {
    await sql`
      update jobs set status = 'dead', last_error = ${error}
      where job_id = ${job.jobId}`;
  }
}
