// Shared presentational bits and navigation helpers.
import katex from "katex";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import Markdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { api, type Mark } from "./api.js";

/** Markdown with $/$$ LaTeX — study questions and chat replies carry math. */
export function MathMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
      rehypePlugins={[rehypeKatex]}
    >
      {children}
    </Markdown>
  );
}

/**
 * TeX inside otherwise plain prose: $$…$$ and \[…\] display, $…$ and \(…\)
 * inline. An inline $ pair must hug its contents (`$x$`, never `$5 and $9`)
 * so prices and lone dollar signs stay prose.
 */
const texSegment =
  /\$\$([\s\S]+?)\$\$|(?<!\\)\$(?!\s)([^$]*[^$\s\\])\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;

const unicodeMacro = (tex: string): string =>
  tex.replace(/\\unicode\{x([0-9a-f]+)\}/gi, (_, hex: string) =>
    `\\text{${String.fromCodePoint(parseInt(hex, 16))}}`,
  );

/**
 * A paper abstract: arXiv gives it to us as plain text carrying TeX, so the
 * math renders and everything else stays exactly as written. Markdown is the
 * wrong tool here — an abstract's stray underscores and asterisks are text,
 * not markup.
 */
export function Abstract({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let prose = 0;
  for (const m of text.matchAll(texSegment)) {
    const at = m.index;
    const tex = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    let html: string;
    try {
      // \unicode{x2014} is arXiv's favourite macro and KaTeX has never heard
      // of it; it means the character, so hand KaTeX the character.
      html = katex.renderToString(unicodeMacro(tex), {
        displayMode: m[1] !== undefined || m[4] !== undefined,
        throwOnError: true,
      });
    } catch {
      // Macros KaTeX doesn't know (\unicode{x2014} and friends show up in
      // arXiv abstracts) stay as the source text, the way they read today.
      continue;
    }
    parts.push(text.slice(prose, at));
    parts.push(<span key={at} dangerouslySetInnerHTML={{ __html: html }} />);
    prose = at + m[0].length;
  }
  parts.push(text.slice(prose));
  return <p className="verdict-abstract">{parts}</p>;
}

/**
 * A button that disables itself and shows a working state while its async
 * onClick is in flight — database round trips are visible, not mysterious.
 */
export function BusyButton({
  onClick,
  className,
  disabled,
  title,
  children,
}: {
  onClick: () => Promise<unknown>;
  className?: string;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`${className ?? ""} ${busy ? "busy" : ""}`}
      disabled={disabled === true || busy}
      title={title}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        void onClick().finally(() => setBusy(false));
      }}
    >
      {children}
      {busy && <span className="spinner" aria-label="working" />}
    </button>
  );
}

/**
 * Two-tier marking on any paper or resource entity: none < saved <
 * want_to_read. Clicking the active tier steps down one level.
 */
export function MarkButtons({
  entityId,
  mark,
  onChanged,
}: {
  entityId: string;
  mark: Mark | null;
  onChanged: () => void;
}) {
  const saved = mark === "saved" || mark === "want_to_read";
  const wtr = mark === "want_to_read";
  const set = async (m: Mark | "none") => {
    await api.mark(entityId, m);
    onChanged();
  };
  return (
    <span className="mark-buttons" onClick={(e) => e.stopPropagation()}>
      <BusyButton
        className={`mark ${saved ? "on" : ""}`}
        title={saved ? "unsave" : "save to library"}
        onClick={() => set(wtr ? "saved" : saved ? "none" : "saved")}
      >
        {saved ? "✓ saved" : "save"}
      </BusyButton>
      <BusyButton
        className={`mark ${wtr ? "on" : ""}`}
        title={wtr ? "back to saved" : "add to the read-in-depth shortlist"}
        onClick={() => set(wtr ? "saved" : "want_to_read")}
      >
        {wtr ? "★ want to read" : "want to read"}
      </BusyButton>
    </span>
  );
}

/** Category tags, each linking to the papers browser filtered to it. */
export function CategoryChips({ categories }: { categories: string[] }) {
  return (
    <>
      {categories.slice(0, 3).map((cat) => (
        <a
          key={cat}
          className="cat-chip"
          href={`#/papers/${encodeURIComponent(cat)}`}
          onClick={(e) => e.stopPropagation()}
        >
          {cat}
        </a>
      ))}
    </>
  );
}

export function hashHue(hash: string): number {
  return parseInt(hash.slice(0, 6), 16) % 360;
}

/**
 * One hue per tag facet, in the same muted-HSL idiom as the prompt-hash chips:
 * facet is the only categorical dimension in the tag graph, so colour carries
 * it everywhere tags appear — chips on a paper, nodes in the graph.
 */
const facetHues: Record<string, number> = {
  task: 210,
  method: 265,
  architecture: 22,
  theory: 292,
  training: 150,
  evaluation: 45,
  systems: 188,
  application: 358,
};

export function facetHue(facet: string): number {
  return facetHues[facet] ?? 0;
}

/**
 * Tag chips on an entity page. Membership is a matter of degree, so the chip's
 * colour saturates with strength: what the paper is squarely about reads
 * strongest, what it merely touches fades toward the page. Each links into the
 * graph focused on that tag.
 */
export function TagChips({
  tags,
}: {
  tags: { slug: string; name: string; facet: string; strength: number }[];
}) {
  if (tags.length === 0) {
    return null;
  }
  return (
    <p className="tag-chips">
      {tags.map((t) => {
        const h = facetHue(t.facet);
        const s = Math.max(0, Math.min(1, t.strength));
        return (
          <a
            key={t.slug}
            className="tag-chip"
            href={`#/graph/${encodeURIComponent(t.slug)}`}
            title={`${t.facet} · strength ${t.strength.toFixed(2)}`}
            style={{
              color: `hsl(${h} ${18 + 26 * s}% ${44 - 14 * s}%)`,
              background: `hsl(${h} ${20 + 32 * s}% ${98 - 5 * s}%)`,
              borderColor: `hsl(${h} ${14 + 24 * s}% ${90 - 12 * s}%)`,
            }}
          >
            {t.name}
          </a>
        );
      })}
    </p>
  );
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

/**
 * ⌘/Ctrl-Enter submits from inside a textarea (plain Enter keeps newlines) —
 * the site-wide keyboard convention for multi-line inputs with one primary
 * action.
 */
export function cmdEnter(
  submit: () => void,
): (e: KeyboardEvent<HTMLTextAreaElement>) => void {
  return (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
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

/**
 * How long a run has been going, or how long it took once it finished — the
 * same shape as ago(), without the "ago".
 */
export function runDuration(startedAt: string, finishedAt: string | null): string {
  const end = finishedAt === null ? Date.now() : new Date(finishedAt).getTime();
  const seconds = Math.max(0, (end - new Date(startedAt).getTime()) / 1000);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
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
