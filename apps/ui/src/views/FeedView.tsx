import { useEffect, useState } from "react";
import {
  api,
  type FeedItem,
  type FilterSummary,
  type ResurfacedItem,
  type StudyQuestion,
} from "../api.js";
import { useCached } from "../cache.js";
import {
  Abstract,
  ago,
  AuthorsLine,
  CategoryChips,
  EntityChip,
  formatDay,
  hashHue,
  MarkButtons,
  MathMarkdown,
  navTo,
} from "../ui.js";

function FeedRow({ item, onMarked }: { item: FeedItem; onMarked: () => void }) {
  // Hues come from each verdict's own prompt hash, so a paper judged under an
  // earlier prompt version wears that version's color, not the current one.
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
              style={{ width: `${top.confidence * 100}%`, background: `hsl(${hashHue(top.promptHash)} 45% 42%)` }}
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
            title={`judged under prompt ${m.promptHash}`}
            style={{
              color: `hsl(${hashHue(m.promptHash)} 45% 30%)`,
              background: `hsl(${hashHue(m.promptHash)} 50% 93%)`,
              borderColor: `hsl(${hashHue(m.promptHash)} 35% 78%)`,
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
      <Abstract text={item.abstract} />
      <p className="verdict-actions">
        <MarkButtons entityId={item.entityId} mark={item.mark} onChanged={onMarked} />
        <CategoryChips categories={item.categories} />
      </p>
    </details>
  );
}

// ---- resurfacing ----
// Recorded daily samples from the saved library, one block per timeline day.

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
      {item.abstract !== null && <Abstract text={item.abstract} />}
      <p className="verdict-actions">
        <MarkButtons entityId={item.entityId} mark={item.mark} onChanged={onMarked} />
        <CategoryChips categories={item.categories} />
      </p>
    </details>
  );
}

/** The day's spaced-repetition exercise; clicking anywhere opens the problem
 * view (the question pinned over its tutor chat). */
function QuestionCard({ q }: { q: StudyQuestion }) {
  return (
    <div
      className="question-card"
      onClick={() => navTo(`/chat/${q.questionUid}`)}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") navTo(`/chat/${q.questionUid}`);
      }}
    >
      <div className="question-body">
        <MathMarkdown>{q.question}</MathMarkdown>
      </div>
      <div className="question-actions">
        <span className="primary question-solve">
          {q.turns > 0 ? "Continue discussion" : "Write your solution"}
        </span>
        <span className="question-notes">{q.notes}</span>
      </div>
    </div>
  );
}

const revealStep = 5;

/** A day's resurfacing block, revealed a few rows at a time. */
function ResurfacedBlock({
  items,
  onMarked,
}: {
  items: ResurfacedItem[];
  onMarked: () => void;
}) {
  const [shown, setShown] = useState(revealStep);
  const visible = items.slice(0, shown);
  return (
    <>
      <div className="timeline-kind">resurfaced</div>
      {visible.map((item) => (
        <ResurfacedRow key={item.entityId} item={item} onMarked={onMarked} />
      ))}
      {visible.length < items.length && (
        <button className="ghost resurfaced-more" onClick={() => setShown((n) => n + revealStep)}>
          show {Math.min(revealStep, items.length - visible.length)} more
        </button>
      )}
    </>
  );
}

export function FeedView({ filters }: { filters: FilterSummary[] }) {
  const [days, setDays] = useState(3);
  const { data: feed, refresh } = useCached(`feed:${days}`, () => api.feed(days));
  useEffect(() => {
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // One timeline: fresh papers (by publication day) and each day's recorded
  // resurfacing merge into day sections, newest first. Future surfaced kinds
  // (repetition cards, memos, reading blocks) join the same merge.
  interface DaySection {
    day: string;
    questions: StudyQuestion[];
    fresh: FeedItem[];
    resurfaced: ResurfacedItem[];
  }
  const sections = new Map<string, DaySection>();
  const section = (day: string): DaySection => {
    const existing = sections.get(day);
    if (existing !== undefined) {
      return existing;
    }
    const created: DaySection = { day, questions: [], fresh: [], resurfaced: [] };
    sections.set(day, created);
    return created;
  };
  if (feed !== null) {
    for (const q of feed.questions) {
      section(q.day).questions.push(q);
    }
    for (const group of feed.resurfaced) {
      section(group.day).resurfaced.push(...group.items);
    }
    for (const item of feed.items) {
      // Group by arrival day — arXiv lists papers under their announcement
      // day, and arrival tracks announcement.
      section(new Date(item.ingestedAt).toISOString().slice(0, 10)).fresh.push(item);
    }
  }
  const ordered = [...sections.values()].sort((a, b) => (a.day < b.day ? 1 : -1));

  return (
    <section className="results timeline">
      <div className="results-head">
        <span className="results-count">
          {feed === null ? "loading…" : `${feed.items.length} surfaced`}
        </span>
        <span className="dot">·</span>
        <span>
          new papers and resurfacings from {feed?.savedTotal ?? "…"} saved · last {days} days
        </span>
      </div>
      {feed !== null && ordered.length === 0 && (
        <div className="empty">
          Nothing on the timeline yet — the daily sweeps and resurfacer fill it in.
        </div>
      )}
      {ordered.map(({ day, questions, fresh, resurfaced }) => (
        <div key={day} className="timeline-day">
          <div className="feed-date timeline-date">{formatDay(day)}</div>
          {questions.map((q) => (
            <div key={q.questionUid}>
              <div className="timeline-kind">
                daily exercise · {q.topic} · level {q.level}
              </div>
              <QuestionCard q={q} />
            </div>
          ))}
          {resurfaced.length > 0 && (
            <ResurfacedBlock key={`r-${day}`} items={resurfaced} onMarked={refresh} />
          )}
          {fresh.length > 0 && (
            <>
              {resurfaced.length > 0 && <div className="timeline-kind">new papers</div>}
              {fresh.map((item) => (
                <FeedRow key={item.arxivId} item={item} onMarked={refresh} />
              ))}
            </>
          )}
        </div>
      ))}
      {feed !== null && (
        <button className="ghost load-more" onClick={() => setDays((d) => d + 7)}>
          show earlier days
        </button>
      )}
    </section>
  );
}
