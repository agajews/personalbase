import { existsSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { z } from "zod";
import {
  appendEvents,
  connect,
  kernelMigrationsDir,
  migrate,
  type Sql,
} from "@nc/log";
import { coreRegistry } from "@nc/schema";
import { catchUpFolds, enqueueJob } from "@nc/process";
import { streamSSE } from "hono/streaming";
import { streamChat } from "./chat.js";
import {
  entityId,
  filterResultsFold,
  filtersFold,
  graphFold,
  libraryFold,
  devFold,
  chatsFold,
  marksFold,
  papersFold,
  paperRef,
  personRef,
  taxonomyFold,
} from "@nc/folds";

// The UI reads folds and appends events / enqueues jobs. It never runs
// reactors — the worker daemon (local or Fly) picks jobs up through the
// database. Fold catch-up here is safe alongside the daemon because the fold
// runner takes a per-fold advisory lock.
const folds = [
  papersFold,
  filtersFold,
  filterResultsFold,
  graphFold,
  libraryFold,
  marksFold,
  taxonomyFold,
  devFold,
  chatsFold,
];

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql: Sql = connect(databaseUrl);
// Preview mode (dev agents' sandboxes): read-only database credentials, so
// migrations can't (and shouldn't) run; transport auth is the sandbox's
// SSO-gated URL rather than UI_PASSWORD.
const previewMode = process.env["NC_PREVIEW"] === "1";
if (!previewMode) {
  await migrate(sql, kernelMigrationsDir);
}

const app = new Hono();

// ---- auth ----
// Enabled whenever UI_PASSWORD is set (always in deployment; local dev binds
// to 127.0.0.1 and runs open). Sessions are cookies signed with a key derived
// from the password, so rotating the password invalidates every session. The
// guard must be registered before the routes it protects.
const uiPassword = process.env["UI_PASSWORD"] ?? "";
const host = process.env["HOST"] ?? "127.0.0.1";
const port = Number(process.env["PORT"] ?? 4680);
if (uiPassword === "" && host !== "127.0.0.1" && host !== "localhost" && !previewMode) {
  console.error(`refusing to bind ${host} without UI_PASSWORD set`);
  process.exit(1);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const loginPage = (message: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>personalbase</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #111; color: #ddd;
         display: grid; place-items: center; min-height: 100dvh; margin: 0; }
  form { display: flex; gap: 8px; flex-direction: column; width: min(320px, 80vw); }
  input { font-size: 16px; padding: 10px 12px; border-radius: 8px; border: 1px solid #444;
          background: #1c1c1c; color: #eee; }
  button { font-size: 15px; padding: 10px; border-radius: 8px; border: none;
           background: #3a6ea5; color: white; cursor: pointer; }
  .msg { color: #d08080; font-size: 13px; min-height: 1em; }
</style></head>
<body><form method="post" action="/login">
  <input type="password" name="password" placeholder="password" autofocus autocomplete="current-password">
  <button type="submit">enter</button>
  <div class="msg">${message}</div>
</form></body></html>`;

if (uiPassword !== "") {
  const cookieSecret = createHmac("sha256", uiPassword).update("nc-ui-session").digest("hex");
  const session = { path: "/", httpOnly: true, secure: true, sameSite: "Lax" as const,
                    maxAge: 90 * 86_400 };
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/login", (c) => c.html(loginPage("")));
  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const password = typeof form["password"] === "string" ? form["password"] : "";
    if (!safeEqual(password, uiPassword)) {
      return c.html(loginPage("wrong password"), 401);
    }
    await setSignedCookie(c, "nc_session", "ok", cookieSecret, session);
    return c.redirect("/");
  });
  app.use("*", async (c, next) => {
    if ((await getSignedCookie(c, cookieSecret, "nc_session")) === "ok") {
      return next();
    }
    // Bearer <password> lets curl and future agents skip the cookie dance.
    const bearer = c.req.header("authorization") ?? "";
    if (safeEqual(bearer, `Bearer ${uiPassword}`)) {
      return next();
    }
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.redirect("/login");
  });
}

function dateRange(days: number): { from: string; to: string } {
  const to = new Date();
  return { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() };
}

// Read endpoints are pure reads: the worker daemon keeps folds caught up
// every 2s, and folding on the request path both delays responses and
// contends on the per-fold advisory locks under polling load.
app.get("/api/state", async (c) => {
  const filters = await sql`
    select name, model, prompt, prompt_hash from filters order by name`;
  const counts = await sql`
    select filter_name, prompt_hash, verdict, count(*)::int as n
    from filter_results group by filter_name, prompt_hash, verdict`;
  const papers = await sql`
    select count(*)::int as total, max(updated_at) as latest from papers`;
  const jobs = await sql`
    select job_id, process, payload, status, attempts, run_after
    from jobs where status in ('pending', 'running')
    order by created_at`;
  const runs = await sql`
    select process, status, started_at, finished_at, emitted_count,
           tokens_in, tokens_out, error
    from runs order by started_at desc limit 8`;
  const tail = await sql`
    select seq, type, source, occurred_at from events order by seq desc limit 10`;
  const markCounts = await sql`
    select mark, count(*)::int as n from paper_marks group by mark`;
  return c.json({
    marks: {
      saved: markCounts.find((m) => m["mark"] === "saved")?.["n"] ?? 0,
      wantToRead: markCounts.find((m) => m["mark"] === "want_to_read")?.["n"] ?? 0,
    },
    filters: filters.map((f) => ({
      name: f["name"],
      model: f["model"],
      prompt: f["prompt"],
      promptHash: f["prompt_hash"],
      matches: counts.find(
        (x) => x["filter_name"] === f["name"] && x["prompt_hash"] === f["prompt_hash"] && x["verdict"] === "match",
      )?.["n"] ?? 0,
      rejects: counts.find(
        (x) => x["filter_name"] === f["name"] && x["prompt_hash"] === f["prompt_hash"] && x["verdict"] === "reject",
      )?.["n"] ?? 0,
    })),
    papers: { total: papers[0]!["total"], latest: papers[0]!["latest"] },
    jobs,
    runs,
    tail: tail.map((e) => ({ ...e, seq: String(e["seq"]) })).reverse(),
  });
});

app.get("/api/results/:name", async (c) => {
  const name = c.req.param("name");
  // Pure read; see the note on /api/state.
  const filter = (await sql`select prompt_hash from filters where name = ${name}`)[0];
  if (filter === undefined) {
    return c.json({ error: `no filter named ${name}` }, 404);
  }
  const rows = await sql`
    select r.arxiv_id, r.verdict, r.confidence, r.reason,
           p.title, p.abstract, p.categories, p.authors, p.updated_at
    from filter_results r
    join papers p on p.arxiv_id = r.arxiv_id
    where r.filter_name = ${name} and r.prompt_hash = ${filter["prompt_hash"]}
    order by r.confidence desc`;
  // Institution links live in the graph: paper entity -> org entities.
  const paperIds = new Map(rows.map((r) => [entityId("paper", paperRef(r["arxiv_id"])), r["arxiv_id"]]));
  const orgLinks =
    paperIds.size === 0
      ? []
      : await sql`
          select l.from_id, e.display_name, e.entity_id
          from links l
          join entities e on e.entity_id = l.to_id
          where l.from_id = any(${[...paperIds.keys()]})
            and l.link_type in ('published_by', 'affiliated_org')
            and e.kind = 'org'`;
  const orgsByArxivId = new Map<string, Map<string, string>>();
  for (const link of orgLinks) {
    const arxivId = paperIds.get(link["from_id"])!;
    const map = orgsByArxivId.get(arxivId) ?? new Map<string, string>();
    map.set(link["entity_id"], link["display_name"]);
    orgsByArxivId.set(arxivId, map);
  }
  const markRows =
    paperIds.size === 0
      ? []
      : await sql`
          select entity_id, mark from paper_marks where entity_id = any(${[...paperIds.keys()]})`;
  const markById = new Map(markRows.map((m) => [m["entity_id"], m["mark"]]));
  const shape = (r: (typeof rows)[number]) => ({
    arxivId: r["arxiv_id"],
    entityId: entityId("paper", paperRef(r["arxiv_id"])),
    mark: markById.get(entityId("paper", paperRef(r["arxiv_id"]))) ?? null,
    title: r["title"],
    abstract: r["abstract"],
    categories: r["categories"],
    authors: (r["authors"] as string[]).map((name) => ({
      name,
      entityId: entityId("person", personRef(name)),
    })),
    orgs: [...(orgsByArxivId.get(r["arxiv_id"]) ?? new Map<string, string>())].map(
      ([eid, name]) => ({ entityId: eid, name }),
    ),
    confidence: Number(r["confidence"]),
    reason: r["reason"],
    updatedAt: r["updated_at"],
  });
  return c.json({
    promptHash: filter["prompt_hash"],
    matches: rows.filter((r) => r["verdict"] === "match").map(shape),
    rejects: rows.filter((r) => r["verdict"] === "reject").map(shape),
  });
});

// The daily surface: papers from the window that either passed any filter's
// current-prompt judge or carry a published_by link from a tracked lab.
app.get("/api/feed", async (c) => {
  const days = Number(c.req.query("days") ?? 3);
  if (!Number.isFinite(days) || days <= 0 || days > 60) {
    return c.json({ error: `invalid days: ${c.req.query("days")}` }, 400);
  }
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  // Recency = paper is new on arXiv OR new to us (lab backfills ingest older
  // papers; they should still surface the day they arrive).
  const matches = await sql`
    select r.arxiv_id, r.filter_name, r.confidence, r.reason
    from filter_results r
    join filters f on f.name = r.filter_name and f.prompt_hash = r.prompt_hash
    join papers p on p.arxiv_id = r.arxiv_id
    where r.verdict = 'match' and (p.updated_at >= ${from} or p.ingested_at >= ${from})`;
  const windowPapers = await sql`
    select arxiv_id from papers where updated_at >= ${from} or ingested_at >= ${from}`;
  const idToArxiv = new Map(
    windowPapers.map((p) => [entityId("paper", paperRef(p["arxiv_id"])), p["arxiv_id"]]),
  );
  const labLinks =
    idToArxiv.size === 0
      ? []
      : await sql`
          select l.from_id, e.display_name, e.entity_id
          from links l
          join entities e on e.entity_id = l.to_id
          where l.from_id = any(${[...idToArxiv.keys()]})
            and l.link_type = 'published_by' and e.kind = 'org'`;

  const surfaced = new Map<
    string,
    {
      matches: { filter: string; confidence: number; reason: string }[];
      labs: Map<string, string>;
    }
  >();
  const entry = (arxivId: string) => {
    const existing = surfaced.get(arxivId) ?? { matches: [], labs: new Map<string, string>() };
    surfaced.set(arxivId, existing);
    return existing;
  };
  for (const m of matches) {
    entry(m["arxiv_id"]).matches.push({
      filter: m["filter_name"],
      confidence: Number(m["confidence"]),
      reason: m["reason"],
    });
  }
  for (const l of labLinks) {
    entry(idToArxiv.get(l["from_id"])!).labs.set(l["entity_id"], l["display_name"]);
  }
  if (surfaced.size === 0) {
    return c.json({ days, items: [] });
  }
  const papers = await sql`
    select arxiv_id, title, abstract, authors, categories, published_at, updated_at
    from papers where arxiv_id = any(${[...surfaced.keys()]})`;
  const feedMarkRows = await sql`
    select entity_id, mark from paper_marks
    where entity_id = any(${papers.map((p) => entityId("paper", paperRef(p["arxiv_id"])))})`;
  const feedMarkById = new Map(feedMarkRows.map((m) => [m["entity_id"], m["mark"]]));
  const items = papers
    .map((p) => {
      const why = surfaced.get(p["arxiv_id"])!;
      return {
        arxivId: p["arxiv_id"],
        entityId: entityId("paper", paperRef(p["arxiv_id"])),
        mark: feedMarkById.get(entityId("paper", paperRef(p["arxiv_id"]))) ?? null,
        title: p["title"],
        abstract: p["abstract"],
        authors: (p["authors"] as string[]).map((name) => ({
          name,
          entityId: entityId("person", personRef(name)),
        })),
        categories: p["categories"],
        publishedAt: p["published_at"],
        updatedAt: p["updated_at"],
        labs: [...why.labs].map(([eid, name]) => ({ entityId: eid, name })),
        matches: why.matches.sort((a, b) => b.confidence - a.confidence),
      };
    })
    // Newest publication date first; within a day, labs and high-confidence
    // matches lead. Old lab backfills sink to the bottom naturally.
    .sort((a, b) => {
      const day = (i: typeof a) => new Date(i.publishedAt).toISOString().slice(0, 10);
      if (day(a) !== day(b)) {
        return day(a) < day(b) ? 1 : -1;
      }
      const score = (i: typeof a) =>
        (i.labs.length > 0 ? 1 : 0) + (i.matches[0]?.confidence ?? 0);
      return score(b) - score(a);
    });
  return c.json({ days, items });
});

// The Today view's second shelf: a slice of the saved library, reshuffled
// once a day. md5(entity_id || day) is a deterministic shuffle — the same
// order for every request on that UTC day, a different one tomorrow — so a
// reload shows the same papers and asking for more rows extends the sample
// instead of re-drawing it.
app.get("/api/today/resurfaced", async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 25)));
  const day = new Date().toISOString().slice(0, 10);
  const totalRows = await sql`select count(*)::int as n from paper_marks where mark = 'saved'`;
  // Marks live on entities, so the library's Paperpile-backed items count too
  // (lateral: one entity can carry several Paperpile rows).
  const rows = await sql`
    select m.entity_id, m.marked_at, e.kind,
           coalesce(p.title, li.title, e.display_name) as title,
           coalesce(p.abstract, li.abstract) as abstract,
           coalesce(p.authors, li.authors, '[]'::jsonb) as authors,
           coalesce(p.categories, '[]'::jsonb) as categories,
           coalesce(p.arxiv_id, li.arxiv_id) as arxiv_id,
           li.year, li.journal
    from paper_marks m
    join entities e on e.entity_id = m.entity_id
    left join papers p on p.entity_id = m.entity_id
    left join lateral (
      select title, abstract, authors, year, journal, arxiv_id
      from library_items where entity_id = m.entity_id order by added_at limit 1
    ) li on true
    where m.mark = 'saved'
    order by md5(m.entity_id::text || ${day})
    limit ${limit}`;
  return c.json({
    day,
    total: totalRows[0]!["n"],
    items: rows.map((r) => ({
      entityId: r["entity_id"],
      kind: r["kind"],
      title: r["title"],
      abstract: r["abstract"],
      authors: (r["authors"] as string[]).map((name) => ({
        name,
        entityId: entityId("person", personRef(name)),
      })),
      categories: r["categories"],
      arxivId: r["arxiv_id"],
      journal: r["journal"],
      year: r["year"],
      markedAt: r["marked_at"],
    })),
  });
});

// The papers browser: every paper in the system, sortable and filterable.
const paperSortColumns = {
  published: "published_at",
  ingested: "ingested_at",
  title: "title",
} as const;

app.get("/api/papers", async (c) => {
  const sortKey = (c.req.query("sort") ?? "published") as keyof typeof paperSortColumns;
  const sortCol = paperSortColumns[sortKey];
  if (sortCol === undefined) {
    return c.json({ error: `unknown sort ${sortKey}` }, 400);
  }
  const asc = c.req.query("dir") === "asc";
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const markParam = c.req.query("mark"); // saved | want_to_read | unmarked | undefined
  const q = (c.req.query("q") ?? "").trim();
  const category = (c.req.query("category") ?? "").trim();

  const qCond = q === "" ? sql`true` : sql`p.title ilike ${"%" + q + "%"}`;
  // jsonb ? operator: array contains the string. (Never `${param}::jsonb` —
  // postgres.js JSON-encodes the parameter again, yielding a jsonb string.)
  const catCond = category === "" ? sql`true` : sql`p.categories ? ${category}`;
  const markCond =
    markParam === "saved"
      ? sql`m.mark in ('saved', 'want_to_read')`
      : markParam === "want_to_read"
        ? sql`m.mark = 'want_to_read'`
        : markParam === "unmarked"
          ? sql`m.mark is null`
          : sql`true`;
  const order = asc ? sql`asc` : sql`desc`;

  const totalRows = await sql`
    select count(*)::int as n
    from papers p left join paper_marks m on m.entity_id = p.entity_id
    where ${qCond} and ${markCond} and ${catCond}`;
  const rows = await sql`
    select p.arxiv_id, p.entity_id, p.title, p.abstract, p.authors, p.categories,
           p.published_at, p.updated_at, p.ingested_at, m.mark
    from papers p left join paper_marks m on m.entity_id = p.entity_id
    where ${qCond} and ${markCond} and ${catCond}
    order by ${sql(sortCol)} ${order} nulls last, p.arxiv_id
    limit ${limit} offset ${offset}`;

  const orgLinks =
    rows.length === 0
      ? []
      : await sql`
          select l.from_id, e.display_name, e.entity_id
          from links l join entities e on e.entity_id = l.to_id
          where l.from_id = any(${rows.map((r) => r["entity_id"])})
            and l.link_type in ('published_by', 'affiliated_org') and e.kind = 'org'`;
  const orgsByPaper = new Map<string, Map<string, string>>();
  for (const link of orgLinks) {
    const map = orgsByPaper.get(link["from_id"]) ?? new Map<string, string>();
    map.set(link["entity_id"], link["display_name"]);
    orgsByPaper.set(link["from_id"], map);
  }
  return c.json({
    total: totalRows[0]!["n"],
    offset,
    items: rows.map((r) => ({
      arxivId: r["arxiv_id"],
      entityId: r["entity_id"],
      mark: r["mark"],
      title: r["title"],
      abstract: r["abstract"],
      categories: r["categories"],
      authors: (r["authors"] as string[]).map((name) => ({
        name,
        entityId: entityId("person", personRef(name)),
      })),
      orgs: [...(orgsByPaper.get(r["entity_id"]) ?? new Map<string, string>())].map(
        ([eid, name]) => ({ entityId: eid, name }),
      ),
      publishedAt: r["published_at"],
      ingestedAt: r["ingested_at"],
    })),
  });
});

// ---- exploration: entity pages, search, raw tables ----

app.get("/api/entity/:id", async (c) => {
  const id = c.req.param("id");
  const entityRows = await sql`
    select entity_id, kind, display_name, created_seq from entities where entity_id = ${id}`;
  const entity = entityRows[0];
  if (entity === undefined) {
    return c.json({ error: "no such entity" }, 404);
  }
  const linksOut = await sql`
    select l.link_type, l.asserted_by, l.confidence, e.entity_id, e.kind, e.display_name
    from links l join entities e on e.entity_id = l.to_id
    where l.from_id = ${id} order by l.created_seq desc limit 500`;
  const linksIn = await sql`
    select l.link_type, l.asserted_by, l.confidence, e.entity_id, e.kind, e.display_name
    from links l join entities e on e.entity_id = l.from_id
    where l.to_id = ${id} order by l.created_seq desc limit 500`;
  const identifiers = await sql`
    select scheme, value from identifiers where entity_id = ${id} order by scheme`;
  const paperRows = await sql`
    select arxiv_id, arxiv_version, title, abstract, authors, categories,
           published_at, updated_at, ingested_at
    from papers where entity_id = ${id}`;
  const libraryRows = await sql`
    select paperpile_id, title, authors, pubtype, year, arxiv_id, doi, url,
           journal, folders, added_at
    from library_items where entity_id = ${id}`;
  const paper = paperRows[0] ?? null;
  const verdicts =
    paper === null
      ? []
      : await sql`
          select distinct on (r.filter_name)
                 r.filter_name, r.verdict, r.confidence, r.reason,
                 (f.prompt_hash = r.prompt_hash) as current
          from filter_results r join filters f on f.name = r.filter_name
          where r.arxiv_id = ${paper["arxiv_id"]}
          order by r.filter_name, (f.prompt_hash = r.prompt_hash) desc, r.decided_seq desc`;
  const shapeLink = (l: (typeof linksOut)[number]) => ({
    linkType: l["link_type"],
    assertedBy: l["asserted_by"],
    confidence: Number(l["confidence"]),
    other: { entityId: l["entity_id"], kind: l["kind"], displayName: l["display_name"] },
  });
  const markRow = await sql`select mark from paper_marks where entity_id = ${id}`;
  return c.json({
    entity: {
      entityId: entity["entity_id"],
      kind: entity["kind"],
      displayName: entity["display_name"],
    },
    mark: markRow[0]?.["mark"] ?? null,
    identifiers,
    linksOut: linksOut.map(shapeLink),
    linksIn: linksIn.map(shapeLink),
    paper,
    library: libraryRows[0] ?? null,
    verdicts,
  });
});

app.get("/api/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q === "") {
    return c.json({ papers: [], people: [], orgs: [], other: [] });
  }
  // Scale is small enough for on-the-fly tsvectors; move to indexed columns
  // in the folds when this measurably slows.
  const papers = await sql`
    select entity_id, arxiv_id, title, abstract from papers
    where to_tsvector('english', title || ' ' || abstract)
          @@ websearch_to_tsquery('english', ${q})
    limit 25`;
  const library = await sql`
    select entity_id, title, pubtype, arxiv_id from library_items
    where to_tsvector('english', title || ' ' || coalesce(abstract, ''))
          @@ websearch_to_tsquery('english', ${q})
    limit 25`;
  const named = await sql`
    select entity_id, kind, display_name from entities
    where display_name ilike ${"%" + q + "%"} and kind in ('person', 'org')
    order by kind, length(display_name) limit 40`;
  const seen = new Set(papers.map((p) => p["entity_id"]));
  return c.json({
    papers: papers.map((p) => ({
      entityId: p["entity_id"],
      arxivId: p["arxiv_id"],
      title: p["title"],
      abstract: p["abstract"],
    })),
    other: library
      .filter((l) => !seen.has(l["entity_id"]))
      .map((l) => ({
        entityId: l["entity_id"],
        title: l["title"],
        pubtype: l["pubtype"],
        arxivId: l["arxiv_id"],
      })),
    people: named
      .filter((e) => e["kind"] === "person")
      .map((e) => ({ entityId: e["entity_id"], displayName: e["display_name"] })),
    orgs: named
      .filter((e) => e["kind"] === "org")
      .map((e) => ({ entityId: e["entity_id"], displayName: e["display_name"] })),
  });
});

async function tableNames(): Promise<string[]> {
  const rows = await sql`
    select tablename from pg_tables where schemaname = 'public' order by tablename`;
  return rows.map((r) => r["tablename"]);
}

app.get("/api/tables", async (c) => {
  const names = await tableNames();
  const counts = await sql`
    select relname, n_live_tup from pg_stat_user_tables where schemaname = 'public'`;
  const byName = new Map(counts.map((r) => [r["relname"], Number(r["n_live_tup"])]));
  return c.json({ tables: names.map((name) => ({ name, rows: byName.get(name) ?? 0 })) });
});

app.get("/api/tables/:name", async (c) => {
  const name = c.req.param("name");
  const names = await tableNames();
  if (!names.includes(name)) {
    return c.json({ error: `no table named ${name}` }, 404);
  }
  const columns = (
    await sql`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = ${name}
      order by ordinal_position`
  ).map((r) => ({ name: r["column_name"] as string, type: r["data_type"] as string }));
  const sortParam = c.req.query("sort");
  const dir = c.req.query("dir") === "asc" ? "asc" : "desc";
  const sort =
    sortParam !== undefined && columns.some((col) => col.name === sortParam)
      ? sortParam
      : columns[0]!.name;
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  // name, sort, and dir are validated against catalog values above.
  const rows = await sql.unsafe(
    `select * from "${name}" order by "${sort}" ${dir} nulls last limit ${limit} offset ${offset}`,
  );
  const total = await sql.unsafe(`select count(*)::int as n from "${name}"`);
  return c.json({
    name,
    columns,
    sort,
    dir,
    offset,
    total: total[0]!["n"],
    rows: rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          typeof v === "object" && v !== null && !(v instanceof Date) ? JSON.stringify(v) : v,
        ]),
      ),
    ),
  });
});

const filterBody = z.object({
  name: z.string().min(1).max(64),
  prompt: z.string().min(1),
  model: z.string().min(1),
});

app.post("/api/filters", async (c) => {
  const body = filterBody.parse(await c.req.json());
  await appendEvents(sql, coreRegistry, [
    {
      type: "user.filter.defined",
      schemaVersion: 1,
      source: "ui:web",
      occurredAt: new Date().toISOString(),
      payload: body,
    },
  ]);
  await catchUpFolds(sql, coreRegistry, folds);
  return c.json({ ok: true });
});

const runBody = z.object({ name: z.string().min(1), days: z.number().min(0.1).max(60) });

app.post("/api/jobs/filter", async (c) => {
  const body = runBody.parse(await c.req.json());
  const exists = await sql`select 1 from filters where name = ${body.name}`;
  if (exists.length === 0) {
    return c.json({ error: `no filter named ${body.name}` }, 404);
  }
  const jobId = await enqueueJob(sql, "reactor:paper-filter", {
    ...dateRange(body.days),
    filter: body.name,
  });
  return c.json({ jobId });
});

const ingestBody = z.object({
  days: z.number().min(0.1).max(60),
  categories: z.array(z.string().min(1)).optional(),
});

app.post("/api/jobs/ingest", async (c) => {
  const body = ingestBody.parse(await c.req.json());
  const jobId = await enqueueJob(sql, "reactor:arxiv", {
    ...dateRange(body.days),
    ...(body.categories === undefined || body.categories.length === 0
      ? {}
      : { categories: body.categories }),
  });
  return c.json({ jobId });
});

const markBody = z.object({
  entityId: z.string().uuid(),
  mark: z.enum(["saved", "want_to_read", "none"]),
});

app.post("/api/mark", async (c) => {
  const body = markBody.parse(await c.req.json());
  const target = (
    await sql`select kind, ref from entities where entity_id = ${body.entityId}`
  )[0];
  if (target === undefined) {
    return c.json({ error: "no such entity" }, 404);
  }
  if (target["kind"] !== "paper" && target["kind"] !== "resource") {
    return c.json({ error: `cannot mark a ${target["kind"]}` }, 400);
  }
  await appendEvents(sql, coreRegistry, [
    {
      type: "user.paper.marked",
      schemaVersion: 2,
      source: "ui:web",
      occurredAt: new Date().toISOString(),
      payload: { target: { kind: target["kind"], ref: target["ref"] }, mark: body.mark },
    },
  ]);
  await catchUpFolds(sql, coreRegistry, folds);
  return c.json({ ok: true });
});

app.get("/api/categories", async (c) => {
  const rows = await sql`
    select c as name, count(*)::int as n
    from papers, jsonb_array_elements_text(categories) as c
    group by c order by n desc limit 60`;
  return c.json({ categories: rows.map((r) => ({ name: r["name"], papers: r["n"] })) });
});

app.get("/api/marked/:mark", async (c) => {
  const mark = c.req.param("mark");
  if (mark !== "saved" && mark !== "want_to_read") {
    return c.json({ error: `unknown mark ${mark}` }, 404);
  }
  // The saved view includes the want_to_read tier above it.
  const marks = mark === "saved" ? ["saved", "want_to_read"] : ["want_to_read"];
  const rows = await sql`
    select m.entity_id, m.mark, m.marked_at, e.display_name, e.kind,
           p.arxiv_id, p.authors
    from paper_marks m
    join entities e on e.entity_id = m.entity_id
    left join papers p on p.entity_id = m.entity_id
    where m.mark = any(${marks})
    order by m.marked_at desc
    limit 2000`;
  return c.json({
    mark,
    items: rows.map((r) => ({
      entityId: r["entity_id"],
      title: r["display_name"],
      kind: r["kind"],
      mark: r["mark"],
      markedAt: r["marked_at"],
      arxivId: r["arxiv_id"],
      authors: r["authors"] ?? [],
    })),
  });
});

// ---- dev agents ----

app.get("/api/dev/tasks", async (c) => {
  const tasks = await sql`
    select t.task_uid, t.title, t.status, t.preview_url, t.created_at,
           r.run_uid, r.kind, r.status as run_status, r.pr_number, r.pr_url,
           r.summary, r.error, r.started_at, r.finished_at
    from dev_tasks t
    left join lateral (
      select * from dev_runs where task_uid = t.task_uid
      order by started_at desc limit 1
    ) r on true
    order by t.created_at desc
    limit 200`;
  return c.json({
    tasks: tasks.map((t) => ({
      taskUid: t["task_uid"],
      title: t["title"],
      status: t["status"],
      previewUrl: t["preview_url"],
      createdAt: t["created_at"],
      latestRun:
        t["run_uid"] === null
          ? null
          : {
              runUid: t["run_uid"],
              kind: t["kind"],
              status: t["run_status"],
              prNumber: t["pr_number"],
              prUrl: t["pr_url"],
              summary: t["summary"],
              error: t["error"],
              startedAt: t["started_at"],
              finishedAt: t["finished_at"],
            },
    })),
  });
});

app.get("/api/dev/tasks/:uid", async (c) => {
  const uid = c.req.param("uid");
  const tasks = await sql`
    select task_uid, title, spec, status, preview_url, created_at from dev_tasks
    where task_uid = ${uid}`;
  const task = tasks[0];
  if (task === undefined) {
    return c.json({ error: "no such task" }, 404);
  }
  const runs = await sql`
    select run_uid, kind, status, sandbox, branch, pr_number, pr_url, pr_title,
           merged_sha, summary, error, started_at, finished_at
    from dev_runs where task_uid = ${uid}
    order by started_at`;
  const messages = await sql`
    select msg_uid, message, at from dev_messages
    where task_uid = ${uid} order by at`;
  return c.json({
    task: {
      taskUid: task["task_uid"],
      title: task["title"],
      spec: task["spec"],
      status: task["status"],
      previewUrl: task["preview_url"],
      createdAt: task["created_at"],
    },
    messages: messages.map((m) => ({
      msgUid: m["msg_uid"],
      message: m["message"],
      at: m["at"],
    })),
    runs: runs.map((r) => ({
      runUid: r["run_uid"],
      kind: r["kind"],
      status: r["status"],
      sandbox: r["sandbox"],
      branch: r["branch"],
      prNumber: r["pr_number"],
      prUrl: r["pr_url"],
      prTitle: r["pr_title"],
      mergedSha: r["merged_sha"],
      summary: r["summary"],
      error: r["error"],
      startedAt: r["started_at"],
      finishedAt: r["finished_at"],
    })),
  });
});

// ---- LLM taxonomy: topic groups over the saved library ----

app.get("/api/topics", async (c) => {
  const categories = await sql`
    select slug, name, description, scheme_id from taxonomy_categories order by position`;
  if (categories.length === 0) {
    return c.json({ schemeId: null, groups: [] });
  }
  const schemeId = categories[0]!["scheme_id"];
  const idToSlug = new Map(
    categories.map((cat) => [entityId("topic", `taxonomy:${cat["slug"]}`), cat["slug"]]),
  );
  const counts = await sql`
    select to_id, count(*)::int as n from links
    where link_type = 'classified_as' and evidence->>'schemeId' = ${schemeId}
      and to_id = any(${[...idToSlug.keys()]})
    group by to_id`;
  const countBySlug = new Map(counts.map((r) => [idToSlug.get(r["to_id"]), r["n"]]));
  return c.json({
    schemeId,
    groups: categories.map((cat) => ({
      slug: cat["slug"],
      name: cat["name"],
      description: cat["description"],
      items: countBySlug.get(cat["slug"]) ?? 0,
    })),
  });
});

app.get("/api/topics/:slug", async (c) => {
  const slug = c.req.param("slug");
  const category = (
    await sql`select name, description, scheme_id from taxonomy_categories where slug = ${slug}`
  )[0];
  if (category === undefined) {
    return c.json({ error: `no topic group ${slug}` }, 404);
  }
  const topicId = entityId("topic", `taxonomy:${slug}`);
  const rows = await sql`
    select l.confidence, e.entity_id, e.kind, e.display_name,
           p.arxiv_id, m.mark
    from links l
    join entities e on e.entity_id = l.from_id
    left join papers p on p.entity_id = e.entity_id
    left join paper_marks m on m.entity_id = e.entity_id
    where l.to_id = ${topicId} and l.link_type = 'classified_as'
      and l.evidence->>'schemeId' = ${category["scheme_id"]}
    order by l.confidence desc`;
  return c.json({
    slug,
    name: category["name"],
    description: category["description"],
    items: rows.map((r) => ({
      entityId: r["entity_id"],
      kind: r["kind"],
      title: r["display_name"],
      arxivId: r["arxiv_id"],
      mark: r["mark"],
      confidence: Number(r["confidence"]),
    })),
  });
});

app.get("/api/dev/runs/:uid/transcript", async (c) => {
  const uid = c.req.param("uid");
  const after = Number(c.req.query("after") ?? -1);
  const chunks = await sql`
    select chunk_seq, content, at from dev_transcript_chunks
    where run_uid = ${uid} and chunk_seq > ${Number.isFinite(after) ? after : -1}
    order by chunk_seq`;
  return c.json({
    chunks: chunks.map((r) => ({
      chunkSeq: r["chunk_seq"],
      content: r["content"],
      at: r["at"],
    })),
  });
});

const devTaskBody = z.object({
  spec: z.string().min(1),
});

app.post("/api/dev/tasks", async (c) => {
  const body = devTaskBody.parse(await c.req.json());
  await appendEvents(sql, coreRegistry, [
    {
      type: "user.devtask.created",
      schemaVersion: 1,
      source: "ui:web",
      occurredAt: new Date().toISOString(),
      payload: body,
    },
  ]);
  await catchUpFolds(sql, coreRegistry, folds);
  // The task's uid is its event's uid — return it so the UI can land the
  // user on the task page immediately.
  const created = await sql`
    select event_uid from events where type = 'user.devtask.created'
    order by seq desc limit 1`;
  return c.json({ taskUid: created[0]!["event_uid"] });
});

const devMessageBody = z.object({
  taskUid: z.uuid(),
  message: z.string().min(1),
});

// A follow-up/clarification to a task's agent: the dev-agent reactor resumes
// the task's Claude session in its kept-alive sandbox once the current turn
// is idle. No fold consumes this event, so there's nothing to catch up.
app.post("/api/dev/message", async (c) => {
  const body = devMessageBody.parse(await c.req.json());
  await appendEvents(sql, coreRegistry, [
    {
      type: "user.devmessage.sent",
      schemaVersion: 1,
      source: "ui:web",
      occurredAt: new Date().toISOString(),
      payload: body,
    },
  ]);
  return c.json({ ok: true });
});

const devMergeBody = z.object({
  taskUid: z.uuid(),
  prNumber: z.number().int().positive(),
});

app.post("/api/dev/merge", async (c) => {
  const body = devMergeBody.parse(await c.req.json());
  await appendEvents(sql, coreRegistry, [
    {
      type: "user.devmerge.requested",
      schemaVersion: 1,
      source: "ui:web",
      occurredAt: new Date().toISOString(),
      payload: body,
    },
  ]);
  await catchUpFolds(sql, coreRegistry, folds);
  return c.json({ ok: true });
});

const classifyBody = z.object({ regenerate: z.boolean().optional() });

app.post("/api/jobs/classify", async (c) => {
  const body = classifyBody.parse(await c.req.json());
  const jobId = await enqueueJob(
    sql,
    "reactor:taxonomy",
    body.regenerate === true ? { regenerate: true } : {},
  );
  return c.json({ jobId });
});

const labsBody = z.object({ lab: z.string().optional() });

app.post("/api/jobs/labs", async (c) => {
  const body = labsBody.parse(await c.req.json());
  const jobId = await enqueueJob(
    sql,
    "reactor:lab-publications",
    body.lab === undefined ? {} : { lab: body.lab },
  );
  return c.json({ jobId });
});

// The operator chat: Opus with read-only SQL plus event/job agency.
// Conversations are events (user.chat.message_sent / agent.chat.replied)
// folded into chats/chat_turns; each turn streams over SSE.
const chatStreamBody = z.object({
  chatUid: z.string().uuid(),
  message: z.string().min(1),
});

app.post("/api/chat/stream", async (c) => {
  const body = chatStreamBody.parse(await c.req.json());
  return streamSSE(c, async (stream) => {
    try {
      await streamChat(sql, body.chatUid, body.message, async (event) => {
        await stream.writeSSE({ data: JSON.stringify(event) });
      });
    } catch (error) {
      console.error(error);
      await stream.writeSSE({
        data: JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  });
});

app.get("/api/chats", async (c) => {
  const chats = await sql`
    select chat_uid, title, last_at from chats order by last_at desc limit 30`;
  return c.json({
    chats: chats.map((ch) => ({
      chatUid: ch["chat_uid"],
      title: ch["title"],
      lastAt: ch["last_at"],
    })),
  });
});

app.get("/api/chats/:uid", async (c) => {
  const uid = c.req.param("uid");
  const turns = await sql`
    select role, text, trace from chat_turns
    where chat_uid = ${uid} order by event_seq`;
  return c.json({
    turns: turns.map((t) => ({
      role: t["role"],
      text: t["text"],
      trace: t["trace"] ?? [],
    })),
  });
});

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
});

// Static frontend (built by `vite build`); paths are cwd-relative, so run
// from the repo root (`pnpm ui`).
// Cache policy: the HTML shell must always revalidate (otherwise browsers
// heuristically cache it and keep loading old hashed bundles after deploys);
// the hashed assets themselves are immutable.
app.use("*", async (c, next) => {
  await next();
  if (c.req.path.startsWith("/assets/")) {
    c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
  } else if (c.res.headers.get("content-type")?.includes("text/html") === true) {
    c.res.headers.set("cache-control", "no-cache");
  }
});
app.use("*", serveStatic({ root: "./apps/ui/dist" }));
app.get("*", serveStatic({ path: "./apps/ui/dist/index.html" }));

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`ui at http://${host}:${info.port}`);
});
