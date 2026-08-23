import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Reactor, ReactorEvent, ReactorResult } from "@nc/process";
import { userDevmergeRequestedV1 } from "@nc/schema";
import { devPollPayload, launchRun, pollRun } from "./harness.js";
import type { SandboxProvider } from "./sandbox.js";
import { spritesProvider } from "./sandbox.js";
import { devConfigFromEnv, mergeFinishScript, mergeRunScript, type DevConfig } from "./scripts.js";

const resultSchema = z.object({
  mergedSha: z.string().min(1),
  deployed: z.array(z.string()),
});

/**
 * The merge lane: on user.devmerge.requested it launches a sandbox that
 * rebases the PR onto trunk, typechecks, squash-merges via the GitHub API,
 * and deploys both Fly apps from the merged trunk. Same detached-script +
 * poll-chain harness as dev-agent, so a worker restart mid-merge (including
 * the restart its own deploy causes) resumes cleanly.
 */
export function makeDevMergeReactor(
  provider: SandboxProvider,
  config: () => DevConfig = devConfigFromEnv,
): Reactor {
  return {
    kind: "reactor",
    name: "dev-merge",
    trigger: { kind: "event", consumes: ["user.devmerge.requested"] },
    async run(_ctx, input): Promise<ReactorResult> {
      if (input.kind === "event") {
        const request = userDevmergeRequestedV1.parse(input.event.payload);
        const cfg = config();
        const runUid = randomUUID();
        return launchRun(provider, {
          reactorName: "dev-merge",
          kind: "merge",
          taskUid: request.taskUid,
          runUid,
          branch: null,
          prNumber: request.prNumber,
          files: {
            "run.sh": mergeRunScript,
            "merge.mjs": mergeFinishScript,
          },
          env: {
            DEV_REPO: cfg.repo,
            DEV_TRUNK: cfg.trunk,
            DEV_PR_NUMBER: String(request.prNumber),
            GITHUB_TOKEN: cfg.githubToken,
            FLY_DEPLOY_TOKEN_WORKER: cfg.flyDeployTokenWorker,
            FLY_DEPLOY_TOKEN_UI: cfg.flyDeployTokenUi,
          },
        });
      }
      const payload = devPollPayload.parse(input.payload);
      return pollRun(provider, "dev-merge", payload, (result) => {
        const parsed = resultSchema.safeParse(result);
        if (!parsed.success || payload.prNumber === null) {
          return { events: [], summary: "script succeeded but wrote no merge result" };
        }
        const merged: ReactorEvent = {
          type: "dev.pr.merged",
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          causedByUid: payload.taskUid,
          idempotencyKey: `dev:${payload.runUid}:merged`,
          payload: {
            taskUid: payload.taskUid,
            runUid: payload.runUid,
            prNumber: payload.prNumber,
            mergedSha: parsed.data.mergedSha,
          },
        };
        const deployed =
          parsed.data.deployed.length > 0
            ? `deployed ${parsed.data.deployed.join(", ")}`
            : "no deploys ran";
        return { events: [merged], summary: `merged; ${deployed}` };
      });
    },
  };
}

export const devMergeReactor: Reactor = makeDevMergeReactor(spritesProvider);
