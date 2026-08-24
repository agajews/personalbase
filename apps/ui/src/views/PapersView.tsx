import { useEffect, useRef, useState } from "react";
import { api, type PaperListItem, type PapersQuery } from "../api.js";
import { useCached } from "../cache.js";
import { Abstract, AuthorsLine, CategoryChips, EntityChip, formatDay, MarkButtons } from "../ui.js";

function PaperRow({ item, onMarked }: { item: PaperListItem; onMarked: () => void }) {
  return (
    <details className="verdict">
      <summary>
        {item.mark !== null && (
          <span className="mark-dot" title={item.mark}>
            {item.mark === "want_to_read" ? "★" : "✓"}
          </span>
        )}
        <a
          className="verdict-title"
          href={`#/entity/${item.entityId}`}
          onClick={(e) => e.stopPropagation()}
        >
          {item.title}
        </a>
        {item.orgs.map((org) => (
          <EntityChip key={org.entityId} entityId={org.entityId} name={org.name} className="org-chip" />
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
        <span className="paper-date">
          {formatDay(new Date(item.publishedAt).toISOString().slice(0, 10))}
        </span>
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
      <Abstract text={item.abstract} />
      <p className="verdict-actions">
        <MarkButtons entityId={item.entityId} mark={item.mark} onChanged={onMarked} />
        <CategoryChips categories={item.categories} />
      </p>
    </details>
  );
}

const pageSize = 50;

export function PapersView({ category }: { category: string | null }) {
  const [query, setQuery] = useState<PapersQuery>({
    sort: "published",
    dir: "desc",
    category: category ?? undefined,
  });
  const [qDraft, setQDraft] = useState("");
  const loading = useRef(false);

  const categories =
    useCached("categories", () => api.categories()).data?.categories ?? [];

  // Route changes (clicking a category chip) update the active filter.
  useEffect(() => {
    setQuery((prev) => ({ ...prev, category: category ?? undefined }));
  }, [category]);

  // The first page is cached per query so revisits render instantly;
  // load-more appends further pages, keyed by query so a query change
  // never mixes pages from different queries.
  const queryKey = JSON.stringify(query);
  const { data: firstPage, refresh } = useCached(`papers:${queryKey}`, () =>
    api.papers({ ...query, offset: 0 }),
  );
  const [extra, setExtra] = useState<{ key: string; items: PaperListItem[] }>({
    key: queryKey,
    items: [],
  });
  const extraItems = extra.key === queryKey ? extra.items : [];

  const items = firstPage === null ? [] : [...firstPage.items, ...extraItems];
  const total = firstPage?.total ?? null;

  const loadMore = async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const page = await api.papers({ ...query, offset: items.length });
      setExtra((prev) => ({
        key: queryKey,
        items: prev.key === queryKey ? [...prev.items, ...page.items] : page.items,
      }));
    } finally {
      loading.current = false;
    }
  };

  // Debounce the text filter into the query.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery((prev) => ({ ...prev, q: qDraft }));
    }, 300);
    return () => clearTimeout(timer);
  }, [qDraft]);

  return (
    <div className="papers-view">
      <div className="papers-toolbar">
        <input
          type="search"
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          placeholder="Filter titles"
        />
        <select
          value={`${query.sort}:${query.dir}`}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(":") as [PapersQuery["sort"], "asc" | "desc"];
            setQuery({ ...query, sort, dir });
          }}
        >
          <option value="published:desc">newest published</option>
          <option value="published:asc">oldest published</option>
          <option value="ingested:desc">recently added</option>
          <option value="title:asc">title A→Z</option>
        </select>
        <select
          value={query.category ?? "all"}
          onChange={(e) =>
            setQuery({
              ...query,
              category: e.target.value === "all" ? undefined : e.target.value,
            })
          }
        >
          <option value="all">all categories</option>
          {categories.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} ({c.papers})
            </option>
          ))}
        </select>
        <select
          value={query.mark ?? "all"}
          onChange={(e) =>
            setQuery({
              ...query,
              mark: e.target.value === "all" ? undefined : (e.target.value as PapersQuery["mark"]),
            })
          }
        >
          <option value="all">all papers</option>
          <option value="saved">saved</option>
          <option value="want_to_read">want to read</option>
          <option value="unmarked">unmarked</option>
        </select>
        <span className="run-fact">{total === null ? "loading…" : `${total} papers`}</span>
      </div>
      {items.map((item) => (
        <PaperRow key={item.arxivId} item={item} onMarked={refresh} />
      ))}
      {total !== null && items.length < total && (
        <button className="ghost load-more" onClick={() => void loadMore()}>
          show more ({items.length} of {total})
        </button>
      )}
    </div>
  );
}
