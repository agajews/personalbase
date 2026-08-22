import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  previewHash,
  type AppState,
  type Feed,
  type FeedItem,
  type FilterSummary,
  type Results,
  type Verdict,
} from "./api.js";

function hashHue(hash: string): number {
  return parseInt(hash.slice(0, 6), 16) % 360;
}

function HashChip({ hash, label }: { hash: string; label?: string }) {
  const h = hashHue(hash);
  return (
    <span
      className="hash-chip"
      style={{
        color: `hsl(${h} 45% 30%)`,
        background: `hsl(${h} 50% 93%)`,
        borderColor: `hsl(${h} 35% 78%)`,
      }}
    >
      {label !== undefined && <span className="hash-chip-label">{label}</span>}#{hash.slice(0, 6)}
    </span>
  );
}

function ago(iso: string | null): string {
  if (iso === null) {
    return "never";
  }
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function VerdictRow({ verdict, hue, open }: { verdict: Verdict; hue: number; open: boolean }) {
  return (
    <details className="verdict" open={open}>
      <summary>
        <span className="confidence" title={`confidence ${verdict.confidence.toFixed(2)}`}>
          <span
            className="confidence-fill"
            style={{ width: `${verdict.confidence * 100}%`, background: `hsl(${hue} 45% 42%)` }}
          />
        </span>
        <span className="verdict-title">{verdict.title}</span>
        {verdict.orgs.map((org) => (
          <span key={org} className="org-chip">
            {org}
          </span>
        ))}
        <a
          className="arxiv-id"
          href={`https://arxiv.org/abs/${verdict.arxivId}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {verdict.arxivId}
        </a>
      </summary>
      {verdict.authors.length > 0 && (
        <p className="verdict-authors">{verdict.authors.join(", ")}</p>
      )}
      <p className="verdict-reason">{verdict.reason}</p>
      <p className="verdict-abstract">{verdict.abstract}</p>
    </details>
  );
}

function FeedRow({
  item,
  hueFor,
}: {
  item: FeedItem;
  hueFor: (filter: string) => number;
}) {
  const top = item.matches[0];
  return (
    <details className="verdict" open={false}>
      <summary>
        <span
          className="confidence"
          title={top === undefined ? "surfaced by lab" : `confidence ${top.confidence.toFixed(2)}`}
        >
          {top !== undefined && (
            <span
              className="confidence-fill"
              style={{ width: `${top.confidence * 100}%`, background: `hsl(${hueFor(top.filter)} 45% 42%)` }}
            />
          )}
        </span>
        <span className="verdict-title">{item.title}</span>
        {item.labs.map((lab) => (
          <span key={lab} className="org-chip">
            {lab}
          </span>
        ))}
        {item.matches.map((m) => (
          <span
            key={m.filter}
            className="hash-chip"
            style={{
              color: `hsl(${hueFor(m.filter)} 45% 30%)`,
              background: `hsl(${hueFor(m.filter)} 50% 93%)`,
              borderColor: `hsl(${hueFor(m.filter)} 35% 78%)`,
            }}
          >
            {m.filter}
          </span>
        ))}
        <a
          className="arxiv-id"
          href={`https://arxiv.org/abs/${item.arxivId}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {item.arxivId}
        </a>
      </summary>
      {item.authors.length > 0 && <p className="verdict-authors">{item.authors.join(", ")}</p>}
      {top !== undefined && <p className="verdict-reason">{top.reason}</p>}
      <p className="verdict-abstract">{item.abstract}</p>
    </details>
  );
}

/** Items arrive sorted by publication date desc; preserve order, bucket by day. */
function groupByPublicationDay(items: FeedItem[]): [string, FeedItem[]][] {
  const groups: [string, FeedItem[]][] = [];
  for (const item of items) {
    const day = new Date(item.publishedAt).toISOString().slice(0, 10);
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0] === day) {
      last[1].push(item);
    } else {
      groups.push([day, [item]]);
    }
  }
  return groups;
}

function formatDay(day: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (day === today) {
    return "today";
  }
  const date = new Date(`${day}T12:00:00Z`);
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

const newFilter: FilterSummary = {
  name: "",
  model: "claude-opus-5",
  prompt: "",
  promptHash: "",
  matches: 0,
  rejects: 0,
};

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<"feed" | "filter">("feed");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [results, setResults] = useState<Results | null>(null);
  const [draft, setDraft] = useState({ name: "", model: "", prompt: "" });
  const [nextHash, setNextHash] = useState("");
  const [days, setDays] = useState(3);
  const [ingestDays, setIngestDays] = useState(3);
  const [categories, setCategories] = useState("cs.LG");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const filter = useMemo(
    () =>
      creating ? newFilter : (state?.filters.find((f) => f.name === selected) ?? null),
    [state, selected, creating],
  );

  // Default to the first filter once state arrives.
  useEffect(() => {
    if (!creating && selected === null && state !== null && state.filters.length > 0) {
      setSelected(state.filters[0]!.name);
    }
  }, [state, selected, creating]);

  // Poll the feed while it is the active view.
  useEffect(() => {
    if (view !== "feed") {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const f = await api.feed(3);
        if (!cancelled) setFeed(f);
      } catch {
        if (!cancelled) setFeed(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [view]);

  // Load the selected filter into the editor.
  useEffect(() => {
    if (filter !== null) {
      setDraft({ name: filter.name, model: filter.model, prompt: filter.prompt });
    }
  }, [filter?.name, filter?.promptHash]);

  // Live preview of the hash this draft would mint.
  useEffect(() => {
    let cancelled = false;
    void previewHash(draft.model, draft.prompt).then((h) => {
      if (!cancelled) setNextHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, [draft.model, draft.prompt]);

  // Poll results for the selected filter.
  useEffect(() => {
    if (creating || selected === null) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const r = await api.results(selected);
        if (!cancelled) setResults(r);
      } catch {
        if (!cancelled) setResults(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected, creating]);

  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      setError(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const draftChanged = filter !== null && nextHash !== "" && nextHash !== filter.promptHash;
  const judging = state?.jobs.some(
    (j) =>
      j.process === "reactor:paper-filter" &&
      (creating ? false : j.payload["filter"] === selected),
  );
  const ingesting = state?.jobs.some((j) => j.process === "reactor:arxiv");
  const hue = filter !== null && filter.promptHash !== "" ? hashHue(filter.promptHash) : 160;
  const lastFilterRun = state?.runs.find((r) => r.process === "reactor:paper-filter");

  return (
    <div className="frame">
      <header>
        <span className="wordmark">personalbase</span>
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
          <button
            className={`filter-item today ${view === "feed" ? "active" : ""}`}
            onClick={() => setView("feed")}
          >
            <span className="filter-name">Today</span>
            <span className="filter-meta">
              <span className="match-count">
                {feed === null ? "…" : `${feed.items.length} surfaced`}
              </span>
            </span>
          </button>
          <div className="rail-label">Filters</div>
          <nav>
            {state?.filters.map((f) => (
              <button
                key={f.name}
                className={`filter-item ${view === "filter" && !creating && selected === f.name ? "active" : ""}`}
                onClick={() => {
                  setView("filter");
                  setCreating(false);
                  setSelected(f.name);
                }}
              >
                <span className="filter-name">{f.name}</span>
                <span className="filter-meta">
                  <HashChip hash={f.promptHash} />
                  <span className="match-count">{f.matches} match</span>
                </span>
              </button>
            ))}
          </nav>
          <button
            className="ghost"
            onClick={() => {
              setView("filter");
              setCreating(true);
              setDraft({ name: "", model: "claude-opus-5", prompt: "" });
            }}
          >
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
        </aside>

        <main>
          {view === "feed" ? (
            <section className="results">
              <div className="results-head">
                <span className="results-count">
                  {feed === null ? "loading…" : `${feed.items.length} surfaced`}
                </span>
                <span className="dot">·</span>
                <span>filter matches and lab publications, last {feed?.days ?? 3} days</span>
              </div>
              {feed !== null && feed.items.length === 0 && (
                <div className="empty">
                  Nothing surfaced in this window yet — ingest papers and judge a filter, or
                  wait for the daily sweeps.
                </div>
              )}
              {feed !== null &&
                groupByPublicationDay(feed.items).map(([day, items]) => (
                  <div key={day}>
                    <div className="feed-date">{formatDay(day)}</div>
                    {items.map((item) => (
                      <FeedRow
                        key={item.arxivId}
                        item={item}
                        hueFor={(name) =>
                          hashHue(
                            state?.filters.find((f) => f.name === name)?.promptHash ?? "000000",
                          )
                        }
                      />
                    ))}
                  </div>
                ))}
            </section>
          ) : filter === null ? (
            <div className="empty">No filters yet. Create one to start sifting the arXiv stream.</div>
          ) : (
            <>
              <section className="editor">
                <div className="editor-head">
                  {creating ? (
                    <input
                      className="name-input"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="filter name"
                      autoFocus
                    />
                  ) : (
                    <h1>{filter.name}</h1>
                  )}
                  <input
                    className="model-input"
                    value={draft.model}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                    title="model"
                  />
                </div>
                <textarea
                  value={draft.prompt}
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                  placeholder="Describe what you want surfaced — the judge reads titles and abstracts against this."
                  rows={5}
                />
                <div className="editor-foot">
                  <span className="hash-line">
                    {!creating && filter.promptHash !== "" && (
                      <HashChip hash={filter.promptHash} label="current" />
                    )}
                    {(creating || draftChanged) && nextHash !== "" && (
                      <>
                        {!creating && <span className="mints">→</span>}
                        <HashChip hash={nextHash} label="mints" />
                      </>
                    )}
                  </span>
                  <button
                    className="primary"
                    disabled={
                      draft.prompt === "" || (creating ? draft.name === "" : !draftChanged)
                    }
                    onClick={() =>
                      void act(async () => {
                        await api.saveFilter(draft);
                        setCreating(false);
                        setSelected(draft.name);
                      })
                    }
                  >
                    Save prompt
                  </button>
                </div>
              </section>

              {!creating && (
                <section className="run-row">
                  <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
                    <option value={1}>last day</option>
                    <option value={3}>last 3 days</option>
                    <option value={7}>last 7 days</option>
                  </select>
                  <button
                    className="primary"
                    disabled={judging === true}
                    onClick={() => void act(() => api.runFilter(filter.name, days))}
                  >
                    {judging === true ? "Judging…" : "Judge papers"}
                  </button>
                  {judging === true && <span className="working">worker is on it</span>}
                  {judging !== true && lastFilterRun !== undefined && (
                    <span className="run-fact">
                      last run {ago(lastFilterRun.started_at)}
                      {lastFilterRun.status === "failed" ? ` — failed: ${lastFilterRun.error}` : ""}
                    </span>
                  )}
                </section>
              )}

              {!creating && results !== null && (
                <section className="results">
                  <div className="results-head">
                    <span className="results-count">
                      {results.matches.length} match{results.matches.length === 1 ? "" : "es"}
                    </span>
                    <span className="dot">·</span>
                    <span>{results.rejects.length} rejected</span>
                    <span className="dot">·</span>
                    <HashChip hash={results.promptHash} />
                  </div>
                  {results.matches.length === 0 && results.rejects.length === 0 ? (
                    <div className="empty">
                      No verdicts under this prompt yet — judge a date range to populate.
                    </div>
                  ) : (
                    <>
                      {results.matches.map((v) => (
                        <VerdictRow key={v.arxivId} verdict={v} hue={hue} open={true} />
                      ))}
                      {results.rejects.length > 0 && (
                        <details className="rejects">
                          <summary>rejected ({results.rejects.length})</summary>
                          {results.rejects.map((v) => (
                            <VerdictRow key={v.arxivId} verdict={v} hue={hue} open={false} />
                          ))}
                        </details>
                      )}
                    </>
                  )}
                </section>
              )}
            </>
          )}
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
