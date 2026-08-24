import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AppState, type TagGraph } from "../api.js";
import { useCached } from "../cache.js";
import { BusyButton, facetHue, MarkButtons, navTo } from "../ui.js";

// The tag graph: every granular tag the tagger invented is a node, and two
// tags are joined when papers carry both. Laid out with a plain
// Fruchterman-Reingold spring simulation on a canvas — a few hundred nodes is
// small enough that O(n²) repulsion runs comfortably at 60fps, and it keeps
// the view dependency-free. Drag a node to pin it, drag the background to
// pan, wheel to zoom, click a tag to read its papers.

interface Node {
  slug: string;
  name: string;
  facet: string;
  items: number;
  radius: number;
  /** Edge count; hub attraction is normalized by it so hubs don't collapse. */
  degree: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** Pinned by a drag; the simulation stops moving it. */
  pinned: boolean;
}

interface Edge {
  a: number;
  b: number;
  weight: number;
}

interface Layout {
  nodes: Node[];
  edges: Edge[];
  neighbors: Map<string, Set<string>>;
  /** Spring constant: the natural distance between two unrelated nodes. */
  k: number;
  /** Gravity-free radius: the disc the connected core is free to spread over. */
  core: number;
}

const canvasSize = { width: 1100, height: 660 };

function buildLayout(graph: TagGraph): Layout {
  const nodes: Node[] = graph.nodes.map((n, i) => {
    // Golden-angle spiral: an even, deterministic starting spread, so the
    // same graph always relaxes into the same map.
    const angle = i * 2.39996;
    const r = 16 * Math.sqrt(i + 1);
    return {
      slug: n.slug,
      name: n.name,
      facet: n.facet,
      items: n.items,
      radius: 3.5 + Math.sqrt(n.items) * 1.15,
      degree: 0,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      dx: 0,
      dy: 0,
      pinned: false,
    };
  });
  const index = new Map(nodes.map((n, i) => [n.slug, i]));
  const edges: Edge[] = [];
  const neighbors = new Map<string, Set<string>>(nodes.map((n) => [n.slug, new Set<string>()]));
  for (const e of graph.edges) {
    const a = index.get(e.source);
    const b = index.get(e.target);
    if (a === undefined || b === undefined) {
      continue;
    }
    edges.push({ a, b, weight: e.weight });
    nodes[a]!.degree++;
    nodes[b]!.degree++;
    neighbors.get(e.source)?.add(e.target);
    neighbors.get(e.target)?.add(e.source);
  }
  const area = canvasSize.width * canvasSize.height;
  const k = Math.sqrt(area / Math.max(nodes.length, 1));
  return { nodes, edges, neighbors, k, core: (k * Math.sqrt(nodes.length)) / 3 };
}

/**
 * One Fruchterman-Reingold pass: repel nearby pairs, contract every edge.
 * Repulsion is cut off past a few spring lengths — otherwise the whole graph
 * pushes tags with no co-occurrences into a far-off ring and the connected
 * core collapses to a dot once the view frames them. Edge attraction is
 * normalized by degree so a hub sits among its neighbours instead of
 * swallowing them.
 */
function step(layout: Layout, alpha: number): void {
  const { nodes, edges, k, core } = layout;
  const cutoff = 8 * k;
  const aspect = canvasSize.width / canvasSize.height;
  for (const n of nodes) {
    n.dx = 0;
    n.dy = 0;
  }
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      let x = a.x - b.x;
      let y = a.y - b.y;
      let d2 = x * x + y * y;
      if (d2 > cutoff * cutoff) {
        continue;
      }
      if (d2 < 0.01) {
        // Coincident nodes get a deterministic nudge apart.
        x = (i % 7) - 3 + 0.5;
        y = (j % 7) - 3 + 0.5;
        d2 = x * x + y * y;
      }
      const d = Math.sqrt(d2);
      const force = (k * k) / d;
      a.dx += (x / d) * force;
      a.dy += (y / d) * force;
      b.dx -= (x / d) * force;
      b.dy -= (y / d) * force;
    }
  }
  for (const e of edges) {
    const a = nodes[e.a]!;
    const b = nodes[e.b]!;
    const x = a.x - b.x;
    const y = a.y - b.y;
    const d = Math.max(Math.sqrt(x * x + y * y), 0.01);
    // Heavier co-occurrence pulls harder, dampened so one huge edge can't
    // collapse the map.
    const force = ((d * d) / k) * (1 + Math.log2(e.weight));
    a.dx -= ((x / d) * force) / Math.sqrt(a.degree);
    a.dy -= ((y / d) * force) / Math.sqrt(a.degree);
    b.dx += ((x / d) * force) / Math.sqrt(b.degree);
    b.dy += ((y / d) * force) / Math.sqrt(b.degree);
  }
  const maxStep = alpha * k;
  for (const n of nodes) {
    if (n.pinned) {
      continue;
    }
    // Gravity only bites outside the core ellipse, so the middle is free to
    // spread while unconnected tags settle into a halo instead of a far ring.
    // The ellipse is wider than tall, matching the canvas it is drawn in.
    const r = Math.hypot(n.x / aspect, n.y);
    if (r > core) {
      const pull = (0.18 * (r - core)) / r;
      n.dx -= (n.x * pull) / (aspect * aspect);
      n.dy -= n.y * pull;
    }
    const d = Math.max(Math.sqrt(n.dx * n.dx + n.dy * n.dy), 0.01);
    const limit = Math.min(d, maxStep) / d;
    n.x += n.dx * limit;
    n.y += n.dy * limit;
  }
}

/** Frames the whole graph in the canvas, with a little breathing room. */
function fit(
  layout: Layout,
  view: { scale: number; offsetX: number; offsetY: number },
  width: number,
  height: number,
): void {
  if (layout.nodes.length === 0) {
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of layout.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  const pad = 56;
  const scale = Math.min(
    (width - pad * 2) / Math.max(maxX - minX, 1),
    (height - pad * 2) / Math.max(maxY - minY, 1),
    2.5,
  );
  view.scale = scale;
  view.offsetX = -((minX + maxX) / 2) * scale;
  view.offsetY = -((minY + maxY) / 2) * scale;
}

export function GraphView({ slug, state }: { slug: string | null; state: AppState | null }) {
  const [minShared, setMinShared] = useState(3);
  const { data: graph, refresh } = useCached(`tag-graph:${minShared}`, () =>
    api.tagGraph(minShared),
  );
  const { data: tags } = useCached("tags", () => api.tags());

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const viewRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
  const alphaRef = useRef(1);
  // The view frames the whole graph automatically until the reader pans,
  // zooms, or drags — after that it is theirs.
  const framedRef = useRef(false);
  const [hover, setHover] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const layout = useMemo(() => (graph === null ? null : buildLayout(graph)), [graph]);
  layoutRef.current = layout;

  const tagging = state?.jobs.some((j) => j.process === "reactor:tagger") ?? false;
  useEffect(() => {
    if (!tagging) {
      return;
    }
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [tagging, refresh]);

  // Fresh data (or a new threshold) restarts the relaxation from its spiral.
  useEffect(() => {
    alphaRef.current = 1;
    framedRef.current = false;
  }, [layout]);

  const highlighted = useMemo(() => {
    const focus = hover ?? slug;
    if (focus === null || layout === null) {
      return null;
    }
    const set = new Set(layout.neighbors.get(focus) ?? []);
    set.add(focus);
    return set;
  }, [hover, slug, layout]);

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "" || layout === null) {
      return null;
    }
    return new Set(
      layout.nodes.filter((n) => n.name.toLowerCase().includes(q) || n.slug.includes(q)).map((n) => n.slug),
    );
  }, [query, layout]);

  // The render/simulate loop. Positions live in a ref, so relaxation never
  // re-renders React; only selection and hover do.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      return;
    }
    let frame = 0;
    const draw = () => {
      const current = layoutRef.current;
      const dpr = window.devicePixelRatio;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (current !== null) {
        if (alphaRef.current > 0.02) {
          step(current, alphaRef.current);
          alphaRef.current *= 0.985;
        }
        const view = viewRef.current;
        if (!framedRef.current) {
          fit(current, view, width, height);
        }
        const sx = (x: number) => x * view.scale + width / 2 + view.offsetX;
        const sy = (y: number) => y * view.scale + height / 2 + view.offsetY;

        for (const e of current.edges) {
          const a = current.nodes[e.a]!;
          const b = current.nodes[e.b]!;
          const lit =
            highlighted !== null && highlighted.has(a.slug) && highlighted.has(b.slug);
          if (highlighted !== null && !lit) {
            ctx.strokeStyle = "rgba(140, 150, 143, 0.10)";
            ctx.lineWidth = 0.6;
          } else {
            const strength = Math.min(0.1 + e.weight / 30, 0.5);
            ctx.strokeStyle = lit
              ? `rgba(36, 65, 59, ${Math.min(0.35 + e.weight / 25, 0.85)})`
              : `rgba(104, 114, 108, ${strength})`;
            ctx.lineWidth = lit ? 1.4 : 0.8;
          }
          ctx.beginPath();
          ctx.moveTo(sx(a.x), sy(a.y));
          ctx.lineTo(sx(b.x), sy(b.y));
          ctx.stroke();
        }

        const labelCandidates: Node[] = [];
        for (const n of current.nodes) {
          const dim =
            (highlighted !== null && !highlighted.has(n.slug)) ||
            (matching !== null && !matching.has(n.slug));
          const h = facetHue(n.facet);
          ctx.beginPath();
          ctx.arc(sx(n.x), sy(n.y), n.radius * Math.max(view.scale, 0.5), 0, Math.PI * 2);
          ctx.fillStyle = dim ? `hsl(${h} 18% 82%)` : `hsl(${h} 52% 58%)`;
          ctx.fill();
          if (n.slug === slug || n.slug === hover) {
            ctx.strokeStyle = "#1b2420";
            ctx.lineWidth = 1.6;
            ctx.stroke();
          }
          if (!dim) {
            labelCandidates.push(n);
          }
        }
        // Labels are placed biggest-first and skipped when they would collide,
        // so a dense middle reads as a few named landmarks rather than mush.
        ctx.font = "11px 'Instrument Sans', system-ui, sans-serif";
        ctx.textBaseline = "middle";
        labelCandidates.sort((a, b) => {
          const rank = (n: Node) => (n.slug === slug || n.slug === hover ? 1e6 : n.items);
          return rank(b) - rank(a);
        });
        const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
        for (const n of labelCandidates) {
          if (placed.length >= 60) {
            break;
          }
          const focused = n.slug === slug || n.slug === hover;
          if (!focused && highlighted === null && matching === null && view.scale < 1.2 && n.items < 8) {
            continue;
          }
          const x = sx(n.x) + n.radius * Math.max(view.scale, 0.5) + 4;
          const y = sy(n.y);
          const w = ctx.measureText(n.name).width;
          const box = { x0: x - 2, y0: y - 7, x1: x + w + 2, y1: y + 7 };
          if (box.x1 > width || box.x0 < 0 || box.y0 < 0 || box.y1 > height) {
            continue;
          }
          if (
            placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)
          ) {
            continue;
          }
          placed.push(box);
          ctx.fillStyle = "rgba(251, 252, 249, 0.85)";
          ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
          ctx.fillStyle = focused ? "#1b2420" : "#4a544e";
          ctx.fillText(n.name, x, y);
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [highlighted, matching, slug, hover]);

  const pick = useCallback((clientX: number, clientY: number): Node | null => {
    const canvas = canvasRef.current;
    const current = layoutRef.current;
    if (canvas === null || current === null) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    const wx = (clientX - rect.left - rect.width / 2 - view.offsetX) / view.scale;
    const wy = (clientY - rect.top - rect.height / 2 - view.offsetY) / view.scale;
    let best: Node | null = null;
    let bestDist = Infinity;
    for (const n of current.nodes) {
      const d = Math.hypot(n.x - wx, n.y - wy);
      const reach = Math.max(n.radius + 6 / view.scale, 8 / view.scale);
      if (d < reach && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }, []);

  const drag = useRef<{ node: Node | null; lastX: number; lastY: number; moved: boolean } | null>(
    null,
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const node = pick(e.clientX, e.clientY);
    if (node !== null) {
      node.pinned = true;
      framedRef.current = true;
    }
    drag.current = { node, lastX: e.clientX, lastY: e.clientY, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (d === null) {
      const node = pick(e.clientX, e.clientY);
      setHover(node?.slug ?? null);
      return;
    }
    const view = viewRef.current;
    const mx = e.clientX - d.lastX;
    const my = e.clientY - d.lastY;
    if (mx !== 0 || my !== 0) {
      d.moved = true;
    }
    if (d.node !== null) {
      d.node.x += mx / view.scale;
      d.node.y += my / view.scale;
      // Dragging a node re-energizes its neighbourhood so the map re-settles.
      alphaRef.current = Math.max(alphaRef.current, 0.25);
    } else {
      view.offsetX += mx;
      view.offsetY += my;
      framedRef.current = true;
    }
    d.lastX = e.clientX;
    d.lastY = e.clientY;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (d === null) {
      return;
    }
    // A click (as opposed to a drag) selects; a dragged node stays pinned.
    if (!d.moved) {
      if (d.node !== null) {
        d.node.pinned = false;
        navTo(`/graph/${encodeURIComponent(d.node.slug)}`);
      } else {
        navTo("/graph");
      }
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    const factor = Math.exp(-e.deltaY * 0.0016);
    const next = Math.min(Math.max(view.scale * factor, 0.2), 4);
    // Keep the point under the cursor fixed while zooming.
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    view.offsetX = cx - ((cx - view.offsetX) * next) / view.scale;
    view.offsetY = cy - ((cy - view.offsetY) * next) / view.scale;
    view.scale = next;
    framedRef.current = true;
  };

  const facetsPresent = useMemo(() => {
    if (graph === null) {
      return [];
    }
    const counts = new Map<string, number>();
    for (const n of graph.nodes) {
      counts.set(n.facet, (counts.get(n.facet) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [graph]);

  const empty = graph !== null && graph.nodes.length === 0;

  return (
    <div className="graph-view">
      <div className="entity-head">
        <span className="entity-kind">saved library</span>
        <h1>tag graph</h1>
      </div>
      <div className="run-row">
        <BusyButton className="primary" onClick={() => api.runTagger(false).then(refresh)}>
          Tag new items
        </BusyButton>
        <BusyButton
          title="Re-derive the whole tag vocabulary and re-tag every saved item"
          onClick={() => api.runTagger(true).then(refresh)}
        >
          Regenerate vocabulary
        </BusyButton>
        {tagging && <span className="working">tagging…</span>}
        {tags !== null && tags.vocabId !== null && (
          <span className="run-fact">
            {tags.tags.length} tags · {tags.tagged} items tagged
          </span>
        )}
      </div>

      {empty && (
        <div className="empty">
          No tags yet — "Tag new items" has a model read every saved paper, invent a few
          hundred granular tags for this collection, and hang several on each item.
        </div>
      )}

      {!empty && (
        <>
          <div className="graph-toolbar">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a tag"
            />
            <label className="graph-slider">
              min shared papers
              <input
                type="range"
                min={1}
                max={12}
                value={minShared}
                onChange={(e) => setMinShared(Number(e.target.value))}
              />
              <span className="mono">{minShared}</span>
            </label>
            {graph !== null && (
              <span className="run-fact">
                {graph.nodes.length} tags · {graph.edges.length} links
              </span>
            )}
            <button
              className="ghost"
              onClick={() => {
                alphaRef.current = 1;
                framedRef.current = false;
                for (const n of layoutRef.current?.nodes ?? []) {
                  n.pinned = false;
                }
              }}
            >
              Re-lay out
            </button>
          </div>

          <div className="graph-legend">
            {facetsPresent.map(([facet, n]) => (
              <span key={facet} className="legend-item">
                <span
                  className="legend-dot"
                  style={{ background: `hsl(${facetHue(facet)} 52% 58%)` }}
                />
                {facet}
                <span className="mono"> {n}</span>
              </span>
            ))}
          </div>

          <canvas
            ref={canvasRef}
            className="tag-canvas"
            style={{ height: canvasSize.height }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onWheel={onWheel}
          />
          <p className="graph-hint">
            drag a node to move it · drag the background to pan · scroll to zoom · click a tag
            for its papers
          </p>
        </>
      )}

      {slug !== null && <TagDetail slug={slug} />}
    </div>
  );
}

function TagDetail({ slug }: { slug: string }) {
  const { data: tag, error, refresh } = useCached(`tag:${slug}`, () => api.tag(slug));

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (tag === null) {
    return <div className="empty">loading…</div>;
  }
  const h = facetHue(tag.facet);
  return (
    <section className="tag-detail">
      <div className="entity-head">
        <span className="entity-kind" style={{ color: `hsl(${h} 42% 34%)` }}>
          {tag.facet}
        </span>
        <h1>{tag.name}</h1>
        <a className="crumb" href="#/graph">
          clear
        </a>
      </div>
      <p className="run-fact">{tag.description}</p>
      {tag.related.length > 0 && (
        <p className="tag-chips">
          {tag.related.map((r) => (
            <a key={r.slug} className="tag-chip" href={`#/graph/${encodeURIComponent(r.slug)}`}>
              {r.name} <span className="mono">{r.shared}</span>
            </a>
          ))}
        </p>
      )}
      <section className="link-group">
        {tag.items.map((item) => (
          <div key={item.entityId} className="link-row marked-row">
            <span className="link-kind">{item.kind}</span>
            <a className="link-name" href={`#/entity/${item.entityId}`}>
              {item.title ?? item.entityId}
            </a>
            <span className="link-provenance">{item.confidence.toFixed(2)}</span>
            <MarkButtons entityId={item.entityId} mark={item.mark} onChanged={refresh} />
          </div>
        ))}
      </section>
    </section>
  );
}
