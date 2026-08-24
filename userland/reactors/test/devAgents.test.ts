import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Sql } from "@nc/log";
import { appendEvents, readEvents } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { coreRegistry } from "@nc/schema";
import { catchUpEventReactors, catchUpFold, processPendingJobs } from "@nc/process";
import { devFold } from "@nc/folds";
import { makeDevAgentReactor, makeDevMergeReactor, runDirFor } from "@nc/reactors";
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

interface FakeRun {
  files: Record<string, string>;
  env: Record<string, string>;
  log: string;
  exitCode: number | null;
  result: unknown;
}

class FakeSandbox implements Sandbox {
  runs = new Map<string, FakeRun>();
  destroyed = false;
  previewRunning = false;
  previewStartedWith: string | null = null;

  constructor(readonly name: string) {}

  async url(): Promise<string | null> {
    return `https://${this.name}.sprites.app`;
  }

  async startPreview(previewDatabaseUrl: string): Promise<void> {
    this.previewStartedWith = previewDatabaseUrl;
  }

  async start(
    runDir: string,
    files: Readonly<Record<string, string>>,
    env: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.runs.set(runDir, {
      files: { ...files },
      env: { ...env },
      log: "",
      exitCode: null,
      result: null,
    });
  }

  run(runDir: string): FakeRun {
    const run = this.runs.get(runDir);
    if (run === undefined) {
      throw new Error(`no run at ${runDir}`);
    }
    return run;
  }

  async poll(runDir: string, cursor: number, maxBytes: number) {
    const run = this.run(runDir);
    return {
      content: run.log.slice(cursor, cursor + maxBytes),
      exited: run.exitCode !== null,
      exitCode: run.exitCode,
      result: run.result,
      previewRunning: this.previewRunning,
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
  previewDatabaseUrl: "postgres://readonly@example/db",
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
    const payload = started[0]!.payload as {
      sandbox: string;
      branch: string;
      taskUid: string;
      runUid: string;
    };
    taskUid = payload.taskUid;
    expect(payload.branch).toMatch(/^agent\/add-a-widget-/);

    const box = boxes.get(payload.sandbox)!;
    const turn = box.run(runDirFor(payload.runUid));
    expect(turn.env["GITHUB_TOKEN"]).toBe("gh-token");
    expect(turn.env["DEV_BRANCH"]).toBe(payload.branch);
    expect(turn.env["DEV_SESSION_ID"]).toBe(payload.taskUid);
    expect(turn.env["DEV_RESUME"]).toBe("0");
    expect(turn.files["run.sh"]).toContain("claude -p");
    expect(turn.files["prompt.md"]).toContain("Build the widget view.");

    // First poll: new log lines become a transcript chunk, chain continues.
    turn.log = "[nc] cloning me/repo\nline two\n";
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

    // The agent starts a live preview: the next poll surfaces the sandbox
    // URL exactly once.
    box.previewRunning = true;
    expect(await duePolls()).toBe(1);
    const previews = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.preview.started"],
      limit: 10,
    });
    expect(previews).toHaveLength(1);
    expect((previews[0]!.payload as { url: string }).url).toBe(
      `https://${payload.sandbox}.sprites.app`,
    );
    // The preview runs as supervised services with the read-only credentials.
    expect(box.previewStartedWith).toBe("postgres://readonly@example/db");
    // Later polls do not re-emit it.
    expect(await duePolls()).toBe(1);
    expect(
      await readEvents(sql, coreRegistry, {
        afterSeq: 0n,
        patterns: ["dev.preview.started"],
        limit: 10,
      }),
    ).toHaveLength(1);

    // Exit with a PR result: pr.opened + run.finished; the sandbox stays
    // alive so the conversation can continue.
    turn.log += "[nc] done\n";
    turn.exitCode = 0;
    turn.result = {
      prNumber: 7,
      prUrl: "https://github.com/me/repo/pull/7",
      branch: payload.branch,
      title: "Add a widget",
    };
    expect(await duePolls()).toBe(1);
    expect(box.destroyed).toBe(false);

    const opened = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.pr.opened", "dev.run.finished"],
      limit: 10,
    });
    expect(opened.map((e) => e.type).sort()).toEqual(["dev.pr.opened", "dev.run.finished"]);

    // No further polls scheduled.
    expect(await duePolls()).toBe(0);

    await catchUpFold(sql, coreRegistry, devFold);
    const tasks = await sql`select status, title, preview_url from dev_tasks`;
    expect(tasks[0]!["status"]).toBe("pr_open");
    expect(tasks[0]!["title"]).toBe("Add a widget");
    expect(tasks[0]!["preview_url"]).toBe(`https://${payload.sandbox}.sprites.app`);
    const runs = await sql`select status, pr_number, sandbox from dev_runs`;
    expect(runs[0]!["status"]).toBe("succeeded");
    expect(runs[0]!["pr_number"]).toBe(7);
    const stored = await sql`select content from dev_transcript_chunks order by chunk_seq`;
    expect(stored.length).toBeGreaterThanOrEqual(2);
  });

  test("a follow-up message resumes the session in the same sandbox", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.devmessage.sent",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: new Date().toISOString(),
        payload: { taskUid, message: "Also show seconds in the duration." },
      },
    ]);
    // The event hands off to a message job; the job launches the next turn.
    await catchUpEventReactors(sql, coreRegistry, [devAgent]);
    expect(await duePolls()).toBe(1);

    const started = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.run.started"],
      limit: 10,
    });
    expect(started).toHaveLength(2);
    const first = started[0]!.payload as { sandbox: string; branch: string };
    const second = started[1]!.payload as { sandbox: string; branch: string; runUid: string };
    // Same sandbox, same branch — the conversation continues in place.
    expect(second.sandbox).toBe(first.sandbox);
    expect(second.branch).toBe(first.branch);

    const box = boxes.get(second.sandbox)!;
    const turn = box.run(runDirFor(second.runUid));
    expect(turn.env["DEV_RESUME"]).toBe("1");
    expect(turn.env["DEV_SESSION_ID"]).toBe(taskUid);
    expect(turn.files["prompt.md"]).toContain("Also show seconds");

    // Finish the turn: same PR is re-reported, task returns to pr_open.
    turn.exitCode = 0;
    turn.result = {
      prNumber: 7,
      prUrl: "https://github.com/me/repo/pull/7",
      branch: second.branch,
      title: "Add a widget",
    };
    expect(await duePolls()).toBe(1);
    expect(box.destroyed).toBe(false);

    await catchUpFold(sql, coreRegistry, devFold);
    const tasks = await sql`select status from dev_tasks where task_uid = ${taskUid}`;
    expect(tasks[0]!["status"]).toBe("pr_open");
    const runs = await sql`
      select count(*)::int as n from dev_runs
      where task_uid = ${taskUid} and kind = 'feature' and status = 'succeeded'`;
    expect(runs[0]!["n"]).toBe(2);
    // The user's message opens the new run's transcript.
    const preamble = await sql`
      select content from dev_transcript_chunks
      where run_uid = ${second.runUid} and chunk_seq = 0`;
    expect(preamble[0]!["content"]).toContain("Also show seconds");
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
    const mergePayload = mergeStart.payload as { sandbox: string; runUid: string };
    const featureSandbox = (started[0]!.payload as { sandbox: string }).sandbox;
    const box = boxes.get(mergePayload.sandbox)!;
    const turn = box.run(runDirFor(mergePayload.runUid));
    expect(turn.env["DEV_PR_NUMBER"]).toBe("7");
    expect(turn.env["FLY_DEPLOY_TOKEN_UI"]).toBe("fly-ui");

    turn.log = "[nc] merged\n";
    turn.exitCode = 0;
    turn.result = { mergedSha: "abc123", deployed: ["personalbase-worker", "personalbase-ui"] };
    expect(await duePolls()).toBe(1);

    const merged = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.pr.merged"],
      limit: 10,
    });
    expect(merged).toHaveLength(1);
    expect((merged[0]!.payload as { mergedSha: string }).mergedSha).toBe("abc123");

    // Merge cleans up: its own sandbox and the task's conversation sandbox.
    expect(box.destroyed).toBe(true);
    expect(boxes.get(featureSandbox)!.destroyed).toBe(true);

    await catchUpFold(sql, coreRegistry, devFold);
    const tasks = await sql`select status, preview_url from dev_tasks`;
    expect(tasks[0]!["status"]).toBe("merged");
    // The sandbox died with the merge; the preview link dies with it.
    expect(tasks[0]!["preview_url"]).toBeNull();
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
    const lastPayload = last.payload as { sandbox: string; runUid: string };
    const box = boxes.get(lastPayload.sandbox)!;
    const turn = box.run(runDirFor(lastPayload.runUid));
    turn.exitCode = 1;
    turn.result = { error: "agent made no commits" };
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
