import {
  userDevtaskArchivedV1,
  devPreviewStartedV1,
  devPrMergedV1,
  devPrOpenedV1,
  devRunFinishedV1,
  devRunStartedV1,
  devTaskTitledV1,
  devTranscriptAppendedV1,
  userDevmergeRequestedV1,
  userDevmessageSentV1,
  userDevtaskCreatedV1,
} from "@nc/schema";
import type { Fold } from "@nc/process";
import type { StoredEvent, TransactionSql } from "@nc/log";

// Dev-agent tasks, their sandbox runs, and the transcripts those runs stream
// back. Task status is a straight fold of the lifecycle events:
// queued -> running -> pr_open -> merging -> merged, with failed runs sending
// the task back to 'failed' (a new run on the same task moves it forward
// again — retrying is just another dev.run.started).

export const devFold: Fold = {
  kind: "fold",
  name: "dev",
  version: 7, // failed runs no longer downgrade merged tasks
  consumes: [
    "user.devtask.created",
    "user.devtask.archived",
    "dev.task.titled",
    "dev.preview.started",
    "user.devmessage.sent",
    "user.devmerge.requested",
    "agent.devmerge.requested",
    "dev.run.started",
    "dev.transcript.appended",
    "dev.pr.opened",
    "dev.pr.merged",
    "dev.run.finished",
  ],
  tables: ["dev_tasks", "dev_runs", "dev_transcript_chunks", "dev_messages"],
  async init(tx) {
    await tx`
      create table dev_tasks (
        task_uid    uuid primary key,     -- event_uid of user.devtask.created
        title       text not null,
        spec        text not null,
        status      text not null,        -- queued|running|pr_open|merging|merged|failed
        preview_url text,                 -- live dev-server preview, when running
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
      create table dev_messages (
        msg_uid  uuid primary key,        -- event_uid of user.devmessage.sent
        task_uid uuid not null,
        message  text not null,
        at       timestamptz not null
      )`;
    await tx`create index dev_messages_task on dev_messages (task_uid, at)`;
    await tx`
      create table dev_transcript_chunks (
        run_uid   uuid not null,
        chunk_seq int not null,
        content   text not null,
        at        timestamptz not null,
        primary key (run_uid, chunk_seq)
      )`;
  },
  async apply(tx, events) {
    // Transcript chunks are the only high-volume type: buffer them into one
    // multi-row insert per batch. They live in their own table keyed
    // (run_uid, chunk_seq), so their order relative to the row-per-event
    // lifecycle updates below is immaterial. Everything else applies in seq
    // order, one statement at a time — lifecycle events are rare.
    const chunks: { runUid: string; chunkSeq: number; content: string; at: string }[] = [];
    for (const event of events) {
      if (event.type === "dev.transcript.appended") {
        const chunk = devTranscriptAppendedV1.parse(event.payload);
        chunks.push({
          runUid: chunk.runUid,
          chunkSeq: chunk.chunkSeq,
          content: chunk.content,
          at: event.occurredAt.toISOString(),
        });
        continue;
      }
      await applyOne(tx, event);
    }
    if (chunks.length > 0) {
      await tx`
        insert into dev_transcript_chunks (run_uid, chunk_seq, content, at)
        select run_uid, chunk_seq, content, at from unnest(
          ${chunks.map((c) => c.runUid)}::uuid[],
          ${chunks.map((c) => c.chunkSeq)}::int[],
          ${chunks.map((c) => c.content)}::text[],
          ${chunks.map((c) => c.at)}::timestamptz[]
        ) as t(run_uid, chunk_seq, content, at)
        on conflict (run_uid, chunk_seq) do nothing`;
    }
  },
};

async function applyOne(tx: TransactionSql, event: StoredEvent): Promise<void> {
  const seq = event.seq.toString();
  const at = event.occurredAt.toISOString();
  if (event.type === "user.devtask.created") {
    const task = userDevtaskCreatedV1.parse(event.payload);
    // Placeholder title until dev.task.titled lands (deterministic, so replay
    // converges): the spec's first line, truncated.
    const first = (task.spec.trim().split("\n")[0] ?? "").trim() || "dev task";
    const placeholder = first.length > 80 ? `${first.slice(0, 77)}…` : first;
    await tx`
      insert into dev_tasks (task_uid, title, spec, status, created_at, updated_seq)
      values (${event.eventUid}, ${placeholder}, ${task.spec}, 'queued', ${at}, ${seq})
      on conflict (task_uid) do nothing`;
    return;
  }
  if (event.type === "dev.task.titled") {
    const titled = devTaskTitledV1.parse(event.payload);
    await tx`
      update dev_tasks set title = ${titled.title}, updated_seq = ${seq}
      where task_uid = ${titled.taskUid}`;
    return;
  }
  if (event.type === "dev.preview.started") {
    const preview = devPreviewStartedV1.parse(event.payload);
    await tx`
      update dev_tasks set preview_url = ${preview.url}, updated_seq = ${seq}
      where task_uid = ${preview.taskUid}`;
    return;
  }
  if (event.type === "user.devtask.archived") {
    const archived = userDevtaskArchivedV1.parse(event.payload);
    await tx`
      update dev_tasks set status = 'archived', preview_url = null, updated_seq = ${seq}
      where task_uid = ${archived.taskUid}`;
    return;
  }
  if (event.type === "user.devmessage.sent") {
    const message = userDevmessageSentV1.parse(event.payload);
    await tx`
      insert into dev_messages (msg_uid, task_uid, message, at)
      values (${event.eventUid}, ${message.taskUid}, ${message.message}, ${at})
      on conflict (msg_uid) do nothing`;
    return;
  }
  if (event.type === "user.devmerge.requested" || event.type === "agent.devmerge.requested") {
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
        where task_uid = ${run.taskUid} and status <> 'archived'`;
    }
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
      where task_uid = ${pr.taskUid} and status <> 'archived'`;
    return;
  }
  if (event.type === "dev.pr.merged") {
    const merged = devPrMergedV1.parse(event.payload);
    await tx`
      update dev_runs set merged_sha = ${merged.mergedSha}
      where run_uid = ${merged.runUid}`;
    // The merge lane destroys the task's sandboxes, so the preview dies too.
    await tx`
      update dev_tasks set status = 'merged', preview_url = null, updated_seq = ${seq}
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
      // A trailing run failure must not downgrade a task whose PR already
      // merged: the merge lane destroys the task's sandboxes, so the feature
      // run's poll chain dies with a network error *after* dev.pr.merged.
      await tx`
        update dev_tasks set status = 'failed', updated_seq = ${seq}
        where task_uid = ${finished.taskUid} and status not in ('merged', 'archived')`;
    }
    return;
  }
  throw new Error(`dev fold received unexpected event type ${event.type}`);
}
