import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Sql } from "@nc/log";
import { appendEvents, readEvents } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { coreRegistry } from "@nc/schema";
import { catchUpEventReactors, catchUpFold, processPendingJobs } from "@nc/process";
import { devFold } from "@nc/folds";
import { makeDevAgentReactor, makeDevMergeReactor } from "@nc/reactors";
import type { Sandbox, SandboxProvider } from "@nc/reactors";
import type { DevConfig } from "@nc/reactors";

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

class FakeSandbox implements Sandbox {
  log = "";
  exitCode: number | null = null;
  result: unknown = null;
  started: { files: Record<string, string>; env: Record<string, string> } | null = null;
  destroyed = false;

  constructor(readonly name: string) {}

  async start(
    files: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.started = { files: { ...files }, env: { ...env } };
  }

  async poll(cursor: number, maxBytes: number) {
    return {
      content: this.log.slice(cursor, cursor + maxBytes),
      exited: this.exitCode !== null,
      exitCode: this.exitCode,
      result: this.result,
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

const boxes = new Map<string, FakeSandbox>();
const provider: SandboxProvider = {
  async create(name: string): Promise<Sandbox> {
    const box = new FakeSandbox(name);
    boxes.set(name, box);
    return box;
  },
  open(name: string): Sandbox {
    const box = boxes.get(name);
    if (box === undefined) {
      throw new Error(`no fake sandbox ${name}`);
    }
    return box;
  },
};

const config = (): DevConfig => ({
  repo: "me/repo",
  trunk: "main",
  githubToken: "gh-token",
  anthropicApiKey: "api-key",
  flyDeployTokenWorker: "fly-worker",
  flyDeployTokenUi: "fly-ui",
});

const fakeTitler = async (spec: string) => ({
  title: spec.includes("fails") ? "Doomed task" : "Add a widget",
  usage: { tokensIn: 10, tokensOut: 5 },
});

const devAgent = makeDevAgentReactor(provider, config, fakeTitler);
const devMerge = makeDevMergeReactor(provider, config);

async function duePolls(): Promise<number> {
  await sql`update jobs set run_after = now() where status = 'pending'`;
  return processPendingJobs(sql, coreRegistry, [devAgent, devMerge]);
}

let taskUid: string;

describe("dev-agent flow", () => {
  test("task event launches a sandbox and streams the transcript", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.devtask.created",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: new Date().toISOString(),
        payload: { spec: "Build the widget view." },
      },
    ]);
    await catchUpEventReactors(sql, coreRegistry, [devAgent]);

    // The title is generated at launch and emitted as its own event.
    const titled = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.task.titled"],
      limit: 10,
    });
    expect(titled).toHaveLength(1);
    expect((titled[0]!.payload as { title: string }).title).toBe("Add a widget");

    const started = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.run.started"],
      limit: 10,
    });
    expect(started).toHaveLength(1);
    const payload = started[0]!.payload as { sandbox: string; branch: string; taskUid: string };
    taskUid = payload.taskUid;
    expect(payload.branch).toMatch(/^agent\/add-a-widget-/);

    const box = boxes.get(payload.sandbox)!;
    expect(box.started).not.toBeNull();
    expect(box.started!.env["GITHUB_TOKEN"]).toBe("gh-token");
    expect(box.started!.env["DEV_BRANCH"]).toBe(payload.branch);
    expect(box.started!.files["run.sh"]).toContain("claude -p");
    expect(box.started!.files["spec.md"]).toContain("Build the widget view.");

    // First poll: new log lines become a transcript chunk, chain continues.
    box.log = "[nc] cloning me/repo\nline two\n";
    expect(await duePolls()).toBe(1);
    const chunks = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.transcript.appended"],
      limit: 10,
    });
    expect(chunks).toHaveLength(1);
    expect((chunks[0]!.payload as { content: string }).content).toBe(
      "[nc] cloning me/repo\nline two\n",
    );

    // Quiet poll: nothing new, chain still continues.
    expect(await duePolls()).toBe(1);

    // Exit with a PR result: pr.opened + run.finished, sandbox destroyed.
    box.log += "[nc] done\n";
    box.exitCode = 0;
    box.result = {
      prNumber: 7,
      prUrl: "https://github.com/me/repo/pull/7",
      branch: payload.branch,
      title: "Add a widget",
    };
    expect(await duePolls()).toBe(1);
    expect(box.destroyed).toBe(true);

    const opened = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.pr.opened", "dev.run.finished"],
      limit: 10,
    });
    expect(opened.map((e) => e.type).sort()).toEqual(["dev.pr.opened", "dev.run.finished"]);

    // No further polls scheduled.
    expect(await duePolls()).toBe(0);

    await catchUpFold(sql, coreRegistry, devFold);
    const tasks = await sql`select status, title from dev_tasks`;
    expect(tasks[0]!["status"]).toBe("pr_open");
    expect(tasks[0]!["title"]).toBe("Add a widget");
    const runs = await sql`select status, pr_number, sandbox from dev_runs`;
    expect(runs[0]!["status"]).toBe("succeeded");
    expect(runs[0]!["pr_number"]).toBe(7);
    const stored = await sql`select content from dev_transcript_chunks order by chunk_seq`;
    expect(stored.length).toBeGreaterThanOrEqual(2);
  });

  test("merge approval merges the PR and deploys", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.devmerge.requested",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: new Date().toISOString(),
        payload: { taskUid, prNumber: 7 },
      },
    ]);
    await catchUpEventReactors(sql, coreRegistry, [devMerge]);

    const started = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.run.started"],
      limit: 10,
    });
    const mergeStart = started.find(
      (e) => (e.payload as { kind: string }).kind === "merge",
    )!;
    const sandboxName = (mergeStart.payload as { sandbox: string }).sandbox;
    const box = boxes.get(sandboxName)!;
    expect(box.started!.env["DEV_PR_NUMBER"]).toBe("7");
    expect(box.started!.env["FLY_DEPLOY_TOKEN_UI"]).toBe("fly-ui");

    box.log = "[nc] merged\n";
    box.exitCode = 0;
    box.result = { mergedSha: "abc123", deployed: ["personalbase-worker", "personalbase-ui"] };
    expect(await duePolls()).toBe(1);

    const merged = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.pr.merged"],
      limit: 10,
    });
    expect(merged).toHaveLength(1);
    expect((merged[0]!.payload as { mergedSha: string }).mergedSha).toBe("abc123");

    await catchUpFold(sql, coreRegistry, devFold);
    const tasks = await sql`select status from dev_tasks`;
    expect(tasks[0]!["status"]).toBe("merged");
  });

  test("nonzero exit fails the run and keeps the sandbox", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.devtask.created",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: new Date().toISOString(),
        payload: { spec: "This one fails." },
      },
    ]);
    await catchUpEventReactors(sql, coreRegistry, [devAgent]);
    const started = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.run.started"],
      limit: 10,
    });
    const last = started[started.length - 1]!;
    const box = boxes.get((last.payload as { sandbox: string }).sandbox)!;
    box.exitCode = 1;
    box.result = { error: "agent made no commits" };
    expect(await duePolls()).toBe(1);
    expect(box.destroyed).toBe(false);

    await catchUpFold(sql, coreRegistry, devFold);
    const failed = await sql`
      select status, error from dev_runs where sandbox = ${box.name}`;
    expect(failed[0]!["status"]).toBe("failed");
    expect(failed[0]!["error"]).toBe("agent made no commits");
    const tasks = await sql`
      select status from dev_tasks where title = 'Doomed task'`;
    expect(tasks[0]!["status"]).toBe("failed");
  });
});
