import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  graphModeLabels,
  graphModeNoun,
  type AppState,
  type EntityGraph,
  type GraphMode,
  type GraphPaper,
} from "../api.js";
import { useCached } from "../cache.js";
import { ago, BusyButton, facetHue, MarkButtons, navTo, TagChips } from "../ui.js";
import { NodePanel } from "./TagView.js";

// The entity graph. A node is something saved papers belong to — a tag, an
// author, an affiliation — and two nodes are joined by the papers they share.
// Zoom in far enough and the papers themselves appear, each floating among
// the nodes it belongs to.
//
// The layout is a plain Fruchterman-Reingold spring simulation on a canvas —
// a few hundred nodes is small enough to run without a layout library. It runs
// exactly twice: once before the first paint, and again if you ask for a fresh
// one. Nothing animates. A cooling simulation is frozen by its step cap rather
// than settled at equilibrium, so re-heating it releases that stored tension
// through every node at once and the whole map lurches — the fix isn't a
// gentler constant, it's not re-heating at all. Dragging therefore moves the
// node you dragged and nothing else.

// Only the ratio matters to the layout — it shapes the ellipse the graph
// relaxes into, so the map fills a wide canvas rather than sitting in a disc.
/** The canvas's measured size; only its ratio matters, shaping the ellipse
 *  the graph relaxes into so the map fills whatever space it is given. */
const canvasSize = { width: 1180, height: 620 };
/** Ticks run before the first paint, so the map arrives already laid out. */
const prewarmTicks = 320;
/** Papers fade in over this zoom range; their titles at `paperLabelZoom`. */
const paperZoom = 1.15;
const paperFullZoom = 1.6;
const paperLabelZoom = 2.4;

interface Node {
  key: string;
  name: string;
  facet: string;
  items: number;
  radius: number;
  /** Edge count; hub attraction is normalized by it so hubs don't collapse. */
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dx: number;
  dy: number;
  /** Held in place by a drag; the simulation stops moving it. */
  pinned: boolean;
}

interface Edge {
  a: number;
  b: number;
  /** Papers shared. */
  shared: number;
  /** Summed membership strength over those papers. */
  weight: number;
}

interface PaperNode {
  entityId: string;
  title: string;
  facet: string;
  /** Indices into the tag nodes, with the strength of each membership. */
  tags: number[];
  weights: number[];
  x: number;
  y: number;
}

interface Layout {
  nodes: Node[];
  edges: Edge[];
  bykey: Map<string, number>;
  neighbors: Map<string, Set<string>>;
  /** Spring constant: the natural distance between two unrelated nodes. */
  k: number;
  /** Gravity-free radius: the disc the connected core is free to spread over. */
  core: number;
  papers: PaperNode[];
}

/**
 * `previous` seeds node positions when one exists, so sweeping the edge
 * threshold nudges the map the reader is looking at instead of re-forming a
 * different one from scratch.
 */
function buildLayout(graph: EntityGraph, previous: Layout | null): Layout {
  const nodes: Node[] = graph.nodes.map((n, i) => {
    // Golden-angle spiral: an even, deterministic starting spread, so the
    // same graph always relaxes into the same map.
    const angle = i * 2.39996;
    const r = 16 * Math.sqrt(i + 1);
    const seed = previous?.nodes[previous.bykey.get(n.key) ?? -1];
    return {
      key: n.key,
      name: n.name,
      facet: n.facet,
      items: n.items,
      radius: 3.5 + Math.sqrt(n.items) * 1.15,
      degree: 0,
      x: seed?.x ?? Math.cos(angle) * r,
      y: seed?.y ?? Math.sin(angle) * r,
      vx: 0,
      vy: 0,
      dx: 0,
      dy: 0,
      pinned: false,
    };
  });
  const bykey = new Map(nodes.map((n, i) => [n.key, i]));
  const edges: Edge[] = [];
  const neighbors = new Map<string, Set<string>>(nodes.map((n) => [n.key, new Set<string>()]));
  for (const e of graph.edges) {
    const a = bykey.get(e.source);
    const b = bykey.get(e.target);
    if (a === undefined || b === undefined) {
      continue;
    }
    edges.push({ a, b, shared: e.shared, weight: e.weight });
    nodes[a]!.degree++;
    nodes[b]!.degree++;
    neighbors.get(e.source)?.add(e.target);
    neighbors.get(e.target)?.add(e.source);
  }
  const area = canvasSize.width * canvasSize.height;
  const k = Math.sqrt(area / Math.max(nodes.length, 1));
  const layout: Layout = {
    nodes,
    edges,
    bykey,
    neighbors,
    k,
    core: (k * Math.sqrt(nodes.length)) / 3,
    papers: [],
  };
  relax(layout, previous === null ? 1 : 0.3);
  return layout;
}

/**
 * Runs the simulation to a standstill, all at once. `from` is the starting
 * temperature: a full 1 for a layout being formed, less for one being nudged.
 * The tick count is bounded by total work rather than a constant, so a
 * thousand-author graph doesn't freeze the tab while it relaxes.
 */
function relax(layout: Layout, from: number): void {
  const n = layout.nodes.length;
  const budget = Math.round(6e6 / Math.max((n * n) / 2, 1));
  const ticks = Math.round(Math.min(prewarmTicks, Math.max(60, budget)) * from);
  for (let i = 0; i < ticks; i++) {
    step(layout, Math.max(0.02, from * (1 - i / ticks)));
  }
}

/**
 * One Fruchterman-Reingold pass: repel nearby pairs, contract every edge.
 * Repulsion is cut off past a few spring lengths — otherwise the whole graph
 * pushes tags with no co-occurrences into a far-off ring and the connected
 * core collapses to a dot once the view frames them. Edge attraction is
 * normalized by degree so a hub sits among its neighbours instead of
 * swallowing them, and velocity is damped so nothing oscillates.
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
    // Strongly-shared tags pull harder, dampened so one heavy link can't
    // collapse the map.
    const force = ((d * d) / k) * (1 + Math.log2(1 + e.weight));
    a.dx -= ((x / d) * force) / Math.sqrt(a.degree);
    a.dy -= ((y / d) * force) / Math.sqrt(a.degree);
    b.dx += ((x / d) * force) / Math.sqrt(b.degree);
    b.dy += ((y / d) * force) / Math.sqrt(b.degree);
  }
  const maxStep = alpha * k;
  for (const n of nodes) {
    if (n.pinned) {
      n.vx = 0;
      n.vy = 0;
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
    // Damped velocity rather than raw displacement: a node approaches its
    // resting place instead of overshooting it every frame.
    n.vx = (n.vx + n.dx * limit) * 0.55;
    n.vy = (n.vy + n.dy * limit) * 0.55;
    n.x += n.vx;
    n.y += n.vy;
  }
  // Recentre on the centroid. Without this the connected core drifts off to
  // one side of the gravity ellipse and the loose tags fill the rest, so the
  // framed map ends up dense on one edge and empty on the other.
  let cx = 0;
  let cy = 0;
  for (const n of nodes) {
    cx += n.x;
    cy += n.y;
  }
  cx /= nodes.length;
  cy /= nodes.length;
  for (const n of nodes) {
    n.x -= cx;
    n.y -= cy;
  }
}

/** The strength-weighted centre of the tags a paper belongs to. */
function anchorOf(layout: Layout, p: PaperNode): { x: number; y: number; total: number } {
  let x = 0;
  let y = 0;
  let total = 0;
  p.tags.forEach((t, i) => {
    const w = p.weights[i]!;
    x += layout.nodes[t]!.x * w;
    y += layout.nodes[t]!.y * w;
    total += w;
  });
  return { x, y, total };
}

/**
 * Starting positions for the paper layer: each paper drops onto its anchor,
 * offset by a deterministic angle so co-tagged papers begin apart rather than
 * stacked, and the same library always looks the same.
 */
function seedPapers(layout: Layout): void {
  const spacing = layout.k / 3.2;
  for (const p of layout.papers) {
    const a = anchorOf(layout, p);
    if (a.total === 0) {
      continue;
    }
    const angle = (p.entityId.charCodeAt(0) * 13 + p.entityId.charCodeAt(9) * 7) % 360;
    p.x = a.x / a.total + Math.cos((angle * Math.PI) / 180) * spacing;
    p.y = a.y / a.total + Math.sin((angle * Math.PI) / 180) * spacing;
  }
}

/**
 * Relaxes the paper layer: each paper is pulled toward its anchor and pushed
 * off its neighbours through a uniform grid, so a popular pairing reads as a
 * cloud rather than one dot. Tags are unmoved by this — the map's skeleton
 * stays where the reader left it.
 */
function relaxPapers(layout: Layout, ticks: number): void {
  const { papers } = layout;
  if (papers.length === 0) {
    return;
  }
  const spacing = layout.k / 3.2;
  const cell = spacing * 1.6;
  const grid = new Map<string, PaperNode[]>();
  for (let tick = 0; tick < ticks; tick++) {
    grid.clear();
    for (const p of papers) {
      const key = `${Math.round(p.x / cell)}|${Math.round(p.y / cell)}`;
      const bucket = grid.get(key);
      if (bucket === undefined) {
        grid.set(key, [p]);
      } else {
        bucket.push(p);
      }
    }
    for (const p of papers) {
      let fx = 0;
      let fy = 0;
      const gx = Math.round(p.x / cell);
      const gy = Math.round(p.y / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (const q of grid.get(`${gx + ox}|${gy + oy}`) ?? []) {
            if (q === p) {
              continue;
            }
            const x = p.x - q.x;
            const y = p.y - q.y;
            const d = Math.hypot(x, y);
            if (d > spacing || d === 0) {
              continue;
            }
            fx += (x / d) * (spacing - d) * 0.5;
            fy += (y / d) * (spacing - d) * 0.5;
          }
        }
      }
      const a = anchorOf(layout, p);
      if (a.total > 0) {
        fx += (a.x / a.total - p.x) * 0.22;
        fy += (a.y / a.total - p.y) * 0.22;
      }
      // Cap the step so a crowded cell can't fling a paper across the map.
      const d = Math.hypot(fx, fy);
      const limit = d > spacing ? spacing / d : 1;
      p.x += fx * limit;
      p.y += fy * limit;
    }
  }
}

/**
 * Papers ride along with the node they were dragged by, each in proportion to
 * how strongly it belongs to it. The map stays consistent with no simulation,
 * so nothing moves that the reader didn't move.
 */
function shiftPapers(layout: Layout, index: number, dx: number, dy: number): void {
  for (const p of layout.papers) {
    const at = p.tags.indexOf(index);
    if (at === -1) {
      continue;
    }
    let total = 0;
    for (const w of p.weights) {
      total += w;
    }
    if (total === 0) {
      continue;
    }
    const share = p.weights[at]! / total;
    p.x += dx * share;
    p.y += dy * share;
  }
}

function attachPapers(layout: Layout, papers: readonly GraphPaper[]): void {
  layout.papers = papers.flatMap((p) => {
    const tags: number[] = [];
    const weights: number[] = [];
    for (const [key, strength] of p.tags) {
      const index = layout.bykey.get(key);
      if (index !== undefined) {
        tags.push(index);
        weights.push(strength);
      }
    }
    if (tags.length === 0) {
      return [];
    }
    return [
      {
        entityId: p.entityId,
        title: p.title,
        facet: layout.nodes[tags[0]!]!.facet,
        tags,
        weights,
        x: 0,
        y: 0,
      },
    ];
  });
  seedPapers(layout);
  relaxPapers(layout, 90);
}

interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Tag discs grow with zoom only up to a point. Past it they would swamp the
 * paper layer the reader zoomed in to see.
 */
function screenRadius(n: Node, view: View): number {
  return Math.max(n.radius * Math.min(Math.max(view.scale, 0.5), 1.5), 2.5);
}

/**
 * Frames the graph in the canvas, with a little breathing room. The bounds
 * are the 2nd–98th percentile rather than the extremes: a handful of stray
 * tags out on the rim would otherwise shove the dense middle off to one side.
 */
function fit(layout: Layout, view: View, width: number, height: number): void {
  if (layout.nodes.length === 0) {
    return;
  }
  const xs = layout.nodes.map((n) => n.x).sort((a, b) => a - b);
  const ys = layout.nodes.map((n) => n.y).sort((a, b) => a - b);
  const lo = Math.floor(xs.length * 0.02);
  const hi = Math.ceil(xs.length * 0.98) - 1;
  const minX = xs[lo]!;
  const maxX = xs[hi]!;
  const minY = ys[lo]!;
  const maxY = ys[hi]!;
  const pad = 56;
  view.scale = Math.min(
    (width - pad * 2) / Math.max(maxX - minX, 1),
    (height - pad * 2) / Math.max(maxY - minY, 1),
    2.5,
  );
  view.offsetX = -((minX + maxX) / 2) * view.scale;
  view.offsetY = -((minY + maxY) / 2) * view.scale;
}

/** How thin a node's membership can be before it's left out of the map. */
const defaultMinItems: Record<GraphMode, number> = { tags: 1, authors: 4, orgs: 2 };
/** Every tag pair shares papers; co-authorship is sparser, so the floor drops. */
const defaultMinShared: Record<GraphMode, number> = { tags: 3, authors: 2, orgs: 2 };

export function GraphView({
  mode,
  selected,
  paper,
  state,
}: {
  mode: GraphMode;
  /** The node whose panel is open in the rail. */
  selected: string | null;
  /** A paper selected in the map; it opens in the rail, not a new page. */
  paper: string | null;
  state: AppState | null;
}) {
  const [minShared, setMinShared] = useState(defaultMinShared[mode]);
  const [minItems, setMinItems] = useState(defaultMinItems[mode]);
  // Each mode has its own sensible floors: every tag is worth drawing, a
  // one-paper author is not, and co-authorship is far sparser than co-tagging.
  useEffect(() => {
    setMinItems(defaultMinItems[mode]);
    setMinShared(defaultMinShared[mode]);
  }, [mode]);
  const { data: graph, refresh } = useCached(`graph:${mode}:${minShared}:${minItems}`, () =>
    api.graph(mode, minShared, minItems),
  );
  const { data: papers } = useCached(`graph-papers:${mode}:${minItems}`, () =>
    api.graphPapers(mode, minItems),
  );
  const { data: tags } = useCached("tags", () => api.tags());

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const viewRef = useRef<View>({ scale: 1, offsetX: 0, offsetY: 0 });
  const dirtyRef = useRef(true);
  const [hover, setHover] = useState<{ kind: "tag" | "paper"; id: string } | null>(null);
  const [query, setQuery] = useState("");

  // Carrying the previous layout forward keeps the threshold slider from
  // reshuffling the whole map on every notch.
  const previousRef = useRef<Layout | null>(null);
  const layout = useMemo(() => {
    if (graph === null) {
      return null;
    }
    const next = buildLayout(graph, previousRef.current);
    previousRef.current = next;
    return next;
  }, [graph]);
  layoutRef.current = layout;

  useEffect(() => {
    if (layout !== null && papers !== null) {
      attachPapers(layout, papers.papers);
      dirtyRef.current = true;
    }
  }, [layout, papers]);

  const tagging = state?.jobs.some((j) => j.process === "reactor:tagger") ?? false;
  useEffect(() => {
    if (!tagging) {
      return;
    }
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [tagging, refresh]);

  const highlighted = useMemo(() => {
    if (layout === null) {
      return null;
    }
    // A selected paper lights up the tags it belongs to, so the rail and the
    // map are always describing the same thing.
    const focusPaper = hover?.kind === "paper" ? hover.id : paper;
    if (focusPaper !== null) {
      const p = layout.papers.find((q) => q.entityId === focusPaper);
      if (p !== undefined) {
        return new Set(p.tags.map((t) => layout.nodes[t]!.key));
      }
    }
    const focus = hover?.kind === "tag" ? hover.id : selected;
    if (focus === null) {
      return null;
    }
    const set = new Set(layout.neighbors.get(focus) ?? []);
    set.add(focus);
    return set;
  }, [hover, selected, paper, layout]);

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "" || layout === null) {
      return null;
    }
    return new Set(
      layout.nodes
        .filter((n) => n.name.toLowerCase().includes(q) || n.key.includes(q))
        .map((n) => n.key),
    );
  }, [query, layout]);

  // Everything the draw loop reads lives in refs, so hovering or selecting a
  // tag repaints without tearing down and restarting the animation frame.
  const paint = useRef({ highlighted, matching, selected, paper, hover });
  paint.current = { highlighted, matching, selected, paper, hover };
  useEffect(() => {
    dirtyRef.current = true;
  }, [highlighted, matching, selected, paper, hover]);

  // Frame the graph on the first layout; after that the view is the reader's
  // and a threshold change only redraws.
  const framedRef = useRef(false);
  useEffect(() => {
    framedRef.current = false;
  }, [mode]);
  useEffect(() => {
    if (layout === null || canvasRef.current === null) {
      return;
    }
    if (!framedRef.current) {
      framedRef.current = true;
      fit(layout, viewRef.current, canvasRef.current.clientWidth, canvasRef.current.clientHeight);
    }
    dirtyRef.current = true;
  }, [layout]);

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
      frame = requestAnimationFrame(draw);
      const current = layoutRef.current;
      const dpr = window.devicePixelRatio;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const resized =
        canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr);
      if (resized) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        // The next relaxation shapes its ellipse to the space it actually has.
        canvasSize.width = width;
        canvasSize.height = height;
      }
      if (!dirtyRef.current && !resized) {
        return;
      }
      dirtyRef.current = false;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (current !== null) {
        render(ctx, current, viewRef.current, width, height, paint.current);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: (clientX - rect.left - rect.width / 2 - view.offsetX) / view.scale,
      y: (clientY - rect.top - rect.height / 2 - view.offsetY) / view.scale,
    };
  }, []);

  const pick = useCallback(
    (clientX: number, clientY: number): { node: Node | null; paper: PaperNode | null } => {
      const current = layoutRef.current;
      if (canvasRef.current === null || current === null) {
        return { node: null, paper: null };
      }
      const view = viewRef.current;
      const { x, y } = toWorld(clientX, clientY);
      let node: Node | null = null;
      let best = Infinity;
      for (const n of current.nodes) {
        const d = Math.hypot(n.x - x, n.y - y);
        const reach = Math.max(screenRadius(n, view) / view.scale + 4 / view.scale, 8 / view.scale);
        if (d < reach && d < best) {
          node = n;
          best = d;
        }
      }
      if (node !== null || view.scale < paperZoom) {
        return { node, paper: null };
      }
      let paper: PaperNode | null = null;
      best = Infinity;
      for (const p of current.papers) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < 7 / view.scale && d < best) {
          paper = p;
          best = d;
        }
      }
      return { node: null, paper };
    },
    [toWorld],
  );

  const drag = useRef<{
    node: Node | null;
    paper: PaperNode | null;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const { node, paper } = pick(e.clientX, e.clientY);
    if (node !== null) {
      node.pinned = true;
    }
    drag.current = { node, paper, lastX: e.clientX, lastY: e.clientY, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (d === null) {
      const { node, paper } = pick(e.clientX, e.clientY);
      const next =
        node !== null
          ? ({ kind: "tag", id: node.key } as const)
          : paper !== null
            ? ({ kind: "paper", id: paper.entityId } as const)
            : null;
      setHover((prev) =>
        prev?.id === next?.id && prev?.kind === next?.kind ? prev : next,
      );
      return;
    }
    const view = viewRef.current;
    const mx = e.clientX - d.lastX;
    const my = e.clientY - d.lastY;
    if (Math.abs(mx) > 0 || Math.abs(my) > 0) {
      d.moved = true;
    }
    if (d.node !== null) {
      const dx = mx / view.scale;
      const dy = my / view.scale;
      d.node.x += dx;
      d.node.y += dy;
      shiftPapers(layoutRef.current!, layoutRef.current!.bykey.get(d.node.key)!, dx, dy);
    } else {
      view.offsetX += mx;
      view.offsetY += my;
    }
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    dirtyRef.current = true;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (d === null) {
      return;
    }
    if (d.node !== null) {
      // A dragged tag stays put; a clicked one is only selected.
      d.node.pinned = d.moved;
    }
    if (d.moved) {
      return;
    }
    if (d.node !== null) {
      navTo(`/graph/${mode}/${encodeURIComponent(d.node.key)}`);
    } else if (d.paper !== null) {
      navTo(`/graph/${mode}/paper/${d.paper.entityId}`);
    } else {
      navTo(`/graph/${mode}`);
    }
  };

  // Wheel must be a non-passive native listener: React's synthetic onWheel is
  // registered passively, so preventDefault there is ignored and zooming the
  // graph scrolls the page instead.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const view = viewRef.current;
      const next = Math.min(Math.max(view.scale * Math.exp(-e.deltaY * 0.0016), 0.2), 8);
      // Keep the point under the cursor fixed while zooming.
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      view.offsetX = cx - ((cx - view.offsetX) * next) / view.scale;
      view.offsetY = cy - ((cy - view.offsetY) * next) / view.scale;
      view.scale = next;
      dirtyRef.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

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

  const hoveredPaper =
    hover?.kind === "paper"
      ? (layout?.papers.find((p) => p.entityId === hover.id) ?? null)
      : null;
  const empty = graph !== null && graph.nodes.length === 0;

  return (
    <div className="graph-view">
      <div className="entity-head">
        <span className="entity-kind">saved library</span>
        <h1>{graphModeLabels[mode]} graph</h1>
        <nav className="graph-modes">
          {(Object.keys(graphModeLabels) as GraphMode[]).map((m) => (
            <a
              key={m}
              className={`graph-mode ${m === mode ? "on" : ""}`}
              href={`#/graph/${m}`}
            >
              {graphModeLabels[m]}
            </a>
          ))}
        </nav>
      </div>
      {mode === "tags" && (
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
      )}

      {empty && mode === "tags" && (
        <div className="empty">
          No tags yet — "Tag new items" has a model read every saved paper, invent a few
          hundred granular tags for this collection, and score how strongly each item
          belongs to each of them.
        </div>
      )}
      {empty && mode !== "tags" && (
        <div className="empty">
          Nothing to draw: no saved paper has an {mode === "authors" ? "author" : "affiliation"}{" "}
          recorded yet.
        </div>
      )}

      {!empty && (
        <>
          <div className="graph-toolbar">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Find ${graphModeNoun[mode]}`}
            />
            <label className="graph-slider">
              min papers each
              <input
                type="range"
                min={1}
                max={12}
                value={minItems}
                onChange={(e) => setMinItems(Number(e.target.value))}
              />
              <span className="mono">{minItems}</span>
            </label>
            <label className="graph-slider">
              min shared
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
                {graph.nodes.length} {graphModeLabels[mode]} · {graph.edges.length} links
              </span>
            )}
            <button
              className="ghost"
              title="Run the layout again from where things are now"
              onClick={() => {
                const current = layoutRef.current;
                const canvas = canvasRef.current;
                if (current === null || canvas === null) {
                  return;
                }
                for (const n of current.nodes) {
                  n.pinned = false;
                  n.vx = 0;
                  n.vy = 0;
                }
                relax(current, 0.5);
                seedPapers(current);
                relaxPapers(current, 90);
                fit(current, viewRef.current, canvas.clientWidth, canvas.clientHeight);
                dirtyRef.current = true;
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
                  style={{ background: `hsl(${facetHue(facet)} 34% 56%)` }}
                />
                {facet}
                <span className="mono"> {n}</span>
              </span>
            ))}
          </div>

          <div className="graph-layout">
            <div className="graph-stage">
              <canvas
                ref={canvasRef}
                className="tag-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={() => setHover(null)}
              />
              {hoveredPaper !== null && <div className="graph-tip">{hoveredPaper.title}</div>}
              <p className="graph-hint">
                drag a node to move it · drag the background to pan · scroll to zoom in until
                the papers appear · click for details
              </p>
            </div>
            <aside className="graph-rail">
              {paper !== null ? (
                <PaperDetail entityId={paper} backHref={`#/graph/${mode}`} />
              ) : selected !== null ? (
                <NodePanel
                  mode={mode}
                  nodeKey={selected}
                  // Chips in the rail keep you in the map; the page link leaves it.
                  chipHref={(key) => `#/graph/${mode}/${encodeURIComponent(key)}`}
                  actions={
                    <span className="rail-actions">
                      <a
                        className="crumb"
                        href={
                          mode === "tags"
                            ? `#/tag/${encodeURIComponent(selected)}`
                            : `#/entity/${selected}`
                        }
                      >
                        open the page →
                      </a>
                      <a className="crumb rail-clear" href={`#/graph/${mode}`}>
                        clear
                      </a>
                    </span>
                  }
                />
              ) : (
                <div className="rail-empty">
                  Click a node to see the papers that belong to it, how strongly, and what it
                  most often travels with. Zoom in and click a paper to read it here.
                </div>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

interface Paint {
  highlighted: Set<string> | null;
  matching: Set<string> | null;
  selected: string | null;
  paper: string | null;
  hover: { kind: "tag" | "paper"; id: string } | null;
}

function render(
  ctx: CanvasRenderingContext2D,
  layout: Layout,
  view: View,
  width: number,
  height: number,
  paint: Paint,
): void {
  const { highlighted, matching, selected } = paint;
  const hoverTag = paint.hover?.kind === "tag" ? paint.hover.id : null;
  const sx = (x: number) => x * view.scale + width / 2 + view.offsetX;
  const sy = (y: number) => y * view.scale + height / 2 + view.offsetY;

  for (const e of layout.edges) {
    const a = layout.nodes[e.a]!;
    const b = layout.nodes[e.b]!;
    const lit = highlighted !== null && highlighted.has(a.key) && highlighted.has(b.key);
    if (highlighted !== null && !lit) {
      ctx.strokeStyle = "rgba(36, 65, 59, 0.05)";
      ctx.lineWidth = 0.6;
    } else {
      // Line weight reads the summed membership, so the strongest kinships in
      // the library are the ones that stand out.
      const strength = Math.min(0.07 + e.weight / 26, 0.42);
      ctx.strokeStyle = lit
        ? `rgba(36, 65, 59, ${Math.min(0.3 + e.weight / 22, 0.8)})`
        : `rgba(36, 65, 59, ${strength})`;
      ctx.lineWidth = lit ? 1.3 : Math.min(0.5 + e.weight / 30, 1.6);
    }
    ctx.beginPath();
    ctx.moveTo(sx(a.x), sy(a.y));
    ctx.lineTo(sx(b.x), sy(b.y));
    ctx.stroke();
  }

  // Papers fade in as the reader zooms past the tag skeleton.
  const paperFade = Math.max(
    0,
    Math.min(1, (view.scale - paperZoom) / (paperFullZoom - paperZoom)),
  );
  const dimmedPapers = new Set<string>();
  if (paperFade > 0) {
    const r = 2.4 + 0.5 * Math.min(view.scale / paperFullZoom, 2);
    for (const p of layout.papers) {
      const dim =
        (highlighted !== null && !p.tags.some((t) => highlighted.has(layout.nodes[t]!.key))) ||
        (matching !== null && !p.tags.some((t) => matching.has(layout.nodes[t]!.key)));
      if (dim) {
        dimmedPapers.add(p.entityId);
      }
      const h = facetHue(p.facet);
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), r, 0, Math.PI * 2);
      ctx.fillStyle = dim
        ? `hsla(${h} 8% 74% / ${0.35 * paperFade})`
        : `hsla(${h} 32% 54% / ${0.75 * paperFade})`;
      ctx.fill();
    }
  }

  const labelCandidates: Node[] = [];
  for (const n of layout.nodes) {
    const dim =
      (highlighted !== null && !highlighted.has(n.key)) ||
      (matching !== null && !matching.has(n.key));
    const h = facetHue(n.facet);
    ctx.beginPath();
    ctx.arc(sx(n.x), sy(n.y), screenRadius(n, view), 0, Math.PI * 2);
    ctx.fillStyle = dim ? `hsl(${h} 10% 84%)` : `hsl(${h} 34% 56%)`;
    ctx.fill();
    if (n.key === selected || n.key === hoverTag) {
      ctx.strokeStyle = "#24413b";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    } else if (!dim) {
      // A pale rim keeps overlapping nodes readable where the map is dense.
      ctx.strokeStyle = "rgba(251, 252, 249, 0.85)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (!dim) {
      labelCandidates.push(n);
    }
  }

  // The paper under the cursor or open in the rail is drawn last and larger:
  // a 3px dot among a few hundred is otherwise impossible to find again.
  const markedPaper = paint.hover?.kind === "paper" ? paint.hover.id : paint.paper;
  if (markedPaper !== null && paperFade > 0) {
    const p = layout.papers.find((q) => q.entityId === markedPaper);
    if (p !== undefined) {
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.y), 5.5, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${facetHue(p.facet)} 38% 50%)`;
      ctx.fill();
      ctx.strokeStyle = "#24413b";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  // Labels are placed biggest-first and skipped when they would collide, so a
  // dense middle reads as a few named landmarks rather than mush.
  ctx.font = "11.5px 'Instrument Sans', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  labelCandidates.sort((a, b) => {
    const rank = (n: Node) => (n.key === selected || n.key === hoverTag ? 1e6 : n.items);
    return rank(b) - rank(a);
  });
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const claim = (box: { x0: number; y0: number; x1: number; y1: number }): boolean => {
    if (box.x1 > width || box.x0 < 0 || box.y0 < 0 || box.y1 > height) {
      return false;
    }
    if (placed.some((p) => box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0)) {
      return false;
    }
    placed.push(box);
    return true;
  };
  for (const n of labelCandidates) {
    if (placed.length >= 70) {
      break;
    }
    const focused = n.key === selected || n.key === hoverTag;
    if (
      !focused &&
      highlighted === null &&
      matching === null &&
      view.scale < 1.2 &&
      n.items < 8
    ) {
      continue;
    }
    const x = sx(n.x) + screenRadius(n, view) + 4;
    const y = sy(n.y);
    const w = ctx.measureText(n.name).width;
    if (!claim({ x0: x - 2, y0: y - 7, x1: x + w + 2, y1: y + 7 })) {
      continue;
    }
    ctx.fillStyle = "rgba(251, 252, 249, 0.86)";
    ctx.fillRect(x - 2, y - 7, w + 4, 14);
    ctx.fillStyle = focused ? "#1b2420" : "#4a544e";
    ctx.fillText(n.name, x, y);
  }

  // Paper titles only once the reader is right down among them.
  if (view.scale >= paperLabelZoom) {
    ctx.font = "10.5px 'Instrument Sans', system-ui, sans-serif";
    ctx.fillStyle = "#68726c";
    for (const p of layout.papers) {
      if (placed.length >= 220) {
        break;
      }
      if (dimmedPapers.has(p.entityId)) {
        continue;
      }
      const text = p.title.length > 52 ? `${p.title.slice(0, 51)}…` : p.title;
      const x = sx(p.x) + 5;
      const y = sy(p.y);
      const w = ctx.measureText(text).width;
      if (!claim({ x0: x - 2, y0: y - 6, x1: x + w + 2, y1: y + 6 })) {
        continue;
      }
      ctx.fillText(text, x, y);
    }
  }
}

/**
 * A paper read in the rail rather than on its own page: clicking a dot in the
 * map shouldn't cost you the view you zoomed in to find it.
 */
function PaperDetail({ entityId, backHref }: { entityId: string; backHref: string }) {
  const { data: page, error, refresh } = useCached(`entity:${entityId}`, () =>
    api.entity(entityId),
  );

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (page === null) {
    return <div className="empty">loading…</div>;
  }
  const { entity, paper, library } = page;
  return (
    <>
      <div className="rail-head">
        <span className="entity-kind">{entity.kind}</span>
        <a className="crumb rail-clear" href={backHref}>
          clear
        </a>
      </div>
      <h2 className="rail-title">{entity.displayName ?? entity.entityId}</h2>
      <MarkButtons entityId={entity.entityId} mark={page.mark} onChanged={refresh} />
      <TagChips tags={page.tags} hrefFor={(s) => `#/graph/tags/${encodeURIComponent(s)}`} />
      {paper !== null && (
        <>
          <p className="verdict-authors rail-authors">{paper.authors.join(", ")}</p>
          <p className="rail-abstract">{paper.abstract}</p>
          <p className="run-fact">
            <a
              className="arxiv-id"
              href={`https://arxiv.org/abs/${paper.arxiv_id}`}
              target="_blank"
              rel="noreferrer"
            >
              arxiv.org/abs/{paper.arxiv_id} ↗
            </a>
            {" · ingested "}
            {ago(paper.ingested_at)}
          </p>
        </>
      )}
      {paper === null && library !== null && (
        <p className="run-fact">
          {library.authors.join(", ")}
          {library.year !== null ? ` · ${library.year}` : ""}
          {library.journal !== null ? ` · ${library.journal}` : ""}
        </p>
      )}
      <a className="crumb rail-full" href={`#/entity/${entity.entityId}`}>
        open the full page →
      </a>
    </>
  );
}
