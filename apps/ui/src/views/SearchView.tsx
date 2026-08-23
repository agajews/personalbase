import { useEffect, useState } from "react";
import { api, type SearchResults } from "../api.js";

export function SearchView({ q }: { q: string }) {
  const [results, setResults] = useState<SearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setResults(null);
    setError(null);
    api
      .search(q)
      .then(setResults)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [q]);

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (results === null) {
    return <div className="empty">searching…</div>;
  }
  const total =
    results.papers.length + results.other.length + results.people.length + results.orgs.length;
  return (
    <div className="entity-page">
      <div className="entity-head">
        <span className="entity-kind">search</span>
        <h1>{q}</h1>
      </div>
      {total === 0 && <div className="empty">Nothing matches. Full-text over titles and abstracts; people and orgs by name.</div>}
      {results.papers.length > 0 && (
        <section className="link-group">
          <div className="feed-date">papers ({results.papers.length})</div>
          {results.papers.map((p) => (
            <a key={p.entityId} className="link-row" href={`#/entity/${p.entityId}`}>
              <span className="link-kind">paper</span>
              <span className="link-name">{p.title}</span>
              <span className="link-provenance">{p.arxivId}</span>
            </a>
          ))}
        </section>
      )}
      {results.other.length > 0 && (
        <section className="link-group">
          <div className="feed-date">library ({results.other.length})</div>
          {results.other.map((item) => (
            <a key={item.entityId} className="link-row" href={`#/entity/${item.entityId}`}>
              <span className="link-kind">{item.pubtype.replace("PP_", "").toLowerCase()}</span>
              <span className="link-name">{item.title}</span>
              <span className="link-provenance">{item.arxivId ?? ""}</span>
            </a>
          ))}
        </section>
      )}
      {results.people.length > 0 && (
        <section className="link-group">
          <div className="feed-date">people ({results.people.length})</div>
          {results.people.map((p) => (
            <a key={p.entityId} className="link-row" href={`#/entity/${p.entityId}`}>
              <span className="link-kind">person</span>
              <span className="link-name">{p.displayName}</span>
            </a>
          ))}
        </section>
      )}
      {results.orgs.length > 0 && (
        <section className="link-group">
          <div className="feed-date">orgs ({results.orgs.length})</div>
          {results.orgs.map((o) => (
            <a key={o.entityId} className="link-row" href={`#/entity/${o.entityId}`}>
              <span className="link-kind">org</span>
              <span className="link-name">{o.displayName}</span>
            </a>
          ))}
        </section>
      )}
    </div>
  );
}
