import { useEffect, useState } from "react";
import { api, type FeedItem, type FilterSummary, type ResurfacedItem } from "../api.js";
import { useCached } from "../cache.js";
import {
  ago,
  AuthorsLine,
  CategoryChips,
  EntityChip,
  formatDay,
  hashHue,
  MarkButtons,
} from "../ui.js";

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

function FeedRow({
  item,
  hueFor,
  onMarked,
}: {
  item: FeedItem;
  hueFor: (filter: string) => number;
  onMarked: () => void;
}) {
  const top = item.matches[0];
  return (
    <details className="verdict">
      <summary>
        {item.mark !== null && (
          <span className="mark-dot" title={item.mark}>
            {item.mark === "want_to_read" ? "★" : "✓"}
          </span>
        )}
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
        <a className="verdict-title" href={`#/entity/${item.entityId}`} onClick={(e) => e.stopPropagation()}>
          {item.title}
        </a>
        {item.labs.map((lab) => (
          <EntityChip key={lab.entityId} entityId={lab.entityId} name={lab.name} className="org-chip" />
        ))}
        {item.categories.slice(0, 1).map((cat) => (
          <a
            key={cat}
            className="cat-chip"
            href={`#/papers/${encodeURIComponent(cat)}`}
            onClick={(e) => e.stopPropagation()}
          >
            {cat}
          </a>
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
      <AuthorsLine authors={item.authors} />
      {top !== undefined && <p className="verdict-reason">{top.reason}</p>}
      <p className="verdict-abstract">{item.abstract}</p>
      <p className="verdict-actions">
        <MarkButtons entityId={item.entityId} mark={item.mark} onChanged={onMarked} />
        <CategoryChips categories={item.categories} />
      </p>
    </details>
  );
}

// ---- resurfacing ----
// A shelf of older saved papers under the feed. The server draws a sample
// seeded with today's date; we reveal it a few rows at a time.
const SAMPLE_SIZE = 25;
const REVEAL_STEP = 5;

function ResurfacedRow({ item, onMarked }: { item: ResurfacedItem; onMarked: () => void }) {
  return (
    <details className="verdict">
      <summary>
        <span className="mark-dot" title="saved">✓</span>
        <a className="verdict-title" href={`#/entity/${item.entityId}`} onClick={(e) => e.stopPropagation()}>
          {item.title}
        </a>
        {item.categories.slice(0, 1).map((cat) => (
          <a
            key={cat}
            className="cat-chip"
            href={`#/papers/${encodeURIComponent(cat)}`}
            onClick={(e) => e.stopPropagation()}
          >
            {cat}
          </a>
        ))}
        {item.journal !== null && <span className="link-provenance">{item.journal}</span>}
        <span className="link-provenance">
          saved {ago(item.markedAt)}
          {item.year !== null && ` · ${item.year}`}
        </span>
        {item.arxivId !== null && (
          <a
            className="arxiv-id"
            href={`https://arxiv.org/abs/${item.arxivId}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {item.arxivId}
          </a>
        )}
      </summary>
      <AuthorsLine authors={item.authors} />
      {item.abstract !== null && <p className="verdict-abstract">{item.abstract}</p>}
      <p className="verdict-actions">
        <MarkButtons entityId={item.entityId} mark="saved" onChanged={onMarked} />
        <CategoryChips categories={item.categories} />
      </p>
    </details>
  );
}

function ResurfacedSection() {
  const { data: sample, refresh } = useCached("resurfaced", () => api.resurfaced(SAMPLE_SIZE));
  const [shown, setShown] = useState(REVEAL_STEP);

  if (sample === null || sample.items.length === 0) {
    return null;
  }
  const visible = sample.items.slice(0, shown);
  return (
    <div className="resurfaced">
      <div className="feed-date">Resurfaced</div>
      <div className="results-head">
        <span className="results-count">
          {visible.length} of {sample.items.length}
        </span>
        <span className="dot">·</span>
        <span>drawn from {sample.total} saved, reshuffled daily</span>
      </div>
      {visible.map((item) => (
        <ResurfacedRow key={item.entityId} item={item} onMarked={refresh} />
      ))}
      {visible.length < sample.items.length && (
        <button className="ghost resurfaced-more" onClick={() => setShown((n) => n + REVEAL_STEP)}>
          show {Math.min(REVEAL_STEP, sample.items.length - visible.length)} more
        </button>
      )}
    </div>
  );
}

export function FeedView({ filters }: { filters: FilterSummary[] }) {
  const { data: feed, refresh } = useCached("feed", () => api.feed(3));
  useEffect(() => {
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const hueFor = (name: string) =>
    hashHue(filters.find((f) => f.name === name)?.promptHash ?? "000000");

  return (
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
          Nothing surfaced in this window yet — ingest papers and judge a filter, or wait for
          the daily sweeps.
        </div>
      )}
      {feed !== null &&
        groupByPublicationDay(feed.items).map(([day, items]) => (
          <div key={day}>
            <div className="feed-date">{formatDay(day)}</div>
            {items.map((item) => (
              <FeedRow key={item.arxivId} item={item} hueFor={hueFor} onMarked={refresh} />
            ))}
          </div>
        ))}
      <ResurfacedSection />
    </section>
  );
}
