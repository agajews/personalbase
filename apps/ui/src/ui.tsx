// Shared presentational bits and navigation helpers.
import { api, type Mark } from "./api.js";

/**
 * Two-tier marking: none < saved < want_to_read. Clicking the active tier
 * steps down one level.
 */
export function MarkButtons({
  arxivId,
  mark,
  onChanged,
}: {
  arxivId: string;
  mark: Mark | null;
  onChanged: () => void;
}) {
  const saved = mark === "saved" || mark === "want_to_read";
  const wtr = mark === "want_to_read";
  const set = async (m: Mark | "none") => {
    await api.mark(arxivId, m);
    onChanged();
  };
  return (
    <span className="mark-buttons" onClick={(e) => e.stopPropagation()}>
      <button
        className={`mark ${saved ? "on" : ""}`}
        title={saved ? "unsave" : "save to library"}
        onClick={() => void set(wtr ? "saved" : saved ? "none" : "saved")}
      >
        {saved ? "✓ saved" : "save"}
      </button>
      <button
        className={`mark ${wtr ? "on" : ""}`}
        title={wtr ? "back to saved" : "add to the read-in-depth shortlist"}
        onClick={() => void set(wtr ? "saved" : "want_to_read")}
      >
        {wtr ? "★ want to read" : "want to read"}
      </button>
    </span>
  );
}

export function hashHue(hash: string): number {
  return parseInt(hash.slice(0, 6), 16) % 360;
}

export function navTo(path: string): void {
  location.hash = path;
}

export function HashChip({ hash, label }: { hash: string; label?: string }) {
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

export function EntityChip({
  entityId,
  name,
  className,
}: {
  entityId: string;
  name: string;
  className: string;
}) {
  return (
    <a
      className={className}
      href={`#/entity/${entityId}`}
      onClick={(e) => e.stopPropagation()}
    >
      {name}
    </a>
  );
}

export function AuthorsLine({
  authors,
}: {
  authors: { entityId: string; name: string }[];
}) {
  if (authors.length === 0) {
    return null;
  }
  return (
    <p className="verdict-authors">
      {authors.map((a, i) => (
        <span key={a.entityId}>
          {i > 0 && ", "}
          <a href={`#/entity/${a.entityId}`} className="author-link">
            {a.name}
          </a>
        </span>
      ))}
    </p>
  );
}

export function ago(iso: string | null): string {
  if (iso === null) {
    return "never";
  }
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function formatDay(day: string): string {
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
