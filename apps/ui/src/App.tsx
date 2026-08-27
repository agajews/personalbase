import { useCallback, useEffect, useRef, useState } from "react";
import { api, graphModeLabels, type AppState, type GraphMode } from "./api.js";
import { ago, HashChip, navTo } from "./ui.js";
import { LinkBox } from "./LinkBox.js";
import { FeedView } from "./views/FeedView.js";
import { FilterView } from "./views/FilterView.js";
import { EntityView } from "./views/EntityView.js";
import { SearchView } from "./views/SearchView.js";
import { TablesView } from "./views/TablesView.js";
import { MarkedView } from "./views/MarkedView.js";
import { PapersView } from "./views/PapersView.js";
import { AgentsView } from "./views/AgentsView.js";
import { TaskView } from "./views/TaskView.js";
import { TopicsView } from "./views/TopicsView.js";
import { GraphView } from "./views/GraphView.js";
import { TagView } from "./views/TagView.js";
import { ChatView } from "./views/ChatView.js";

type Route =
  | { kind: "feed" }
  | { kind: "filter"; name: string }
  | { kind: "filter-new" }
  | { kind: "entity"; id: string }
  | { kind: "search"; q: string }
  | { kind: "marked"; mark: "saved" | "want_to_read" }
  | { kind: "papers"; category: string | null }
  | { kind: "agents" }
  | { kind: "task"; uid: string }
  | { kind: "topics"; slug: string | null }
  | { kind: "graph"; mode: GraphMode; selected: string | null; paper: string | null }
  | { kind: "tag"; slug: string }
  | { kind: "chat"; uid: string | null }
  | { kind: "tables"; table: string | null };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  switch (parts[0]) {
    case "filter":
      return parts[1] !== undefined && parts[1] !== ""
        ? { kind: "filter", name: decodeURIComponent(parts[1]) }
        : { kind: "feed" };
    case "filter-new":
      return { kind: "filter-new" };
    case "entity":
      return parts[1] !== undefined
        ? { kind: "entity", id: parts[1] }
        : { kind: "feed" };
    case "search":
      return { kind: "search", q: decodeURIComponent(parts.slice(1).join("/")) };
    case "papers":
      return {
        kind: "papers",
        category:
          parts[1] !== undefined && parts[1] !== "" ? decodeURIComponent(parts[1]) : null,
      };
    case "agents":
      return { kind: "agents" };
    case "task":
      return parts[1] !== undefined && parts[1] !== ""
        ? { kind: "task", uid: parts[1] }
        : { kind: "agents" };
    case "chat":
      return {
        kind: "chat",
        uid: parts[1] !== undefined && parts[1] !== "" ? parts[1] : null,
      };
    case "tag":
      return parts[1] !== undefined && parts[1] !== ""
        ? { kind: "tag", slug: decodeURIComponent(parts[1]) }
        : { kind: "graph", mode: "tags", selected: null, paper: null };
    case "graph": {
      // #/graph/<mode>[/<key> | /paper/<id>] — the mode picks what the nodes are.
      const mode: GraphMode =
        parts[1] !== undefined && parts[1] in graphModeLabels ? (parts[1] as GraphMode) : "tags";
      if (parts[2] === "paper" && parts[3] !== undefined && parts[3] !== "") {
        return { kind: "graph", mode, selected: null, paper: parts[3] };
      }
      return {
        kind: "graph",
        mode,
        selected: parts[2] !== undefined && parts[2] !== "" ? decodeURIComponent(parts[2]) : null,
        paper: null,
      };
    }
    case "topics":
      return {
        kind: "topics",
        slug: parts[1] !== undefined && parts[1] !== "" ? decodeURIComponent(parts[1]) : null,
      };
    case "saved":
      return { kind: "marked", mark: "saved" };
    case "want-to-read":
      return { kind: "marked", mark: "want_to_read" };
    case "tables":
      return { kind: "tables", table: parts[1] !== undefined && parts[1] !== "" ? parts[1] : null };
    default:
      return { kind: "feed" };
  }
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute(location.hash));
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const stateInFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (stateInFlight.current) {
      return;
    }
    stateInFlight.current = true;
    try {
      const s = await api.state();
      setState(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      stateInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const ingesting = state?.jobs.some(
    (j) => j.process === "reactor:arxiv" || j.process === "reactor:lab-publications",
  );

  return (
    <div className="frame">
      <header>
        <a className="wordmark" href="#/">
          personalbase
        </a>
        <span className="header-facts">
          {state !== null && (
            <>
              <span>{state.papers.total} papers in the log</span>
              <span className="dot">·</span>
              <span>newest {ago(state.papers.latest)}</span>
              {ingesting === true && <span className="working">ingesting…</span>}
            </>
          )}
        </span>
      </header>

      <div className="columns">
        <aside>
          <LinkBox onSubmitted={refresh} />

          <form
            className="search-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim() !== "") {
                navTo(`/search/${encodeURIComponent(query.trim())}`);
              }
            }}
          >
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search papers, people, orgs"
            />
          </form>

          <button
            className={`filter-item ${route.kind === "feed" ? "active" : ""}`}
            onClick={() => navTo("/")}
          >
            <span className="filter-name">Today</span>
          </button>
          <button
            className={`filter-item ${route.kind === "chat" ? "active" : ""}`}
            onClick={() => navTo("/chat")}
          >
            <span className="filter-name">Chat</span>
          </button>
          <button
            className={`filter-item ${route.kind === "marked" && route.mark === "want_to_read" ? "active" : ""}`}
            onClick={() => navTo("/want-to-read")}
          >
            <span className="filter-name">Want to read</span>
            <span className="filter-meta">
              <span className="match-count">{state?.marks.wantToRead ?? 0}</span>
            </span>
          </button>
          <button
            className={`filter-item ${route.kind === "marked" && route.mark === "saved" ? "active" : ""}`}
            onClick={() => navTo("/saved")}
          >
            <span className="filter-name">Saved</span>
            <span className="filter-meta">
              <span className="match-count">
                {(state?.marks.saved ?? 0) + (state?.marks.wantToRead ?? 0)}
              </span>
            </span>
          </button>
          <button
            className={`filter-item ${route.kind === "papers" ? "active" : ""}`}
            onClick={() => navTo("/papers")}
          >
            <span className="filter-name">All papers</span>
            <span className="filter-meta">
              <span className="match-count">{state?.papers.total ?? 0}</span>
            </span>
          </button>
          <button
            className={`filter-item ${route.kind === "topics" ? "active" : ""}`}
            onClick={() => navTo("/topics")}
          >
            <span className="filter-name">Topics</span>
          </button>
          <button
            className={`filter-item ${route.kind === "graph" || route.kind === "tag" ? "active" : ""}`}
            onClick={() => navTo("/graph")}
          >
            <span className="filter-name">Graph</span>
          </button>
          <button
            className={`filter-item today ${route.kind === "agents" || route.kind === "task" ? "active" : ""}`}
            onClick={() => navTo("/agents")}
          >
            <span className="filter-name">Agents</span>
          </button>

          <div className="rail-label">Filters</div>
          <nav>
            {state?.filters.map((f) => (
              <button
                key={f.name}
                className={`filter-item ${route.kind === "filter" && route.name === f.name ? "active" : ""}`}
                onClick={() => navTo(`/filter/${encodeURIComponent(f.name)}`)}
              >
                <span className="filter-name">{f.name}</span>
                <span className="filter-meta">
                  <HashChip hash={f.promptHash} />
                  <span className="match-count">{f.matches} match</span>
                </span>
              </button>
            ))}
          </nav>
          <button className="ghost" onClick={() => navTo("/filter-new")}>
            + New filter
          </button>

          <div className="rail-label ingest-label">Database</div>
          <button
            className={`filter-item ${route.kind === "tables" ? "active" : ""}`}
            onClick={() => navTo("/tables")}
          >
            <span className="filter-name">Raw tables</span>
          </button>
        </aside>

        <main className={route.kind === "graph" ? "wide" : ""}>
          {route.kind === "feed" && state !== null && <FeedView filters={state.filters} />}
          {(route.kind === "filter" || route.kind === "filter-new") && state !== null && (
            <FilterView
              name={route.kind === "filter" ? route.name : null}
              creating={route.kind === "filter-new"}
              state={state}
              refresh={refresh}
              onSaved={(name) => navTo(`/filter/${encodeURIComponent(name)}`)}
              onError={setError}
            />
          )}
          {route.kind === "entity" && <EntityView id={route.id} />}
          {route.kind === "search" && <SearchView q={route.q} />}
          {route.kind === "marked" && <MarkedView mark={route.mark} />}
          {route.kind === "papers" && <PapersView category={route.category} />}
          {route.kind === "agents" && <AgentsView />}
          {route.kind === "task" && <TaskView uid={route.uid} />}
          {route.kind === "topics" && <TopicsView slug={route.slug} state={state} />}
          {route.kind === "tag" && <TagView slug={route.slug} />}
          {route.kind === "graph" && (
            <GraphView
              mode={route.mode}
              selected={route.selected}
              paper={route.paper}
              state={state}
            />
          )}
          {route.kind === "chat" && <ChatView key="chat" uid={route.uid} />}
          {route.kind === "tables" && <TablesView table={route.table} />}
          {error !== null && <div className="error">{error}</div>}
        </main>
      </div>

      <footer>
        {state?.tail.map((e) => (
          <div key={e.seq} className="tail-line">
            <span className="tail-seq">{e.seq}</span>
            <span className="tail-type">{e.type}</span>
            <span className="tail-source">{e.source}</span>
            <span className="tail-time">{ago(e.occurred_at)}</span>
          </div>
        ))}
      </footer>
    </div>
  );
}
