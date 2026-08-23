import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Reactor, ReactorEvent, ReactorResult } from "@nc/process";
import { userDevtaskCreatedV1 } from "@nc/schema";
import { devPollPayload, finishedEvent, launchRun, pollRun } from "./harness.js";
import type { SandboxProvider } from "./sandbox.js";
import { spritesProvider } from "./sandbox.js";
import { anthropicTitler, fallbackTitle, type Titler } from "./titler.js";
import {
  devConfigFromEnv,
  featureFinishScript,
  featureRunScript,
  featureSpec,
  type DevConfig,
} from "./scripts.js";

const resultSchema = z.object({
  prNumber: z.number().int().positive(),
  prUrl: z.string().min(1),
  branch: z.string().min(1),
  title: z.string(),
});

function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "task" : slug;
}

/**
 * Runs one coding task end to end: on user.devtask.created it launches a
 * sandbox running Claude Code detached, then (as a chain of quick poll jobs)
 * streams the transcript into the log and, when the script exits, emits the
 * PR it opened. The dispatcher stays serial and live throughout — no single
 * job outlives one poll.
 */
export function makeDevAgentReactor(
  provider: SandboxProvider,
  config: () => DevConfig = devConfigFromEnv,
  titler: Titler = anthropicTitler,
): Reactor {
  return {
    kind: "reactor",
    name: "dev-agent",
    trigger: { kind: "event", consumes: ["user.devtask.created"] },
    async run(ctx, input): Promise<ReactorResult> {
      if (input.kind === "event") {
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
            "spec.md": featureSpec({
              repo: cfg.repo,
              trunk: cfg.trunk,
              branch,
              title,
              spec: task.spec,
            }),
            "finish.mjs": featureFinishScript,
          },
          env: {
            DEV_REPO: cfg.repo,
            DEV_TRUNK: cfg.trunk,
            DEV_BRANCH: branch,
            DEV_TITLE: title,
            GITHUB_TOKEN: cfg.githubToken,
            ANTHROPIC_API_KEY: cfg.anthropicApiKey,
          },
        });
        return {
          events: [titled, ...launch.events],
          ...(launch.followUps === undefined ? {} : { followUps: launch.followUps }),
        };
      }
      const payload = devPollPayload.parse(input.payload);
      return pollRun(provider, "dev-agent", payload, (result) => {
        const parsed = resultSchema.safeParse(result);
        if (!parsed.success) {
          return { events: [], summary: "script succeeded but wrote no PR result" };
        }
        const pr: ReactorEvent = {
          type: "dev.pr.opened",
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          causedByUid: payload.taskUid,
          idempotencyKey: `dev:${payload.runUid}:pr`,
          payload: {
            taskUid: payload.taskUid,
            runUid: payload.runUid,
            prNumber: parsed.data.prNumber,
            prUrl: parsed.data.prUrl,
            branch: parsed.data.branch,
            title: parsed.data.title,
          },
        };
        return { events: [pr], summary: `opened PR #${parsed.data.prNumber}` };
      });
    },
  };
}

export const devAgentReactor: Reactor = makeDevAgentReactor(spritesProvider);
