import { useEffect, useMemo, useState } from "react";
import {
  api,
  previewHash,
  type AppState,
  type FilterSummary,
  type Verdict,
} from "../api.js";
import { useCached } from "../cache.js";
import {
  ago,
  AuthorsLine,
  BusyButton,
  CategoryChips,
  EntityChip,
  HashChip,
  hashHue,
  hueStyle,
  MarkButtons,
} from "../ui.js";

function VerdictRow({
  verdict,
  hue,
  open,
  onMarked,
}: {
  verdict: Verdict;
  hue: number;
  open: boolean;
  onMarked: () => void;
}) {
  return (
    <details className="verdict" open={open}>
      <summary>
        {verdict.mark !== null && (
          <span className="mark-dot" title={verdict.mark}>
            {verdict.mark === "want_to_read" ? "★" : "✓"}
          </span>
        )}
        <span className="confidence" title={`confidence ${verdict.confidence.toFixed(2)}`}>
          <span
            className="confidence-fill"
            style={{ width: `${verdict.confidence * 100}%`, ...hueStyle(hue) }}
          />
        </span>
        <a
          className="verdict-title"
          href={`#/entity/${verdict.entityId}`}
          onClick={(e) => e.stopPropagation()}
        >
          {verdict.title}
        </a>
        {verdict.orgs.map((org) => (
          <EntityChip key={org.entityId} entityId={org.entityId} name={org.name} className="org-chip" />
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
      <AuthorsLine authors={verdict.authors} />
      <p className="verdict-reason">{verdict.reason}</p>
      <p className="verdict-abstract">{verdict.abstract}</p>
      <p className="verdict-actions">
        <MarkButtons entityId={verdict.entityId} mark={verdict.mark} onChanged={onMarked} />
        <CategoryChips categories={verdict.categories} />
      </p>
    </details>
  );
}

const newFilter: FilterSummary = {
  name: "",
  model: "claude-opus-5",
  prompt: "",
  promptHash: "",
  matches: 0,
  rejects: 0,
};

export function FilterView({
  name,
  creating,
  state,
  refresh,
  onSaved,
  onError,
}: {
  name: string | null;
  creating: boolean;
  state: AppState;
  refresh: () => Promise<void>;
  onSaved: (name: string) => void;
  onError: (message: string | null) => void;
}) {
  const filter = useMemo(
    () => (creating ? newFilter : (state.filters.find((f) => f.name === name) ?? null)),
    [state, name, creating],
  );
  const [draft, setDraft] = useState({ name: "", model: "", prompt: "" });
  const [nextHash, setNextHash] = useState("");
  const [days, setDays] = useState(3);

  // Existing filters show their verdicts; the results poll while the view
  // is open so a running judge job streams in.
  const { data: results, refresh: refreshResults } = useCached(
    `results:${name ?? ""}`,
    () => (creating || name === null ? Promise.resolve(null) : api.results(name)),
  );

  useEffect(() => {
    if (filter !== null) {
      setDraft({ name: filter.name, model: filter.model, prompt: filter.prompt });
    }
  }, [filter?.name, filter?.promptHash]);

  useEffect(() => {
    let cancelled = false;
    void previewHash(draft.model, draft.prompt).then((h) => {
      if (!cancelled) setNextHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, [draft.model, draft.prompt]);

  useEffect(() => {
    if (creating || name === null) {
      return;
    }
    const timer = setInterval(refreshResults, 3000);
    return () => clearInterval(timer);
  }, [name, creating, refreshResults]);

  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      onError(null);
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  if (filter === null) {
    return <div className="empty">No filters yet. Create one to start sifting the arXiv stream.</div>;
  }

  const draftChanged = nextHash !== "" && nextHash !== filter.promptHash;
  const judging = state.jobs.some(
    (j) => j.process === "reactor:paper-filter" && (creating ? false : j.payload["filter"] === name),
  );
  const hue = filter.promptHash !== "" ? hashHue(filter.promptHash) : 160;
  const lastFilterRun = state.runs.find((r) => r.process === "reactor:paper-filter");

  return (
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
          <BusyButton
            className="primary"
            disabled={draft.prompt === "" || (creating ? draft.name === "" : !draftChanged)}
            onClick={() =>
              act(async () => {
                await api.saveFilter(draft);
                onSaved(draft.name);
              })
            }
          >
            Save prompt
          </BusyButton>
        </div>
      </section>

      {!creating && (
        <section className="run-row">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>last day</option>
            <option value={3}>last 3 days</option>
            <option value={7}>last 7 days</option>
          </select>
          <BusyButton
            className="primary"
            disabled={judging}
            onClick={() => act(() => api.runFilter(filter.name, days))}
          >
            {judging ? "Judging…" : "Judge papers"}
          </BusyButton>
          {judging && <span className="working">worker is on it</span>}
          {!judging && lastFilterRun !== undefined && (
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
                <VerdictRow
                  key={v.arxivId}
                  verdict={v}
                  hue={hue}
                  open={true}
                  onMarked={refreshResults}
                />
              ))}
              {results.rejects.length > 0 && (
                <details className="rejects">
                  <summary>rejected ({results.rejects.length})</summary>
                  {results.rejects.map((v) => (
                    <VerdictRow
                      key={v.arxivId}
                      verdict={v}
                      hue={hue}
                      open={false}
                      onMarked={refreshResults}
                    />
                  ))}
                </details>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}
