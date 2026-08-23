import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AppState } from "./api.js";
import { ago, HashChip, navTo } from "./ui.js";
import { FeedView } from "./views/FeedView.js";
import { FilterView } from "./views/FilterView.js";
import { EntityView } from "./views/EntityView.js";
import { SearchView } from "./views/SearchView.js";
import { TablesView } from "./views/TablesView.js";
import { MarkedView } from "./views/MarkedView.js";

type Route =
  | { kind: "feed" }
  | { kind: "filter"; name: string }
  | { kind: "filter-new" }
  | { kind: "entity"; id: string }
  | { kind: "search"; q: string }
  | { kind: "marked"; mark: "saved" | "want_to_read" }
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
  const [ingestDays, setIngestDays] = useState(3);
  const [categories, setCategories] = useState("cs.LG, cs.CL, cs.AI");

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

  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      setError(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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
            className={`filter-item ${route.kind === "marked" && route.mark === "want_to_read" ? "active" : ""}`}
            onClick={() => navTo("/want-to-read")}
          >
            <span className="filter-name">Want to read</span>
            <span className="filter-meta">
              <span className="match-count">{state?.marks.wantToRead ?? 0}</span>
            </span>
          </button>
          <button
            className={`filter-item today ${route.kind === "marked" && route.mark === "saved" ? "active" : ""}`}
            onClick={() => navTo("/saved")}
          >
            <span className="filter-name">Saved</span>
            <span className="filter-meta">
              <span className="match-count">
                {(state?.marks.saved ?? 0) + (state?.marks.wantToRead ?? 0)}
              </span>
            </span>
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

          <div className="rail-label ingest-label">Ingest arXiv</div>
          <div className="ingest">
            <label>
              window
              <select value={ingestDays} onChange={(e) => setIngestDays(Number(e.target.value))}>
                <option value={1}>last day</option>
                <option value={3}>last 3 days</option>
                <option value={7}>last 7 days</option>
              </select>
            </label>
            <label>
              categories
              <input
                value={categories}
                onChange={(e) => setCategories(e.target.value)}
                placeholder="cs.LG, cs.CL — empty for all"
              />
            </label>
            <button
              onClick={() =>
                void act(() =>
                  api.ingest(
                    ingestDays,
                    categories.split(",").map((c) => c.trim()).filter((c) => c !== ""),
                  ),
                )
              }
            >
              Ingest papers
            </button>
            <button
              title="Read the publication pages of OpenAI, DeepMind, Anthropic, and Meta"
              onClick={() => void act(() => api.ingestLabs())}
            >
              Ingest lab publications
            </button>
          </div>

          <div className="rail-label ingest-label">Database</div>
          <button
            className={`filter-item ${route.kind === "tables" ? "active" : ""}`}
            onClick={() => navTo("/tables")}
          >
            <span className="filter-name">Raw tables</span>
          </button>
        </aside>

        <main>
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
