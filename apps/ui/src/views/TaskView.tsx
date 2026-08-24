import { useEffect, useRef, useState } from "react";
import { api, type DevRun, type DevTaskPage } from "../api.js";
import { ago, runDuration } from "../ui.js";
import { DevStatusChip } from "./AgentsView.js";

interface TranscriptLine {
  readonly kind: "text" | "tool" | "meta" | "plain";
  readonly text: string;
}

/** Claude Code stream-json lines become readable rows; anything else is a plain log line. */
function renderLine(raw: string): TranscriptLine | null {
  const line = raw.trim();
  if (line === "") return null;
  if (!line.startsWith("{")) return { kind: "plain", text: line };
  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      message?: { content?: unknown };
      result?: unknown;
      total_cost_usd?: number;
    };
    if (parsed.type === "system") {
      return { kind: "meta", text: `session ${parsed.subtype ?? "event"}` };
    }
    if (parsed.type === "assistant" && Array.isArray(parsed.message?.content)) {
      const parts: string[] = [];
      for (const block of parsed.message.content as {
        type?: string;
        text?: string;
        name?: string;
        input?: unknown;
      }[]) {
        if (block.type === "text" && block.text !== undefined && block.text.trim() !== "") {
          parts.push(block.text.trim());
        }
        if (block.type === "tool_use") {
          const input = JSON.stringify(block.input ?? {});
          parts.push(`⚒ ${block.name}(${input.length > 160 ? input.slice(0, 160) + "…" : input})`);
        }
      }
      if (parts.length === 0) return null;
      return {
        kind: parts[0]!.startsWith("⚒") ? "tool" : "text",
        text: parts.join("\n"),
      };
    }
    if (parsed.type === "result") {
      const cost =
        parsed.total_cost_usd !== undefined ? ` · $${parsed.total_cost_usd.toFixed(2)}` : "";
      return { kind: "meta", text: `agent finished${cost}` };
    }
    return null; // tool results and other frames stay collapsed
  } catch {
    return { kind: "plain", text: line };
  }
}

function Transcript({ run }: { run: DevRun }) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const cursor = useRef(-1);
  const buffer = useRef("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cursor.current = -1;
    buffer.current = "";
    setLines([]);
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const d = await api.devTranscript(run.runUid, cursor.current);
        if (cancelled || d.chunks.length === 0) return;
        cursor.current = d.chunks[d.chunks.length - 1]!.chunkSeq;
        const text = buffer.current + d.chunks.map((c) => c.content).join("");
        const parts = text.split("\n");
        buffer.current = parts.pop() ?? "";
        const fresh = parts
          .map(renderLine)
          .filter((l): l is TranscriptLine => l !== null);
        if (fresh.length > 0) {
          setLines((prev) => [...prev, ...fresh]);
        }
      } catch {
        // transient; next poll retries
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
  }, [run.runUid]);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines]);

  return (
    <div className="transcript" ref={box}>
      {lines.length === 0 && <div className="empty">waiting for output…</div>}
      {lines.map((l, i) => (
        <div key={i} className={`t-line t-${l.kind}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

export function TaskView({ uid }: { uid: string }) {
  const [page, setPage] = useState<DevTaskPage | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSpec, setShowSpec] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const d = await api.devTask(uid);
        if (!cancelled) {
          setPage(d);
          setError(null);
        }
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
  }, [uid]);

  if (page === null) {
    return <div className="empty">{error ?? "loading…"}</div>;
  }
  const run =
    page.runs.find((r) => r.runUid === selectedRun) ?? page.runs[page.runs.length - 1] ?? null;
  const featurePr = [...page.runs].reverse().find((r) => r.prNumber !== null);
  const mergeable = page.task.status === "pr_open" && featurePr?.prNumber != null;

  const approve = async () => {
    if (featurePr?.prNumber == null) return;
    try {
      await api.requestMerge(page.task.taskUid, featurePr.prNumber);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // The agent's session survives between turns, so the conversation is open
  // whenever the task hasn't merged.
  const conversable = ["running", "pr_open", "failed"].includes(page.task.status);
  // Messages newer than the latest turn haven't been picked up yet: show them
  // as queued so a sent message is never invisibly in limbo.
  const latestFeatureStart = page.runs
    .filter((r) => r.kind === "feature")
    .reduce((max, r) => Math.max(max, new Date(r.startedAt).getTime()), 0);
  const queued = page.messages.filter(
    (m) => new Date(m.at).getTime() > latestFeatureStart,
  );
  const send = async () => {
    if (message.trim() === "") return;
    try {
      await api.sendDevMessage(page.task.taskUid, message.trim());
      setSent(
        page.task.status === "running"
          ? "sent — the agent picks this up when its current turn finishes"
          : "sent — a new turn starts within seconds",
      );
      setMessage("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="results task-page">
      <div className="task-header">
        <DevStatusChip status={page.task.status} />
        <h1>{page.task.title}</h1>
      </div>
      <div className="task-actions">
        {page.task.previewUrl !== null && page.task.status !== "merged" && (
          <a
            className="preview-link"
            href={page.task.previewUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open live preview ↗
          </a>
        )}
        {featurePr?.prUrl != null && (
          <a href={featurePr.prUrl} target="_blank" rel="noreferrer">
            PR #{featurePr.prNumber}
            {featurePr.prTitle !== null ? ` — ${featurePr.prTitle}` : ""}
          </a>
        )}
        {mergeable && (
          <button onClick={() => void approve()}>Approve merge &amp; deploy</button>
        )}
        <button className="ghost" onClick={() => setShowSpec((s) => !s)}>
          {showSpec ? "hide spec" : "show spec"}
        </button>
      </div>
      {showSpec && <pre className="task-spec">{page.task.spec}</pre>}
      {error !== null && <div className="error">{error}</div>}
      {page.runs.length > 1 && (
        <div className="task-runs">
          {page.runs.map((r) => (
            <button
              key={r.runUid}
              className={`run-tab ${run?.runUid === r.runUid ? "active" : ""}`}
              onClick={() => setSelectedRun(r.runUid)}
            >
              {r.kind} · {r.status} · {ago(r.startedAt)}
            </button>
          ))}
        </div>
      )}
      {run !== null && (
        <>
          <div className="run-facts">
            <span>
              {run.kind} run in <code>{run.sandbox}</code>
            </span>
            <span title={run.finishedAt === null ? "running for" : "run took"}>
              {runDuration(run.startedAt, run.finishedAt)}
            </span>
            {run.branch !== null && <code>{run.branch}</code>}
            {run.error !== null && <span className="dev-task-error">{run.error}</span>}
            {run.summary !== null && <span>{run.summary}</span>}
          </div>
          <Transcript run={run} />
        </>
      )}
      {run === null && <div className="empty">No runs yet — the worker picks this up within seconds.</div>}
      {queued.length > 0 && (
        <div className="dev-queued">
          {queued.map((m) => (
            <div key={m.msgUid} className="dev-queued-msg">
              <span className="dev-queued-label">queued {ago(m.at)}</span>
              <span>{m.message}</span>
            </div>
          ))}
          <div className="dev-composer-hint">
            The agent picks these up when its current turn finishes.
          </div>
        </div>
      )}
      {conversable && (
        <div className="dev-composer">
          <textarea
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setSent(null);
            }}
            rows={2}
            placeholder="Send the agent a follow-up or clarification — it resumes the same session on the same branch."
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          <div className="dev-composer-row">
            <button onClick={() => void send()} disabled={message.trim() === ""}>
              Send to agent
            </button>
            {sent !== null && <span className="dev-composer-hint">{sent}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
