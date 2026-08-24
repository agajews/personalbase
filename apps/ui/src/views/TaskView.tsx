import { useEffect, useRef, useState } from "react";
import { api, type DevRun, type DevTaskPage } from "../api.js";
import { cmdEnter, MathMarkdown, runDuration } from "../ui.js";
import { DevStatusChip } from "./AgentsView.js";

interface TranscriptLine {
  readonly kind: "text" | "tool" | "meta" | "plain";
  readonly text: string;
}

/** Claude Code stream-json lines become readable rows; anything else is a plain log line. */
function renderLines(raw: string): TranscriptLine[] {
  const line = raw.trim();
  if (line === "") return [];
  if (!line.startsWith("{")) {
    // Real log lines are short script echoes or stray tool errors. Anything
    // long or JSON-shaped is a fragment of a stream-json frame that was
    // split across poll chunks (file Read bytes, thinking tails, …) — drop.
    if (line.length > 300 || line.includes('":')) return [];
    return [{ kind: "plain", text: line }];
  }
  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      message?: { content?: unknown };
      result?: unknown;
      total_cost_usd?: number;
    };
    if (parsed.type === "system") {
      // System frames are mostly internal bookkeeping (thinking_tokens,
      // task_started, …) emitted constantly; only session start is news.
      return parsed.subtype === "init" ? [{ kind: "meta", text: "session started" }] : [];
    }
    if (parsed.type === "assistant" && Array.isArray(parsed.message?.content)) {
      const parts: TranscriptLine[] = [];
      for (const block of parsed.message.content as {
        type?: string;
        text?: string;
        name?: string;
        input?: unknown;
      }[]) {
        // "thinking" / "redacted_thinking" blocks are deliberately hidden —
        // the conversation shows what the agent says and does, not its
        // scratchpad.
        if (block.type === "text" && block.text !== undefined && block.text.trim() !== "") {
          parts.push({ kind: "text", text: block.text.trim() });
        }
        // tool_use blocks (the commands the agent runs) are hidden — the
        // conversation shows what the agent says; its work shows up in the
        // preview and the PR.
      }
      return parts;
    }
    if (parsed.type === "result") {
      const cost =
        parsed.total_cost_usd !== undefined ? ` · $${parsed.total_cost_usd.toFixed(2)}` : "";
      return [{ kind: "meta", text: `agent finished${cost}` }];
    }
    return []; // tool results and other frames stay collapsed
  } catch {
    // Looked like JSON but didn't parse: a truncated frame, not prose.
    return [];
  }
}

function Transcript({ run }: { run: DevRun }) {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  // Tool commands are hidden, but their heartbeat drives the ephemeral
  // "working…" indicator: the arrival time of the last chunk that carried
  // tool activity.
  const [lastTool, setLastTool] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const cursor = useRef(-1);
  const buffer = useRef("");
  const box = useRef<HTMLDivElement>(null);

  const live = run.status === "running";
  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [live]);

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
        if (text.includes('"type":"tool_use"')) {
          setLastTool(new Date(d.chunks[d.chunks.length - 1]!.at).getTime());
        }
        const parts = text.split("\n");
        buffer.current = parts.pop() ?? "";
        const fresh = parts.flatMap(renderLines);
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

  const sinceTool =
    lastTool === null ? null : Math.max(0, Math.floor((now - lastTool) / 1000));
  return (
    <div className="transcript" ref={box}>
      {lines.length === 0 && !live && <div className="empty">no output</div>}
      {lines.map((l, i) =>
        l.kind === "text" ? (
          <div key={i} className="t-line t-text t-markdown">
            <MathMarkdown>{l.text}</MathMarkdown>
          </div>
        ) : (
          <div key={i} className={`t-line t-${l.kind}`}>
            {l.text}
          </div>
        ),
      )}
      {live && (
        <div className="t-line t-working">
          working<span className="working-dots" />
          {sinceTool !== null && (
            <span className="working-since"> ({sinceTool}s since last command)</span>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskView({ uid }: { uid: string }) {
  const [page, setPage] = useState<DevTaskPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSpec, setShowSpec] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  // Optimistic echo: sent messages render immediately and are dropped once
  // the folded copy arrives from the server.
  const [pending, setPending] = useState<{ text: string; at: number }[]>([]);
  // Debounces both the button and the cmd-enter path across renders.
  const sendingRef = useRef(false);

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
  // One continuous conversation: every run (Claude session segments plus any
  // merge runs) and every user message, interleaved chronologically.
  const conversation: (
    | { kind: "run"; at: number; run: DevRun }
    | { kind: "message"; at: number; msgUid: string; text: string }
  )[] = [
    ...page.runs.map((r) => ({
      kind: "run" as const,
      at: new Date(r.startedAt).getTime(),
      run: r,
    })),
    ...page.messages.map((m) => ({
      kind: "message" as const,
      at: new Date(m.at).getTime(),
      msgUid: m.msgUid,
      text: m.message,
    })),
    ...pending
      .filter((p) => !page.messages.some((m) => m.message === p.text))
      .map((p, i) => ({
        kind: "message" as const,
        at: p.at,
        msgUid: `pending-${i}`,
        text: p.text,
      })),
  ].sort((a, b) => a.at - b.at);
  const featurePr = [...page.runs].reverse().find((r) => r.prNumber !== null);
  // With live sessions a task sits at 'running' even while its PR is open,
  // so mergeability follows the PR, not the status.
  const mergeable =
    featurePr?.prNumber != null &&
    !["merged", "merging", "archived"].includes(page.task.status);

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
  const turnActive = page.runs.some((r) => r.status === "running");
  const send = async (interrupt: boolean) => {
    if (message.trim() === "" || sendingRef.current) return;
    sendingRef.current = true;
    const text = message.trim();
    setPending((prev) => [...prev, { text, at: Date.now() }]);
    try {
      await api.sendDevMessage(page.task.taskUid, text, interrupt);
      setSent(
        interrupt
          ? "sent — interrupting the current turn"
          : turnActive
            ? "sent — streaming into the live session"
            : "sent — reopening the session",
      );
      setMessage("");
      setError(null);
    } catch (e) {
      setPending((prev) => prev.filter((p) => p.text !== text));
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      sendingRef.current = false;
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
        {page.task.status !== "archived" && page.task.status !== "merged" && (
          <button
            className="ghost archive-button"
            title="Stop the agent, destroy its sandbox, and move this task to the archived list."
            onClick={() => {
              if (window.confirm("Archive this task? The agent stops and its sandbox is destroyed.")) {
                void api
                  .archiveDevTask(page.task.taskUid)
                  .catch((e) => setError(e instanceof Error ? e.message : String(e)));
              }
            }}
          >
            Archive
          </button>
        )}
      </div>
      {showSpec && <pre className="task-spec">{page.task.spec}</pre>}
      {error !== null && <div className="error">{error}</div>}
      {conversation.length === 0 && (
        <div className="empty">No runs yet — the worker picks this up within seconds.</div>
      )}
      {conversation.map((item) =>
        item.kind === "message" ? (
          <div key={item.msgUid} className="dev-user-msg">
            <span className="dev-queued-label">you</span>
            <span>{item.text}</span>
          </div>
        ) : (
          <div key={item.run.runUid} className="conversation-run">
            <div className="run-facts">
              <span>
                {item.run.kind === "merge" ? "merge run" : "session"} in{" "}
                <code>{item.run.sandbox}</code>
              </span>
              <span title={item.run.finishedAt === null ? "running for" : "took"}>
                {runDuration(item.run.startedAt, item.run.finishedAt)}
              </span>
              {item.run.error !== null && (
                <span className="dev-task-error">{item.run.error}</span>
              )}
              {item.run.summary !== null && <span>{item.run.summary}</span>}
            </div>
            <Transcript run={item.run} />
          </div>
        ),
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
            onKeyDown={cmdEnter(() => void send(false))}
          />
          <div className="dev-composer-row">
            <button onClick={() => void send(false)} disabled={message.trim() === ""}>
              Send to agent
            </button>
            {turnActive && (
              <button
                className="interrupt-button"
                onClick={() => void send(true)}
                disabled={message.trim() === ""}
                title="Stop the current turn and deliver this message immediately; work so far is kept."
              >
                Interrupt &amp; send
              </button>
            )}
            {sent !== null && <span className="dev-composer-hint">{sent}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
