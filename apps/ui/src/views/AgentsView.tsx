import { useEffect, useState } from "react";
import { api, type DevTaskListItem } from "../api.js";
import { ago, navTo } from "../ui.js";

const statusLabel: Record<string, string> = {
  queued: "queued",
  running: "working",
  pr_open: "PR open",
  merging: "merging",
  merged: "merged",
  failed: "failed",
};

export function DevStatusChip({ status }: { status: string }) {
  return <span className={`dev-status dev-status-${status}`}>{statusLabel[status] ?? status}</span>;
}

export function AgentsView() {
  const [tasks, setTasks] = useState<DevTaskListItem[] | null>(null);
  const [spec, setSpec] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const d = await api.devTasks();
        if (!cancelled) setTasks(d.tasks);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tick]);

  const submit = async () => {
    if (spec.trim() === "") return;
    try {
      await api.createDevTask(spec.trim());
      setSpec("");
      setError(null);
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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
        <button onClick={() => void submit()} disabled={spec.trim() === ""}>
          Start agent
        </button>
      </div>
      {error !== null && <div className="error">{error}</div>}
      {tasks === null && <div className="empty">loading…</div>}
      {tasks !== null && tasks.length === 0 && <div className="empty">No tasks yet.</div>}
      {tasks !== null &&
        tasks.map((t) => (
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
              <span>{ago(t.createdAt)}</span>
            </span>
          </button>
        ))}
    </section>
  );
}
