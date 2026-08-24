import { useEffect, useRef, useState } from "react";
import { api, type ChatTraceItem } from "../api.js";

// The operator chat: ask questions over everything in the database, or ask
// for actions — the model reads with SQL and acts by appending events and
// enqueueing jobs, all recorded with source agent:chat.

interface Turn {
  role: "user" | "assistant";
  text: string;
  trace?: ChatTraceItem[];
}

export function ChatView() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [transcript, setTranscript] = useState<unknown[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, busy]);

  const send = async () => {
    const message = input.trim();
    if (message === "" || busy) {
      return;
    }
    setInput("");
    setError(null);
    setTurns((t) => [...t, { role: "user", text: message }]);
    setBusy(true);
    try {
      const result = await api.chat(transcript, message);
      setTranscript(result.transcript);
      setTurns((t) => [...t, { role: "assistant", text: result.reply, trace: result.trace }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-view">
      <div className="chat-turns">
        {turns.length === 0 && (
          <div className="empty">
            Ask about anything in the database ("find that paper I saved about dynamic
            chunking") or ask for work ("ingest arXiv 2508.12345 and add it to my
            shortlist", "start a dev task to …"). Reads are SQL; actions are events and
            jobs, all attributed to agent:chat.
          </div>
        )}
        {turns.map((turn, i) => (
          <div key={i} className={`chat-turn ${turn.role}`}>
            {turn.trace !== undefined && turn.trace.length > 0 && (
              <div className="chat-trace">
                {turn.trace.map((item, j) => (
                  <div key={j} className={`chat-trace-line ${item.isError ? "err" : ""}`}>
                    {item.summary}
                  </div>
                ))}
              </div>
            )}
            <div className="chat-bubble">{turn.text}</div>
          </div>
        ))}
        {busy && <div className="working chat-working">thinking…</div>}
        {error !== null && <div className="error">{error}</div>}
        <div ref={bottom} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Ask, or ask for work — shift-enter for a newline"
          rows={2}
          disabled={busy}
        />
        <button className="primary" type="submit" disabled={busy || input.trim() === ""}>
          Send
        </button>
      </form>
    </div>
  );
}
