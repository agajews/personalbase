import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useCached } from "../cache.js";
import { ago, BusyButton, navTo, runDuration } from "../ui.js";

const statusLabel: Record<string, string> = {
  queued: "queued",
  running: "working",
  pr_open: "PR open",
  merging: "merging",
  merged: "merged",
  failed: "failed",
  archived: "archived",
};

export function DevStatusChip({ status }: { status: string }) {
  return <span className={`dev-status dev-status-${status}`}>{statusLabel[status] ?? status}</span>;
}

export function AgentsView() {
  const { data, error: loadError, refresh } = useCached("dev-tasks", () => api.devTasks());
  const tasks = data?.tasks ?? null;
  const [spec, setSpec] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const submit = async () => {
    if (spec.trim() === "") return;
    try {
      const { taskUid } = await api.createDevTask(spec.trim());
      setSpec("");
      setSubmitError(null);
      refresh();
      // Land on the task page, where the status chip and transcript make
      // progress visible immediately.
      navTo(`/task/${taskUid}`);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    }
  };

  const error = submitError ?? loadError;

  return (
    <section className="results agents">
      <h1>Agents</h1>
      <p className="agents-hint">
        Describe a change to this system; a background agent builds it in a cloud sandbox
        and opens a PR. You approve the merge from the task page.
      </p>
      <div className="dev-new-task">
        <textarea
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          rows={5}
          placeholder="What should the agent build? Be specific about behavior and where it lives. A title is generated for you."
        />
        <BusyButton onClick={submit} disabled={spec.trim() === ""}>
          Start agent
        </BusyButton>
      </div>
      {error !== null && <div className="error">{error}</div>}
      {tasks === null && <div className="empty">loading…</div>}
      {tasks !== null && tasks.length === 0 && <div className="empty">No tasks yet.</div>}
      {tasks !== null &&
        tasks.filter((t) => t.status !== "archived").map((t) => (
          <button
            key={t.taskUid}
            className="dev-task-row"
            onClick={() => navTo(`/task/${t.taskUid}`)}
          >
            <DevStatusChip status={t.status} />
            <span className="dev-task-title">{t.title}</span>
            <span className="dev-task-meta">
              {t.latestRun?.error !== null && t.latestRun?.error !== undefined && (
                <span className="dev-task-error">{t.latestRun.error}</span>
              )}
              {t.latestRun?.summary !== null && t.latestRun?.summary !== undefined && (
                <span>{t.latestRun.summary}</span>
              )}
              {t.latestRun != null && (
                <span title={t.latestRun.finishedAt === null ? "running for" : "run took"}>
                  {runDuration(t.latestRun.startedAt, t.latestRun.finishedAt)}
                </span>
              )}
              <span>{ago(t.createdAt)}</span>
            </span>
          </button>
        ))}
      {tasks !== null && tasks.some((t) => t.status === "archived") && (
        <details className="dev-archived">
          <summary>
            Archived ({tasks.filter((t) => t.status === "archived").length})
          </summary>
          {tasks
            .filter((t) => t.status === "archived")
            .map((t) => (
              <button
                key={t.taskUid}
                className="dev-task-row archived"
                onClick={() => navTo(`/task/${t.taskUid}`)}
              >
                <DevStatusChip status={t.status} />
                <span className="dev-task-title">{t.title}</span>
                <span className="dev-task-meta">
                  <span>{ago(t.createdAt)}</span>
                </span>
              </button>
            ))}
        </details>
      )}
    </section>
  );
}
