import { jsonb, type Sql } from "@nc/log";

const maxAttempts = 3;
const retryDelaySeconds = 60;

export interface ClaimedJob {
  readonly jobId: string;
  readonly process: string;
  readonly payload: unknown;
  readonly attempts: number;
}

export async function enqueueJob(
  sql: Sql,
  process: string,
  payload: unknown,
): Promise<string> {
  const rows = await sql`
    insert into jobs (process, payload)
    values (${process}, ${jsonb(sql, payload)})
    returning job_id`;
  return rows[0]!["job_id"];
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
