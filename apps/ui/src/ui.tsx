// Shared presentational bits and navigation helpers.

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
