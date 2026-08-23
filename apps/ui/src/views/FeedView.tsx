import { useEffect, useState } from "react";
import { api, type Feed, type FeedItem, type FilterSummary } from "../api.js";
import { AuthorsLine, CategoryChips, EntityChip, formatDay, hashHue, MarkButtons } from "../ui.js";

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

export function FeedView({ filters }: { filters: FilterSummary[] }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const f = await api.feed(3);
        if (!cancelled) setFeed(f);
      } catch {
        if (!cancelled) setFeed(null);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tick]);

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
              <FeedRow
                key={item.arxivId}
                item={item}
                hueFor={hueFor}
                onMarked={() => setTick((t) => t + 1)}
              />
            ))}
          </div>
        ))}
    </section>
  );
}
