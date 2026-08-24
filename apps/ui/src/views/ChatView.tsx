import { useEffect, useState } from "react";
import {
  api,
  streamChatTurn,
  type ChatQuestion,
  type ChatSummary,
  type ChatTraceItem,
  type ChatTurn,
} from "../api.js";
import { ago, formatDay, MathMarkdown, navTo } from "../ui.js";

// The operator chat. Conversations live in the database (chat events folded
// into chats/chat_turns); this view streams new turns over SSE and renders
// assistant replies as markdown.

interface LiveTurn extends ChatTurn {
  streaming?: boolean;
}

function Trace({ trace }: { trace: ChatTraceItem[] }) {
  if (trace.length === 0) {
    return null;
  }
  return (
    <div className="chat-trace">
      {trace.map((item, i) => (
        <div key={i} className={`chat-trace-line ${item.isError ? "err" : ""}`}>
          {item.summary}
        </div>
      ))}
    </div>
  );
}

function Composer({
  large,
  input,
  setInput,
  busy,
  onSend,
}: {
  large: boolean;
  input: string;
  setInput: (v: string) => void;
  busy: boolean;
  onSend: () => void;
}) {
  return (
    <form
      className={large ? "chat-composer large" : "chat-composer"}
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={
          large
            ? "Ask about anything in the database, or ask for work…"
            : "Reply — shift-enter for a newline"
        }
        rows={large ? 4 : 2}
        disabled={busy}
        autoFocus
      />
      <button className="primary" type="submit" disabled={busy || input.trim() === ""}>
        Send
      </button>
    </form>
  );
}

function ChatHistory({
  chats,
  activeUid,
}: {
  chats: ChatSummary[];
  activeUid: string | null;
}) {
  return (
    <aside className="chat-history">
      <button className="ghost" onClick={() => navTo("/chat")}>
        + New chat
      </button>
      {chats.map((ch) => (
        <button
          key={ch.chatUid}
          className={`chat-history-item ${ch.chatUid === activeUid ? "active" : ""}`}
          onClick={() => navTo(`/chat/${ch.chatUid}`)}
          title={ch.title}
        >
          <span className="chat-history-title">{ch.title}</span>
          <span className="chat-history-when">{ago(ch.lastAt)}</span>
        </button>
      ))}
    </aside>
  );
}

export function ChatView({ uid }: { uid: string | null }) {
  // chatUid starts null even when uid is set, so the route effect below
  // always fetches on a fresh mount (initializing it to uid made the effect
  // skip the load and show the blank-chat home for existing chats).
  const [chatUid, setChatUid] = useState<string | null>(null);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [question, setQuestion] = useState<ChatQuestion | null>(null);
  const [loading, setLoading] = useState(uid !== null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshChats = () =>
    void api
      .chats()
      .then((r) => setChats(r.chats))
      .catch((e) => console.error("chat list fetch failed", e));
  // Refresh on mount, on chat switch, and on a light interval — a single
  // failed fetch (e.g. mid-restart) must not leave the rail empty forever.
  useEffect(() => {
    refreshChats();
    const timer = setInterval(refreshChats, 20_000);
    return () => clearInterval(timer);
  }, [uid]);

  // Route → view: initial mount, a different chat selected in the sidebar,
  // or "new chat". The guard only skips the self-assignment send() makes when
  // it mints a uid and updates the hash mid-stream.
  useEffect(() => {
    if (uid === chatUid) {
      return;
    }
    setChatUid(uid);
    setTurns([]);
    setQuestion(null);
    setError(null);
    if (uid !== null) {
      setLoading(true);
      void api
        .chatTurns(uid)
        .then((r) => {
          setTurns(r.turns);
          setQuestion(r.question);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    }
  }, [uid]);

  const send = async () => {
    const message = input.trim();
    if (message === "" || busy) {
      return;
    }
    let activeUid = chatUid;
    if (activeUid === null) {
      activeUid = crypto.randomUUID();
      setChatUid(activeUid);
      // Update the URL without remounting (App keys this view stably).
      location.hash = `/chat/${activeUid}`;
    }
    setInput("");
    setError(null);
    setBusy(true);
    setTurns((t) => [
      ...t,
      { role: "user", text: message, trace: [] },
      { role: "assistant", text: "", trace: [], streaming: true },
    ]);
    const patchLast = (patch: (turn: LiveTurn) => LiveTurn) =>
      setTurns((t) => [...t.slice(0, -1), patch(t[t.length - 1]!)]);
    try {
      for await (const event of streamChatTurn(activeUid, message)) {
        if (event.type === "delta") {
          patchLast((turn) => ({ ...turn, text: turn.text + event.text }));
        } else if (event.type === "tool") {
          patchLast((turn) => ({ ...turn, trace: [...turn.trace, event.item] }));
        } else if (event.type === "done") {
          patchLast((turn) => ({ ...turn, text: event.reply, streaming: false }));
          refreshChats();
        } else {
          setError(event.message);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      patchLast((turn) => ({ ...turn, streaming: false }));
    }
  };

  // A study question's chat pins the exercise above the thread; the tutor on
  // the other end sees the same question.
  const questionCard =
    question === null ? null : (
      <div className="chat-question">
        <div className="chat-question-head">
          {question.topic} · level {question.level} · {formatDay(question.day)}
        </div>
        <MathMarkdown>{question.question}</MathMarkdown>
        <div className="chat-question-notes">{question.notes}</div>
      </div>
    );

  // Fresh chat, nothing said yet: the large centered composer — unless this
  // is a question chat, which opens straight onto the exercise, or we are
  // still loading an existing chat (showing home would flash the wrong view).
  const main = loading ? (
    <div className="chat-view">
      <span className="working">loading…</span>
    </div>
  ) : turns.length === 0 && !busy && question === null ? (
      <div className="chat-home">
        <h1 className="chat-home-title">What are we looking for?</h1>
        <p className="chat-home-sub">
          Reads are SQL over everything in the database; actions are events and jobs.
          "Find that paper I saved about dynamic chunking" · "Ingest arXiv 2508.12345
          and shortlist it" · "Start a dev task to …"
        </p>
        <Composer large input={input} setInput={setInput} busy={busy} onSend={() => void send()} />
        {error !== null && <div className="error">{error}</div>}
      </div>
    ) : (
      <div className="chat-view">
        <div className="chat-turns">
          {questionCard}
          {turns.map((turn, i) => (
            <div key={i} className={`chat-turn ${turn.role}`}>
              <Trace trace={turn.trace} />
              <div className="chat-bubble">
                {turn.role === "assistant" ? (
                  turn.text === "" && turn.streaming === true ? (
                    <span className="working">thinking…</span>
                  ) : (
                    <MathMarkdown>{turn.text}</MathMarkdown>
                  )
                ) : (
                  turn.text
                )}
              </div>
            </div>
          ))}
          {error !== null && <div className="error">{error}</div>}
        </div>
        <Composer large={false} input={input} setInput={setInput} busy={busy} onSend={() => void send()} />
      </div>
    );

  return (
    <div className="chat-layout">
      <div className="chat-main">{main}</div>
      <ChatHistory chats={chats} activeUid={chatUid} />
    </div>
  );
}
