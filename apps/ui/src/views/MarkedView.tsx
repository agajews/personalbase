import { api, type Mark } from "../api.js";
import { useCached } from "../cache.js";
import { ago, MarkButtons, refLabel } from "../ui.js";

export function MarkedView({ mark }: { mark: Mark }) {
  const { data, error, refresh } = useCached(`marked:${mark}`, () => api.marked(mark));
  const items = data?.items ?? null;

  const title = mark === "want_to_read" ? "want to read" : "saved";
  return (
    <div className="entity-page">
      <div className="entity-head">
        <span className="entity-kind">{mark === "want_to_read" ? "shortlist" : "library"}</span>
        <h1>{title}</h1>
      </div>
      {error !== null && <div className="error">{error}</div>}
      {items === null && error === null && <div className="empty">loading…</div>}
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
                {item.title ?? refLabel(item.ref)}
              </a>
              <span className="link-provenance">{ago(item.markedAt)}</span>
              <MarkButtons entityId={item.entityId} mark={item.mark} onChanged={refresh} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
