import { appendEvents, jsonb, readEvents, type NewEvent, type Sql } from "@nc/log";
import type { SchemaRegistry } from "@nc/schema";
import { claimJob, completeJob, enqueueJob, failJob } from "./jobs.js";
import type { Reactor, ReactorCtx, ReactorInput, ReactorOutput } from "./types.js";

const eventBatchSize = 100;

function makeCtx(
  sql: Sql,
  reactorName: string,
  usage: { tokensIn: number; tokensOut: number },
): ReactorCtx {
  const stateKey = `reactor:${reactorName}`;
  return {
    sql,
    async getState(): Promise<unknown> {
      const rows = await sql`select state from process_state where process = ${stateKey}`;
      return rows[0]?.["state"] ?? null;
    },
    async setState(state: unknown): Promise<void> {
      await sql`
        insert into process_state (process, state)
        values (${stateKey}, ${jsonb(sql, state)})
        on conflict (process) do update set state = excluded.state, updated_at = now()`;
    },
    recordUsage(u): void {
      usage.tokensIn += u.tokensIn;
      usage.tokensOut += u.tokensOut;
    },
  };
}

function inputSummary(input: ReactorInput): unknown {
  return input.kind === "event"
    ? { kind: "event", seq: input.event.seq.toString(), type: input.event.type }
    : { kind: "job", payload: input.payload };
}

/**
 * Executes one reactor run: records a runs row, invokes the reactor, stamps
 * and appends its emitted events. Emission idempotency keys make a retried
 * run safe.
 */
export async function runReactor(
  sql: Sql,
  registry: SchemaRegistry,
  reactor: Reactor,
  input: ReactorInput,
  jobId?: string,
): Promise<{ runId: string; emitted: number; appended: number }> {
  const processKey = `reactor:${reactor.name}`;
  const rows = await sql`
    insert into runs (process, job_id, input_summary)
    values (${processKey}, ${jobId ?? null}, ${jsonb(sql, inputSummary(input))})
    returning run_id`;
  const runId: string = rows[0]!["run_id"];
  const usage = { tokensIn: 0, tokensOut: 0 };
  try {
    const result = await reactor.run(makeCtx(sql, reactor.name, usage), input);
    const output: ReactorOutput = Array.isArray(result) ? { events: result } : result;
    const stamped: NewEvent[] = output.events.map((e) => ({
      ...e,
      source: processKey,
      sourceRunId: runId,
    }));
    const appended = await appendEvents(sql, registry, stamped);
    // Follow-ups go in only after the events they depend on are appended;
    // dedupe keys make the retry of a crash between these two steps safe.
    for (const followUp of output.followUps ?? []) {
      await enqueueJob(sql, followUp.process, followUp.payload, {
        runAfterSeconds: followUp.runAfterSeconds,
        dedupeKey: followUp.dedupeKey,
      });
    }
    await sql`
      update runs
      set finished_at = now(), status = 'done', emitted_count = ${output.events.length},
          tokens_in = ${usage.tokensIn}, tokens_out = ${usage.tokensOut}
      where run_id = ${runId}`;
    return { runId, emitted: output.events.length, appended };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      update runs
      set finished_at = now(), status = 'failed', error = ${message},
          tokens_in = ${usage.tokensIn}, tokens_out = ${usage.tokensOut}
      where run_id = ${runId}`;
    throw error;
  }
}

/**
 * Drives event-triggered reactors from their checkpoints. The checkpoint only
 * advances after a successful run, so a failed event is retried on the next
 * catch-up (at-least-once; emission idempotency makes that safe).
 */
export async function catchUpEventReactors(
  sql: Sql,
  registry: SchemaRegistry,
  reactors: readonly Reactor[],
): Promise<void> {
  for (const reactor of reactors) {
    if (reactor.trigger.kind !== "event") {
      continue;
    }
    const key = `reactor:${reactor.name}`;
    await sql`
      insert into checkpoints (process, version, last_seq)
      values (${key}, 1, 0)
      on conflict (process) do nothing`;
    while (true) {
      const rows = await sql`select last_seq from checkpoints where process = ${key}`;
      const cursor = BigInt(rows[0]!["last_seq"]);
      const events = await readEvents(sql, registry, {
        afterSeq: cursor,
        patterns: reactor.trigger.consumes,
        limit: eventBatchSize,
      });
      if (events.length === 0) {
        break;
      }
      for (const event of events) {
        await runReactor(sql, registry, reactor, { kind: "event", event });
        await sql`
          update checkpoints set last_seq = ${event.seq.toString()}, updated_at = now()
          where process = ${key}`;
      }
    }
  }
}

/**
 * Claims and runs pending jobs. A job's process is "reactor:<name>". Returns
 * the number of jobs run (including failed ones, which are retried or marked
 * dead by the queue). `maxJobs` lets the daemon take one job per loop pass so
 * folds catch up between jobs — a judging job enqueued after an ingest job
 * then sees the ingested papers.
 */
export async function processPendingJobs(
  sql: Sql,
  registry: SchemaRegistry,
  reactors: readonly Reactor[],
  maxJobs = Number.POSITIVE_INFINITY,
): Promise<number> {
  let count = 0;
  while (count < maxJobs) {
    const job = await claimJob(sql);
    if (job === null) {
      return count;
    }
    count += 1;
    const reactor = reactors.find((r) => `reactor:${r.name}` === job.process);
    if (reactor === undefined) {
      await failJob(sql, job, `no registered reactor for process ${job.process}`);
      continue;
    }
    try {
      await runReactor(sql, registry, reactor, { kind: "job", payload: job.payload }, job.jobId);
      await completeJob(sql, job.jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`job ${job.jobId} (${job.process}) failed: ${message}`);
      await failJob(sql, job, message);
    }
  }
  return count;
}
