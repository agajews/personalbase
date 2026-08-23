import {
  devPrMergedV1,
  devPrOpenedV1,
  devRunFinishedV1,
  devRunStartedV1,
  devTranscriptAppendedV1,
  userDevmergeRequestedV1,
  userDevtaskCreatedV1,
} from "@nc/schema";
import type { Fold } from "@nc/process";

// Dev-agent tasks, their sandbox runs, and the transcripts those runs stream
// back. Task status is a straight fold of the lifecycle events:
// queued -> running -> pr_open -> merging -> merged, with failed runs sending
// the task back to 'failed' (a new run on the same task moves it forward
// again — retrying is just another dev.run.started).

export const devFold: Fold = {
  kind: "fold",
  name: "dev",
  version: 1,
  consumes: [
    "user.devtask.created",
    "user.devmerge.requested",
    "dev.run.started",
    "dev.transcript.appended",
    "dev.pr.opened",
    "dev.pr.merged",
    "dev.run.finished",
  ],
  tables: ["dev_tasks", "dev_runs", "dev_transcript_chunks"],
  async init(tx) {
    await tx`
      create table dev_tasks (
        task_uid    uuid primary key,     -- event_uid of user.devtask.created
        title       text not null,
        spec        text not null,
        status      text not null,        -- queued|running|pr_open|merging|merged|failed
        created_at  timestamptz not null,
        updated_seq bigint not null
      )`;
    await tx`
      create table dev_runs (
        run_uid     uuid primary key,
        task_uid    uuid not null,
        kind        text not null,        -- 'feature' | 'merge'
        status      text not null,        -- running|succeeded|failed
        sandbox     text not null,
        branch      text,
        pr_number   int,
        pr_url      text,
        pr_title    text,
        merged_sha  text,
        summary     text,
        error       text,
        started_at  timestamptz not null,
        finished_at timestamptz
      )`;
    await tx`create index dev_runs_task on dev_runs (task_uid, started_at)`;
    await tx`
      create table dev_transcript_chunks (
        run_uid   uuid not null,
        chunk_seq int not null,
        content   text not null,
        at        timestamptz not null,
        primary key (run_uid, chunk_seq)
      )`;
  },
  async apply(tx, event) {
    const seq = event.seq.toString();
    const at = event.occurredAt.toISOString();
    if (event.type === "user.devtask.created") {
      const task = userDevtaskCreatedV1.parse(event.payload);
      await tx`
        insert into dev_tasks (task_uid, title, spec, status, created_at, updated_seq)
        values (${event.eventUid}, ${task.title}, ${task.spec}, 'queued', ${at}, ${seq})
        on conflict (task_uid) do nothing`;
      return;
    }
    if (event.type === "user.devmerge.requested") {
      const request = userDevmergeRequestedV1.parse(event.payload);
      await tx`
        update dev_tasks set status = 'merging', updated_seq = ${seq}
        where task_uid = ${request.taskUid}`;
      return;
    }
    if (event.type === "dev.run.started") {
      const run = devRunStartedV1.parse(event.payload);
      await tx`
        insert into dev_runs (run_uid, task_uid, kind, status, sandbox, branch, started_at)
        values (${run.runUid}, ${run.taskUid}, ${run.kind}, 'running', ${run.sandbox},
                ${run.branch}, ${at})
        on conflict (run_uid) do nothing`;
      if (run.kind === "feature") {
        await tx`
          update dev_tasks set status = 'running', updated_seq = ${seq}
          where task_uid = ${run.taskUid}`;
      }
      return;
    }
    if (event.type === "dev.transcript.appended") {
      const chunk = devTranscriptAppendedV1.parse(event.payload);
      await tx`
        insert into dev_transcript_chunks (run_uid, chunk_seq, content, at)
        values (${chunk.runUid}, ${chunk.chunkSeq}, ${chunk.content}, ${at})
        on conflict (run_uid, chunk_seq) do nothing`;
      return;
    }
    if (event.type === "dev.pr.opened") {
      const pr = devPrOpenedV1.parse(event.payload);
      await tx`
        update dev_runs
        set pr_number = ${pr.prNumber}, pr_url = ${pr.prUrl}, pr_title = ${pr.title}
        where run_uid = ${pr.runUid}`;
      await tx`
        update dev_tasks set status = 'pr_open', updated_seq = ${seq}
        where task_uid = ${pr.taskUid}`;
      return;
    }
    if (event.type === "dev.pr.merged") {
      const merged = devPrMergedV1.parse(event.payload);
      await tx`
        update dev_runs set merged_sha = ${merged.mergedSha}
        where run_uid = ${merged.runUid}`;
      await tx`
        update dev_tasks set status = 'merged', updated_seq = ${seq}
        where task_uid = ${merged.taskUid}`;
      return;
    }
    if (event.type === "dev.run.finished") {
      const finished = devRunFinishedV1.parse(event.payload);
      await tx`
        update dev_runs
        set status = ${finished.status}, summary = ${finished.summary},
            error = ${finished.error}, finished_at = ${at}
        where run_uid = ${finished.runUid}`;
      if (finished.status === "failed") {
        await tx`
          update dev_tasks set status = 'failed', updated_seq = ${seq}
          where task_uid = ${finished.taskUid}`;
      }
      return;
    }
    throw new Error(`dev fold received unexpected event type ${event.type}`);
  },
};
