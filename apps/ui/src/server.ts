import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
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
import {
  entityId,
  filterResultsFold,
  filtersFold,
  graphFold,
  libraryFold,
  papersFold,
  paperRef,
  personRef,
} from "@nc/folds";

// The UI reads folds and appends events / enqueues jobs. It never runs
// reactors — the worker daemon (local or Fly) picks jobs up through the
// database. Fold catch-up here is safe alongside the daemon because the fold
// runner takes a per-fold advisory lock.
const folds = [papersFold, filtersFold, filterResultsFold, graphFold, libraryFold];

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql: Sql = connect(databaseUrl);
await migrate(sql, kernelMigrationsDir);

const app = new Hono();

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
  return c.json({
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
  const shape = (r: (typeof rows)[number]) => ({
    arxivId: r["arxiv_id"],
    entityId: entityId("paper", paperRef(r["arxiv_id"])),
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
  const items = papers
    .map((p) => {
      const why = surfaced.get(p["arxiv_id"])!;
      return {
        arxivId: p["arxiv_id"],
        entityId: entityId("paper", paperRef(p["arxiv_id"])),
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
  return c.json({
    entity: {
      entityId: entity["entity_id"],
      kind: entity["kind"],
      displayName: entity["display_name"],
    },
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

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
});

// Static frontend (built by `vite build`); paths are cwd-relative, so run
// from the repo root (`pnpm ui`).
app.use("*", serveStatic({ root: "./apps/ui/dist" }));
app.get("*", serveStatic({ path: "./apps/ui/dist/index.html" }));

serve({ fetch: app.fetch, port: 4680, hostname: "127.0.0.1" }, (info) => {
  console.log(`ui at http://127.0.0.1:${info.port}`);
});
