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
  pr: unknown;
  idleSeconds: number;
  messages: string[];
}

class FakeSandbox implements Sandbox {
  runs = new Map<string, FakeRun>();
  destroyed = false;
  previewRunning = false;
  previewStartedWith: string | null = null;
  /** Sandbox-global like the real /nc/merge-request.json marker. */
  mergeRequest: unknown = null;

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
      pr: null,
      idleSeconds: 0,
      messages: [],
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
      pr: run.pr,
      mergeRequest: this.mergeRequest,
      idleSeconds: run.idleSeconds,
    };
  }

  async sendMessage(runDir: string, message: string): Promise<void> {
    const run = this.run(runDir);
    if (run.exitCode !== null) {
      throw new Error("session pipe is gone");
    }
    run.messages.push(message);
  }

  async endSession(runDir: string): Promise<void> {
    const run = this.run(runDir);
    if (run.exitCode === null) {
      run.exitCode = 0;
      run.result = { sessionEnded: true };
    }
  }

  async interrupt(runDir: string): Promise<void> {
    const run = this.run(runDir);
    if (run.exitCode === null) {
      run.exitCode = 130;
      run.result = { interrupted: true };
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

const boxes = new Map<string, FakeSandbox>();
const provider: SandboxProvider = {
  async create(name: string): Promise<Sandbox> {
    const existing = boxes.get(name);
    if (existing !== undefined) {
      return existing;
    }
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
  previewDatabaseUrl: "postgres://readonly@example/db",
});

const fakeTitler = async (spec: string) => ({
  title: spec.includes("fails") ? "Doomed task" : "Add a widget",
  usage: { tokensIn: 10, tokensOut: 5 },
});

const devAgent = makeDevAgentReactor(provider, config, fakeTitler);
const devMerge = makeDevMergeReactor(provider, config);

/** One daemon-ish pass: make pending jobs due, run them, fold the results. */
async function pass(): Promise<number> {
  await sql`update jobs set run_after = now() where status = 'pending'`;
  const ran = await processPendingJobs(sql, coreRegistry, [devAgent, devMerge]);
  await catchUpFold(sql, coreRegistry, devFold);
  return ran;
}

async function lastRunStarted(): Promise<{
  taskUid: string;
  runUid: string;
  sandbox: string;
  branch: string;
}> {
  const started = await readEvents(sql, coreRegistry, {
    afterSeq: 0n,
    patterns: ["dev.run.started"],
    limit: 50,
  });
  return started[started.length - 1]!.payload as {
    taskUid: string;
    runUid: string;
    sandbox: string;
    branch: string;
  };
}

let taskUid: string;
let sessionBox: FakeSandbox;
let sessionRunDir: string;

describe("dev-agent live sessions", () => {
  test("a task launches one live session that streams and announces its PR mid-run", async () => {
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
    await catchUpFold(sql, coreRegistry, devFold);

    const started = await lastRunStarted();
    taskUid = started.taskUid;
    sessionBox = boxes.get(started.sandbox)!;
    sessionRunDir = runDirFor(started.runUid);
    const turn = sessionBox.run(sessionRunDir);
    expect(turn.env["DEV_SESSION_ID"]).toBe(taskUid);
    expect(turn.files["run.sh"]).toContain("mkfifo");
    expect(turn.files["turn-end.sh"]).toContain("git push");
    expect(turn.files["prompt.md"]).toContain("Build the widget view.");

    // Output streams as chunks while the session stays alive.
    turn.log = "[nc] starting claude session (new)\nhello world\n";
    expect(await pass()).toBe(1);
    const chunks = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.transcript.appended"],
      limit: 10,
    });
    expect(chunks).toHaveLength(1);

    // The turn-end hook records the PR; the poller announces it mid-session.
    turn.pr = {
      prNumber: 7,
      prUrl: "https://github.com/me/repo/pull/7",
      branch: started.branch,
      title: "Add a widget",
    };
    expect(await pass()).toBe(1);
    const opened = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.pr.opened"],
      limit: 10,
    });
    expect(opened).toHaveLength(1);
    // Announced once; later polls do not repeat it.
    await pass();
    expect(
      await readEvents(sql, coreRegistry, {
        afterSeq: 0n,
        patterns: ["dev.pr.opened"],
        limit: 10,
      }),
    ).toHaveLength(1);

    const tasks = await sql`select status, title from dev_tasks`;
    expect(tasks[0]!["status"]).toBe("pr_open");
    expect(tasks[0]!["title"]).toBe("Add a widget");
    const runs = await sql`select status, pr_number from dev_runs`;
    expect(runs[0]!["status"]).toBe("running"); // session still alive
    expect(runs[0]!["pr_number"]).toBe(7);
    expect(sessionBox.destroyed).toBe(false);
  });

  test("a follow-up streams straight into the live session — no new run", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.devmessage.sent",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: new Date().toISOString(),
        payload: { taskUid, message: "Also show seconds.", interrupt: false },
      },
    ]);
    await catchUpEventReactors(sql, coreRegistry, [devAgent]);
    await pass();

    expect(sessionBox.run(sessionRunDir).messages).toEqual(["Also show seconds."]);
    const runs = await sql`
      select count(*)::int as n from dev_runs where task_uid = ${taskUid}`;
    expect(runs[0]!["n"]).toBe(1);
    const messages = await sql`
      select message from dev_messages where task_uid = ${taskUid}`;
    expect(messages[0]!["message"]).toBe("Also show seconds.");
  });

  test("interrupt kills the live session; a fresh run resumes it with the message", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.devmessage.sent",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: new Date().toISOString(),
        payload: { taskUid, message: "Stop — muted palette instead.", interrupt: true },
      },
    ]);
    await catchUpEventReactors(sql, coreRegistry, [devAgent]);
    for (let i = 0; i < 6; i++) {
      await pass();
    }

    const runs = await sql`
      select run_uid, status, summary, sandbox from dev_runs
      where task_uid = ${taskUid} and kind = 'feature'
      order by started_at`;
    expect(runs).toHaveLength(2);
    expect(runs[0]!["summary"]).toBe("interrupted by the user");
    expect(runs[0]!["status"]).toBe("succeeded");
    const resumed = runs[1]!;
    expect(resumed["status"]).toBe("running");
    expect(resumed["sandbox"]).toBe(sessionBox.name); // same sandbox, resumed session
    const resumedTurn = sessionBox.run(runDirFor(resumed["run_uid"]));
    expect(resumedTurn.files["prompt.md"]).toContain("muted palette");
    const preamble = await sql`
      select content from dev_transcript_chunks
      where run_uid = ${resumed["run_uid"]} and chunk_seq = 0`;
    expect(preamble[0]!["content"]).toContain("muted palette");

    // Idle sessions are closed gracefully and can be reopened later.
    resumedTurn.idleSeconds = 60 * 60;
    await pass(); // poll notices idleness and EOFs the session
    await pass(); // poll observes the exit and closes the run
    await catchUpFold(sql, coreRegistry, devFold);
    const closed = await sql`
      select status, summary from dev_runs where run_uid = ${resumed["run_uid"]}`;
    expect(closed[0]!["status"]).toBe("succeeded");
    expect(closed[0]!["summary"]).toContain("session closed");
    // Queue fully drained for later tests.
    expect(await pass()).toBe(0);
  });

  test("merge approval merges the PR, deploys, and retires the session sandbox", async () => {
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
    await catchUpFold(sql, coreRegistry, devFold);

    const mergeStart = await lastRunStarted();
    const mergeBox = boxes.get(mergeStart.sandbox)!;
    const mergeTurn = mergeBox.run(runDirFor(mergeStart.runUid));
    expect(mergeTurn.env["DEV_PR_NUMBER"]).toBe("7");
    expect(mergeTurn.env["FLY_DEPLOY_TOKEN_WORKER"]).toBe("fly-worker");
    // The UI is not a Fly app anymore (it rides the nc-main-ui sprite).
    expect(mergeTurn.env["FLY_DEPLOY_TOKEN_UI"]).toBeUndefined();

    mergeTurn.log = "[nc] merged\n";
    mergeTurn.exitCode = 0;
    mergeTurn.result = {
      mergedSha: "abc123",
      deployed: ["personalbase-worker"],
    };
    expect(await pass()).toBe(1);

    const merged = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.pr.merged"],
      limit: 10,
    });
    expect(merged).toHaveLength(1);
    expect((merged[0]!.payload as { mergedSha: string }).mergedSha).toBe("abc123");
    expect(mergeBox.destroyed).toBe(true);
    expect(sessionBox.destroyed).toBe(true);

    const tasks = await sql`select status, preview_url from dev_tasks`;
    expect(tasks[0]!["status"]).toBe("merged");
    expect(tasks[0]!["preview_url"]).toBeNull();
  });

  test("nc-request-merge routes an agent-initiated merge through the lane", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.devtask.created",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: new Date().toISOString(),
        payload: { spec: "Ship a widget and merge it yourself when asked." },
      },
    ]);
    await catchUpEventReactors(sql, coreRegistry, [devAgent]);
    await catchUpFold(sql, coreRegistry, devFold);
    const started = await lastRunStarted();
    const box = boxes.get(started.sandbox)!;
    const turn = box.run(runDirFor(started.runUid));
    expect(turn.files["request-merge.sh"]).toContain("merge-request.json");

    // The agent (on instruction) runs nc-request-merge: pr.json + marker.
    const pr = {
      prNumber: 9,
      prUrl: "https://github.com/me/repo/pull/9",
      branch: started.branch,
      title: "Ship a widget",
    };
    turn.pr = pr;
    box.mergeRequest = pr;
    await pass();
    const requested = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["agent.devmerge.requested"],
      limit: 10,
    });
    expect(requested).toHaveLength(1);
    // Forwarded once, not per poll.
    await pass();
    expect(
      (
        await readEvents(sql, coreRegistry, {
          afterSeq: 0n,
          patterns: ["agent.devmerge.requested"],
          limit: 10,
        })
      ).length,
    ).toBe(1);

    // Re-running nc-request-merge stamps a fresh requestId, so the same PR
    // can be re-requested (say, after a failed merge lane) — but the same
    // stamp is still forwarded only once.
    box.mergeRequest = { ...pr, requestId: 1_750_000_000 };
    await pass();
    await pass();
    expect(
      (
        await readEvents(sql, coreRegistry, {
          afterSeq: 0n,
          patterns: ["agent.devmerge.requested"],
          limit: 10,
        })
      ).length,
    ).toBe(2);

    // The merge lane picks it up exactly like a button press. Both requests
    // launched a lane; land them all so no poll chain leaks into later tests.
    await catchUpEventReactors(sql, coreRegistry, [devMerge]);
    await catchUpFold(sql, coreRegistry, devFold);
    const allStarted = await readEvents(sql, coreRegistry, {
      afterSeq: 0n,
      patterns: ["dev.run.started"],
      limit: 50,
    });
    const mergeStarts = allStarted
      .map((e) => e.payload as { taskUid: string; runUid: string; sandbox: string; kind: string })
      .filter((p) => p.kind === "merge" && p.taskUid === started.taskUid);
    expect(mergeStarts).toHaveLength(2);
    for (const mergeStart of mergeStarts) {
      const mergeBox = boxes.get(mergeStart.sandbox)!;
      const mergeTurn = mergeBox.run(runDirFor(mergeStart.runUid));
      expect(mergeTurn.env["DEV_PR_NUMBER"]).toBe("9");
      mergeTurn.exitCode = 0;
      mergeTurn.result = { mergedSha: "def456", deployed: ["personalbase-worker"] };
    }
    // End the feature session so the drain below settles.
    await box.endSession(runDirFor(started.runUid));
    for (let i = 0; i < 4; i++) {
      await pass();
    }
    const task = await sql`
      select status from dev_tasks where task_uid = ${started.taskUid}`;
    expect(task[0]!["status"]).toBe("merged");
    expect(box.destroyed).toBe(true);
  });

  test("a failed setup closes the run as failed and keeps the sandbox", async () => {
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
    const started = await lastRunStarted();
    const box = boxes.get(started.sandbox)!;
    const turn = box.run(runDirFor(started.runUid));
    turn.exitCode = 1;
    turn.result = { error: "clone failed" };
    expect(await pass()).toBe(1);
    expect(box.destroyed).toBe(false);

    const failed = await sql`
      select status, error from dev_runs where run_uid = ${started.runUid}`;
    expect(failed[0]!["status"]).toBe("failed");
    expect(failed[0]!["error"]).toBe("clone failed");
    const tasks = await sql`
      select status from dev_tasks where title = 'Doomed task'`;
    expect(tasks[0]!["status"]).toBe("failed");
  });

  test("archiving stops the session, destroys the sandbox, and mutes messages", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.devtask.created",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: new Date().toISOString(),
        payload: { spec: "A task to be archived mid-flight." },
      },
    ]);
    await catchUpEventReactors(sql, coreRegistry, [devAgent]);
    await catchUpFold(sql, coreRegistry, devFold);
    const started = await lastRunStarted();
    const box = boxes.get(started.sandbox)!;
    expect(box.destroyed).toBe(false);

    await appendEvents(sql, coreRegistry, [
      {
        type: "user.devtask.archived",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: new Date().toISOString(),
        payload: { taskUid: started.taskUid },
      },
    ]);
    await catchUpEventReactors(sql, coreRegistry, [devAgent]);
    await catchUpFold(sql, coreRegistry, devFold);

    expect(box.destroyed).toBe(true);
    const task = await sql`
      select status from dev_tasks where task_uid = ${started.taskUid}`;
    expect(task[0]!["status"]).toBe("archived");
    const run = await sql`
      select status, summary from dev_runs where run_uid = ${started.runUid}`;
    expect(run[0]!["status"]).toBe("succeeded");
    expect(run[0]!["summary"]).toBe("archived by the user");

    // Messages to an archived task are dropped without launching anything.
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.devmessage.sent",
        schemaVersion: 1,
        source: "ui:web",
        occurredAt: new Date().toISOString(),
        payload: { taskUid: started.taskUid, message: "hello?", interrupt: false },
      },
    ]);
    await catchUpEventReactors(sql, coreRegistry, [devAgent]);
    await pass();
    const runs = await sql`
      select count(*)::int as n from dev_runs where task_uid = ${started.taskUid}`;
    expect(runs[0]!["n"]).toBe(1);
  });
});
