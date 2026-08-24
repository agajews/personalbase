import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Reactor, ReactorEvent, ReactorResult } from "@nc/process";
import {
  userDevmessageSentV1,
  userDevtaskArchivedV1,
  userDevtaskCreatedV1,
} from "@nc/schema";
import { devPollPayload, finishedEvent, launchRun, pollRun, runDirFor } from "./harness.js";
import type { SandboxProvider } from "./sandbox.js";
import { spritesProvider } from "./sandbox.js";
import { anthropicTitler, fallbackTitle, type Titler } from "./titler.js";
import {
  devConfigFromEnv,
  featureFinishScript,
  featureRunScript,
  featureSpec,
  previewScript,
  requestMergeScript,
  turnEndScript,
  type DevConfig,
} from "./scripts.js";

/** Written by the run wrapper when the live session ends. */
const sessionResultSchema = z.object({ sessionEnded: z.literal(true) });

/** A queued follow-up message waiting for the task's current turn to finish. */
const devMessagePayload = z.object({
  step: z.literal("message"),
  taskUid: z.uuid(),
  /** event_uid of the user.devmessage.sent event — keys the dedupe chain. */
  msgUid: z.uuid(),
  message: z.string().min(1),
  interrupt: z.boolean().default(false),
  waits: z.number().int().nonnegative(),
});

const jobPayload = z.discriminatedUnion("step", [devPollPayload, devMessagePayload]);

const messageWaitSeconds = 20;
/** ~30 minutes of waiting for the current turn before the message is dropped. */
const maxMessageWaits = 90;

function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "task" : slug;
}

function followUpPrompt(message: string): string {
  return `${message}

(Follow-up from the user on your earlier work in this session. Commit your \
changes; the harness pushes the branch and updates the PR when you finish. \
Update /nc/pr.md if the scope of the change has shifted.)`;
}

/** PR announcements happen mid-session (the poller watches pr.json); a
 * session's exit only needs a human-readable closing summary. */
function sessionExit(result: unknown): { events: ReactorEvent[]; summary: string | null } {
  return {
    events: [],
    summary: sessionResultSchema.safeParse(result).success
      ? "session closed — sending a message reopens it"
      : "session ended",
  };
}

/**
 * Runs coding tasks as conversations. user.devtask.created launches a sandbox
 * running Claude Code detached (turn 1, pinned to the task's uid as session
 * id); user.devmessage.sent resumes the same session in the same sandbox once
 * the current turn is idle. Every turn streams its transcript through the
 * poll-job chain and ends by pushing the branch and ensuring its PR. The
 * sandbox stays alive between turns; the merge lane cleans it up.
 */
export function makeDevAgentReactor(
  provider: SandboxProvider,
  config: () => DevConfig = devConfigFromEnv,
  titler: Titler = anthropicTitler,
): Reactor {
  return {
    kind: "reactor",
    name: "dev-agent",
    trigger: {
      kind: "event",
      consumes: ["user.devtask.created", "user.devmessage.sent", "user.devtask.archived"],
    },
    async run(ctx, input): Promise<ReactorResult> {
      if (input.kind === "event" && input.event.type === "user.devtask.created") {
        const task = userDevtaskCreatedV1.parse(input.event.payload);
        const runUid = randomUUID();
        const taskUid = input.event.eventUid;
        let cfg: DevConfig;
        try {
          cfg = config();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return [finishedEvent({ taskUid, runUid }, "failed", null, message)];
        }
        // The title is derived, not typed: a small LLM call at launch. A
        // titler failure never blocks the run — fall back to the spec's
        // first line.
        let title: string;
        try {
          const result = await titler(task.spec);
          ctx.recordUsage(result.usage);
          title = result.title;
        } catch {
          title = fallbackTitle(task.spec);
        }
        const titled: ReactorEvent = {
          type: "dev.task.titled",
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          causedByUid: taskUid,
          idempotencyKey: `dev:${taskUid}:title`,
          payload: { taskUid, title },
        };
        const branch = `agent/${branchSlug(title)}-${runUid.slice(0, 8)}`;
        const launch = await launchRun(provider, {
          reactorName: "dev-agent",
          kind: "feature",
          taskUid,
          runUid,
          branch,
          files: {
            "run.sh": featureRunScript,
            "prompt.md": featureSpec({
              repo: cfg.repo,
              trunk: cfg.trunk,
              branch,
              title,
              spec: task.spec,
            }),
            "finish.mjs": featureFinishScript,
            "preview.sh": previewScript,
            "request-merge.sh": requestMergeScript,
            "turn-end.sh": turnEndScript,
          },
          env: {
            DEV_REPO: cfg.repo,
            DEV_TRUNK: cfg.trunk,
            DEV_BRANCH: branch,
            DEV_TITLE: title,
            DEV_SESSION_ID: taskUid,
            DEV_RESUME: "0",
            GITHUB_TOKEN: cfg.githubToken,
            ANTHROPIC_API_KEY: cfg.anthropicApiKey,
            PREVIEW_DATABASE_URL: cfg.previewDatabaseUrl,
          },
        });
        return {
          events: [titled, ...launch.events],
          ...(launch.followUps === undefined ? {} : { followUps: launch.followUps }),
        };
      }

      if (input.kind === "event" && input.event.type === "user.devtask.archived") {
        // Stop everything: close any running turns as archived and destroy
        // the task's sandboxes. Dangling poll jobs then no-op (their
        // finished events dedupe against the ones emitted here).
        const archived = userDevtaskArchivedV1.parse(input.event.payload);
        const runs = await ctx.sql`
          select run_uid, status, sandbox from dev_runs
          where task_uid = ${archived.taskUid} and kind = 'feature'`;
        const events: ReactorEvent[] = runs
          .filter((r) => r["status"] === "running")
          .map((r) => finishedEvent(
            { taskUid: archived.taskUid, runUid: r["run_uid"] },
            "succeeded",
            "archived by the user",
            null,
          ));
        for (const sandbox of new Set(runs.map((r) => r["sandbox"] as string))) {
          try {
            await provider.open(sandbox).destroy();
          } catch {
            // already gone; archiving is best-effort cleanup
          }
        }
        return events;
      }

      if (input.kind === "event") {
        // user.devmessage.sent: hand off to a job so the wait-for-idle loop
        // runs on the retry-friendly job chain, not the event checkpoint.
        const message = userDevmessageSentV1.parse(input.event.payload);
        return {
          events: [],
          followUps: [
            {
              process: "reactor:dev-agent",
              payload: {
                step: "message",
                taskUid: message.taskUid,
                msgUid: input.event.eventUid,
                message: message.message,
                interrupt: message.interrupt,
                waits: 0,
              },
              dedupeKey: `dev:${input.event.eventUid}:message`,
            },
          ],
        };
      }

      const payload = jobPayload.parse(input.payload);
      if (payload.step === "poll") {
        return pollRun(provider, "dev-agent", payload, sessionExit, {
          destroySandboxOnSuccess: false,
          previewDatabaseUrl: config().previewDatabaseUrl,
        });
      }

      // A follow-up message: wait until no turn is running, then resume the
      // session in the task's sandbox as a new run.
      const tasks = await ctx.sql`
        select status, title from dev_tasks where task_uid = ${payload.taskUid}`;
      const task = tasks[0];
      if (
        task === undefined ||
        ["merged", "merging", "archived"].includes(task["status"] as string)
      ) {
        return []; // nothing to talk to anymore
      }
      const runs = await ctx.sql`
        select run_uid, status, sandbox, branch from dev_runs
        where task_uid = ${payload.taskUid} and kind = 'feature'
        order by started_at`;
      const last = runs[runs.length - 1];
      if (last === undefined) {
        return []; // no turn ever launched (config failure); nothing to resume
      }
      const running = runs.find((r) => r["status"] === "running");
      if (running !== undefined && !payload.interrupt) {
        // The session is live: stream the message straight into its stdin.
        // If the pipe is gone (session died but the run row hasn't caught
        // up), fall through to the wait chain, which resumes via a new run.
        try {
          await provider
            .open(running["sandbox"])
            .sendMessage(runDirFor(running["run_uid"]), payload.message);
          return [];
        } catch {
          // fall through to waiting
        }
      }
      if (running !== undefined) {
        if (payload.interrupt) {
          // Kill the live session mid-turn (idempotent); the poll chain
          // closes the run as interrupted within seconds and the wait below
          // resumes the Claude session in a fresh run with this message.
          await provider.open(running["sandbox"]).interrupt(runDirFor(running["run_uid"]));
        }
        if (payload.waits + 1 >= maxMessageWaits) {
          return []; // turn never went idle; drop rather than queue forever
        }
        return {
          events: [],
          followUps: [
            {
              process: "reactor:dev-agent",
              payload: { ...payload, waits: payload.waits + 1 },
              runAfterSeconds: payload.interrupt ? 5 : messageWaitSeconds,
              dedupeKey: `dev:${payload.msgUid}:wait:${payload.waits + 1}`,
            },
          ],
        };
      }
      const cfg = config();
      const runUid = randomUUID();
      return launchRun(provider, {
        reactorName: "dev-agent",
        kind: "feature",
        taskUid: payload.taskUid,
        runUid,
        branch: last["branch"],
        sandboxName: last["sandbox"],
        preamble: `[user follow-up]\n${payload.message}\n`,
        files: {
          "run.sh": featureRunScript,
          "prompt.md": followUpPrompt(payload.message),
          "finish.mjs": featureFinishScript,
          "preview.sh": previewScript,
          "request-merge.sh": requestMergeScript,
          "turn-end.sh": turnEndScript,
        },
        env: {
          DEV_REPO: cfg.repo,
          DEV_TRUNK: cfg.trunk,
          DEV_BRANCH: last["branch"],
          DEV_TITLE: task["title"],
          DEV_SESSION_ID: payload.taskUid,
          DEV_RESUME: "1",
          GITHUB_TOKEN: cfg.githubToken,
          ANTHROPIC_API_KEY: cfg.anthropicApiKey,
          PREVIEW_DATABASE_URL: cfg.previewDatabaseUrl,
        },
      });
    },
  };
}

export const devAgentReactor: Reactor = makeDevAgentReactor(spritesProvider);
