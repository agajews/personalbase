import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  streamChatTurn,
  type ChatSummary,
  type ChatTraceItem,
  type ChatTurn,
} from "../api.js";
import { ago, navTo } from "../ui.js";

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
  const [chatUid, setChatUid] = useState<string | null>(uid);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshChats = () => void api.chats().then((r) => setChats(r.chats));
  useEffect(refreshChats, []);

  // Route → view: a different chat selected in the sidebar, or "new chat".
  useEffect(() => {
    if (uid === chatUid) {
      return;
    }
    setChatUid(uid);
    setTurns([]);
    setError(null);
    if (uid !== null) {
      void api.chatTurns(uid).then((r) => setTurns(r.turns));
    }
  }, [uid]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, busy]);

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

  // Fresh chat, nothing said yet: the large centered composer.
  const main =
    turns.length === 0 && !busy ? (
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
          {turns.map((turn, i) => (
            <div key={i} className={`chat-turn ${turn.role}`}>
              <Trace trace={turn.trace} />
              <div className="chat-bubble">
                {turn.role === "assistant" ? (
                  turn.text === "" && turn.streaming === true ? (
                    <span className="working">thinking…</span>
                  ) : (
                    <Markdown remarkPlugins={[remarkGfm]}>{turn.text}</Markdown>
                  )
                ) : (
                  turn.text
                )}
              </div>
            </div>
          ))}
          {error !== null && <div className="error">{error}</div>}
          <div ref={bottom} />
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
