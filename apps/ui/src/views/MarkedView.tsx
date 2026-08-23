import { useEffect, useState } from "react";
import { api, type Mark, type MarkedItem } from "../api.js";
import { ago, MarkButtons } from "../ui.js";

export function MarkedView({ mark }: { mark: Mark }) {
  const [items, setItems] = useState<MarkedItem[] | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api
      .marked(mark)
      .then((r) => setItems(r.items))
      .catch(() => setItems(null));
  }, [mark, tick]);

  const title = mark === "want_to_read" ? "want to read" : "saved";
  return (
    <div className="entity-page">
      <div className="entity-head">
        <span className="entity-kind">{mark === "want_to_read" ? "shortlist" : "library"}</span>
        <h1>{title}</h1>
      </div>
      {items === null && <div className="empty">loading…</div>}
      {items !== null && items.length === 0 && (
        <div className="empty">
          {mark === "want_to_read"
            ? "Nothing on the shortlist yet — mark a paper as want-to-read from the feed, a filter, or its page."
            : "Nothing saved yet."}
        </div>
      )}
      {items !== null && (
        <section className="link-group">
          {items.map((item) => (
            <div key={item.entityId} className="link-row marked-row">
              <span className="link-kind">
                {mark === "saved" && item.mark === "want_to_read" ? "★" : item.kind}
              </span>
              <a className="link-name" href={`#/entity/${item.entityId}`}>
                {item.title ?? item.entityId}
              </a>
              <span className="link-provenance">{ago(item.markedAt)}</span>
              {item.arxivId !== null && (
                <MarkButtons
                  arxivId={item.arxivId}
                  mark={item.mark}
                  onChanged={() => setTick((t) => t + 1)}
                />
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
