import { z } from "zod";
import type { ReactorEvent, ReactorOutput } from "@nc/process";
import type { SandboxPoll, SandboxProvider } from "./sandbox.js";

const pollIntervalSeconds = 10;
const pollMaxBytes = 256 * 1024;
/** ~2 hours of polls; past this the run is declared lost. */
const maxPolls = 720;

export const devPollPayload = z.object({
  step: z.literal("poll"),
  kind: z.enum(["feature", "merge"]),
  taskUid: z.uuid(),
  runUid: z.uuid(),
  sandbox: z.string().min(1),
  branch: z.string().nullable(),
  /** Merge runs carry the PR they operate on; feature runs carry null. */
  prNumber: z.number().int().positive().nullable(),
  cursor: z.number().int().nonnegative(),
  chunkSeq: z.number().int().nonnegative(),
  polls: z.number().int().nonnegative(),
});
export type DevPollPayload = z.infer<typeof devPollPayload>;

export interface LaunchArgs {
  readonly reactorName: string;
  readonly kind: "feature" | "merge";
  readonly taskUid: string;
  readonly runUid: string;
  readonly branch: string | null;
  readonly prNumber?: number;
  /** Reuse an existing sandbox (conversation turns); default: a fresh one. */
  readonly sandboxName?: string;
  /** Transcript preamble (e.g. the user's follow-up message) shown as chunk 0. */
  readonly preamble?: string;
  readonly files: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
}

/** Each run's files live in their own directory inside the shared sandbox. */
export function runDirFor(runUid: string): string {
  return `/nc/run-${runUid.slice(0, 8)}`;
}

function chunkEvent(
  payload: Pick<DevPollPayload, "taskUid" | "runUid" | "chunkSeq">,
  content: string,
): ReactorEvent {
  return {
    type: "dev.transcript.appended",
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    causedByUid: payload.taskUid,
    idempotencyKey: `dev:${payload.runUid}:chunk:${payload.chunkSeq}`,
    payload: {
      taskUid: payload.taskUid,
      runUid: payload.runUid,
      chunkSeq: payload.chunkSeq,
      content,
    },
  };
}

export function finishedEvent(
  payload: Pick<DevPollPayload, "taskUid" | "runUid">,
  status: "succeeded" | "failed",
  summary: string | null,
  error: string | null,
): ReactorEvent {
  return {
    type: "dev.run.finished",
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    causedByUid: payload.taskUid,
    idempotencyKey: `dev:${payload.runUid}:finished`,
    payload: { taskUid: payload.taskUid, runUid: payload.runUid, status, summary, error },
  };
}

/**
 * Creates the sandbox, starts the detached script, and returns the
 * dev.run.started event plus the first poll of the chain. A launch failure
 * (missing secrets, sandbox API down) becomes a failed run rather than a
 * throw: throwing from an event trigger would retry every daemon pass
 * forever, since the checkpoint only advances on success.
 */
export async function launchRun(
  provider: SandboxProvider,
  args: LaunchArgs,
): Promise<ReactorOutput> {
  const sandboxName = args.sandboxName ?? `nc-dev-${args.runUid.slice(0, 8)}`;
  // Cold sandboxes are occasionally slow to take their first command; retry
  // the launch a couple of times (start() is idempotent) before failing.
  let lastError = "";
  let started = false;
  for (let attempt = 0; attempt < 3 && !started; attempt++) {
    try {
      const sandbox = await provider.create(sandboxName);
      await sandbox.start(runDirFor(args.runUid), args.files, args.env);
      started = true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  if (!started) {
    return {
      events: [finishedEvent(args, "failed", null, `sandbox launch failed: ${lastError}`)],
    };
  }
  const preambleEvents: ReactorEvent[] =
    args.preamble === undefined
      ? []
      : [
          chunkEvent(
            { taskUid: args.taskUid, runUid: args.runUid, chunkSeq: 0 },
            args.preamble,
          ),
        ];
  const firstPoll: DevPollPayload = {
    step: "poll",
    kind: args.kind,
    taskUid: args.taskUid,
    runUid: args.runUid,
    sandbox: sandboxName,
    branch: args.branch,
    prNumber: args.prNumber ?? null,
    cursor: 0,
    chunkSeq: preambleEvents.length,
    polls: 0,
  };
  return {
    events: [
      {
        type: "dev.run.started",
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        causedByUid: args.taskUid,
        idempotencyKey: `dev:${args.runUid}:started`,
        payload: {
          taskUid: args.taskUid,
          runUid: args.runUid,
          kind: args.kind,
          sandbox: sandboxName,
          branch: args.branch,
        },
      },
      ...preambleEvents,
    ],
    followUps: [
      {
        process: `reactor:${args.reactorName}`,
        payload: firstPoll,
        runAfterSeconds: pollIntervalSeconds,
        dedupeKey: `dev:${args.runUid}:poll:1`,
      },
    ],
  };
}

/**
 * One look at a running sandbox: stream new log bytes out as a transcript
 * chunk, and either chain the next poll or — when the script has exited —
 * emit the run's outcome events and stop. `onExit` maps the script's
 * result.json to run-kind-specific events (dev.pr.opened, dev.pr.merged);
 * it is only called for exit code 0.
 */
export async function pollRun(
  provider: SandboxProvider,
  reactorName: string,
  payload: DevPollPayload,
  onExit: (result: unknown) => { events: ReactorEvent[]; summary: string | null },
  options: { readonly destroySandboxOnSuccess: boolean } = { destroySandboxOnSuccess: true },
): Promise<ReactorOutput> {
  const sandbox = provider.open(payload.sandbox);
  let poll: SandboxPoll;
  try {
    poll = await sandbox.poll(runDirFor(payload.runUid), payload.cursor, pollMaxBytes);
  } catch (error) {
    // A vanished sandbox fails the run rather than retrying forever.
    const message = error instanceof Error ? error.message : String(error);
    return { events: [finishedEvent(payload, "failed", null, `sandbox poll failed: ${message}`)] };
  }

  const events: ReactorEvent[] = [];
  let consumedBytes = 0;
  if (poll.content !== "") {
    // Cut at the last newline so stream-json lines stay whole across chunks
    // (and multibyte characters cannot split); a full-buffer chunk with no
    // newline is passed through as-is.
    let kept = poll.content;
    if (!poll.exited) {
      const lastNewline = poll.content.lastIndexOf("\n");
      if (lastNewline >= 0) {
        kept = poll.content.slice(0, lastNewline + 1);
      } else if (Buffer.byteLength(poll.content, "utf8") < pollMaxBytes) {
        kept = "";
      }
    }
    if (kept !== "") {
      events.push(chunkEvent(payload, kept));
      consumedBytes = Buffer.byteLength(kept, "utf8");
    }
  }

  if (poll.exited) {
    if (poll.exitCode === 0) {
      const outcome = onExit(poll.result);
      events.push(...outcome.events);
      events.push(finishedEvent(payload, "succeeded", outcome.summary, null));
      // Feature sandboxes stay alive for conversation follow-ups; the merge
      // lane cleans them (and itself) up once the task's PR lands.
      if (options.destroySandboxOnSuccess) {
        await sandbox.destroy();
      }
    } else {
      const resultError =
        typeof poll.result === "object" && poll.result !== null && "error" in poll.result
          ? String((poll.result as { error: unknown }).error)
          : `script exited with code ${poll.exitCode}`;
      // The sandbox is kept on failure for manual inspection.
      events.push(finishedEvent(payload, "failed", null, resultError));
    }
    return { events };
  }

  if (payload.polls + 1 >= maxPolls) {
    return {
      events: [
        ...events,
        finishedEvent(payload, "failed", null, `run exceeded ${maxPolls} polls; abandoned`),
      ],
    };
  }

  return {
    events,
    followUps: [
      {
        process: `reactor:${reactorName}`,
        payload: {
          ...payload,
          cursor: payload.cursor + consumedBytes,
          chunkSeq: consumedBytes > 0 ? payload.chunkSeq + 1 : payload.chunkSeq,
          polls: payload.polls + 1,
        },
        runAfterSeconds: pollIntervalSeconds,
        dedupeKey: `dev:${payload.runUid}:poll:${payload.polls + 2}`,
      },
    ],
  };
}
