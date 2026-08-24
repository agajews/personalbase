import { api, type GraphMode } from "../api.js";
import { useCached } from "../cache.js";
import { facetHue, MarkButtons } from "../ui.js";

// One node of the entity graph — a tag, an author, an affiliation: what it
// is, every saved paper that belongs to it and how strongly, and the nodes it
// travels with. The same panel serves the graph's rail and a tag's own page,
// so a tag reads the same wherever you reach it from.

export function NodePanel({
  mode,
  nodeKey,
  chipHref,
  actions,
}: {
  mode: GraphMode;
  nodeKey: string;
  /** Where the "travels with" chips point — the graph's rail stays in the map. */
  chipHref: (key: string) => string;
  actions?: React.ReactNode;
}) {
  const {
    data: node,
    error,
    refresh,
  } = useCached(`graph-node:${mode}:${nodeKey}`, () => api.graphNode(mode, nodeKey));

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (node === null) {
    return <div className="empty">loading…</div>;
  }
  const h = facetHue(node.facet);
  return (
    <>
      <div className="rail-head">
        <span className="entity-kind" style={{ color: `hsl(${h} 34% 36%)` }}>
          {node.facet}
        </span>
        {actions}
      </div>
      <h2 className="rail-title">{node.name}</h2>
      {node.description !== "" && <p className="run-fact">{node.description}</p>}
      <div className="feed-date">{node.papers.length} papers</div>
      <div className="rail-items">
        {node.papers.map((item) => (
          <div key={item.entityId} className="rail-item">
            <a className="rail-item-name" href={`#/entity/${item.entityId}`}>
              {item.title ?? item.entityId}
            </a>
            <div className="rail-item-meta">
              <span
                className="strength-bar"
                title={`strength ${item.strength.toFixed(2)}`}
                style={{
                  background: `linear-gradient(to right, hsl(${h} 34% 52%) ${Math.round(
                    item.strength * 100,
                  )}%, var(--line) ${Math.round(item.strength * 100)}%)`,
                }}
              />
              <span className="mono rail-strength">{item.strength.toFixed(2)}</span>
              <MarkButtons entityId={item.entityId} mark={item.mark} onChanged={refresh} />
            </div>
          </div>
        ))}
      </div>
      {node.related.length > 0 && (
        <>
          <div className="feed-date">travels with</div>
          <p className="tag-chips">
            {node.related.map((r) => (
              <a key={r.key} className="tag-chip" href={chipHref(r.key)}>
                {r.name} <span className="mono">{r.shared}</span>
              </a>
            ))}
          </p>
        </>
      )}
    </>
  );
}

/** A tag's own page: the panel, without the map. */
export function TagView({ slug }: { slug: string }) {
  return (
    <div className="entity-page tag-page">
      <NodePanel
        mode="tags"
        nodeKey={slug}
        chipHref={(s) => `#/tag/${encodeURIComponent(s)}`}
        actions={
          <a className="crumb rail-clear" href={`#/graph/tags/${encodeURIComponent(slug)}`}>
            see it in the graph →
          </a>
        }
      />
    </div>
  );
}
