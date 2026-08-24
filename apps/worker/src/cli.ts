import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import {
  appendEvents,
  connect,
  kernelMigrationsDir,
  migrate,
  readEvents,
  type Sql,
} from "@nc/log";
import { coreRegistry } from "@nc/schema";
import {
  catchUpEventReactors,
  catchUpFolds,
  enqueueDueCronJobs,
  enqueueJob,
  processPendingJobs,
  runReactor,
} from "@nc/process";
import { folds, reactors } from "./registry.js";

const usage = `usage: pnpm nc <command>

  migrate                                     apply kernel migrations
  set-filter <name> --prompt <text> [--model <id>]
                                              define or edit a filter (an event)
  filters                                     list defined filters
  ingest-arxiv [--days N | --from <iso> --to <iso>] [--category <cat>]...
                                              ingest papers submitted in a range
  ingest-labs [--lab openai|deepmind|anthropic|meta]
                                              ingest lab publication pages
  import-paperpile <path>                     import a Paperpile library JSON export
  backfill-library                            fetch arXiv metadata for library papers
  classify [--regenerate]                     LLM-classify saved items into topic groups
  redrive <reactor> <seq>                     re-run an event reactor on one event
                                              (e.g. a skipped poison event, after a fix)
  run-filter [name] [--days N | --from <iso> --to <iso>]
                                              judge ingested papers against filters
  results <name> [--rejects]                  show verdicts for the current prompt
  enqueue <process> [<payload-json>]          enqueue a job for any reactor
                                              (e.g. enqueue reactor:main-ui)
  tail [--limit N]                            inspect the tail of the event log
  daemon                                      run folds + reactors continuously
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadEnv(): void {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    fail(`${name} is not set (put it in .env or the environment)`);
  }
  return value;
}

function dateRange(values: {
  days?: string;
  from?: string;
  to?: string;
}): { from: string; to: string } {
  if (values.from !== undefined || values.to !== undefined) {
    if (values.from === undefined || values.to === undefined) {
      fail("--from and --to must be given together");
    }
    return { from: new Date(values.from).toISOString(), to: new Date(values.to).toISOString() };
  }
  const days = values.days === undefined ? 1 : Number(values.days);
  if (!Number.isFinite(days) || days <= 0) {
    fail(`invalid --days: ${values.days}`);
  }
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function withDb(f: (sql: Sql) => Promise<void>): Promise<void> {
  const sql = connect(requireEnv("DATABASE_URL"));
  try {
    await migrate(sql, kernelMigrationsDir);
    await f(sql);
  } finally {
    await sql.end();
  }
}

async function cmdSetFilter(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { prompt: { type: "string" }, model: { type: "string" } },
  });
  const name = positionals[0];
  if (name === undefined || values.prompt === undefined) {
    fail("usage: set-filter <name> --prompt <text> [--model <id>]");
  }
  const model = values.model ?? "claude-opus-5";
  await withDb(async (sql) => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.filter.defined",
        schemaVersion: 1,
        source: "ui:cli",
        occurredAt: new Date().toISOString(),
        payload: { name, prompt: values.prompt, model },
      },
    ]);
    await catchUpFolds(sql, coreRegistry, folds);
    const rows = await sql`select prompt_hash from filters where name = ${name}`;
    console.log(`filter ${name} defined (model ${model}, prompt hash ${rows[0]!["prompt_hash"]})`);
  });
}

async function cmdFilters(): Promise<void> {
  await withDb(async (sql) => {
    await catchUpFolds(sql, coreRegistry, folds);
    const rows = await sql`select name, model, prompt_hash, prompt from filters order by name`;
    if (rows.length === 0) {
      console.log("no filters defined");
      return;
    }
    for (const row of rows) {
      console.log(`${row["name"]}  [${row["model"]}, ${row["prompt_hash"]}]\n  ${row["prompt"]}`);
    }
  });
}

async function cmdIngestArxiv(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      days: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      category: { type: "string", multiple: true },
    },
  });
  const range = dateRange(values);
  await withDb(async (sql) => {
    const payload = {
      ...range,
      ...(values.category === undefined ? {} : { categories: values.category }),
    };
    console.log(`ingesting arxiv ${range.from} .. ${range.to}` +
      (values.category === undefined ? " (all categories)" : ` [${values.category.join(", ")}]`));
    const result = await runReactor(sql, coreRegistry, reactors.find((r) => r.name === "arxiv")!, {
      kind: "job",
      payload,
    });
    await catchUpFolds(sql, coreRegistry, folds);
    console.log(
      `ingested ${result.emitted} papers, ${result.appended} new (run ${result.runId})`,
    );
  });
}

async function cmdIngestLabs(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { lab: { type: "string" } } });
  await withDb(async (sql) => {
    const result = await runReactor(
      sql,
      coreRegistry,
      reactors.find((r) => r.name === "lab-publications")!,
      { kind: "job", payload: values.lab === undefined ? {} : { lab: values.lab } },
    );
    await catchUpFolds(sql, coreRegistry, folds);
    console.log(`lab ingest: ${result.emitted} events emitted, ${result.appended} new`);
  });
}

async function cmdImportPaperpile(args: string[]): Promise<void> {
  const path = args[0];
  if (path === undefined) {
    fail("usage: import-paperpile <path>");
  }
  await withDb(async (sql) => {
    const result = await runReactor(
      sql,
      coreRegistry,
      reactors.find((r) => r.name === "paperpile-import")!,
      { kind: "job", payload: { path } },
    );
    await catchUpFolds(sql, coreRegistry, folds);
    const rows = await sql`
      select count(*)::int as items, count(distinct entity_id)::int as entities
      from library_items`;
    console.log(
      `imported ${result.emitted} items (${result.appended} new events); ` +
        `library now has ${rows[0]!["items"]} items across ${rows[0]!["entities"]} entities`,
    );
  });
}

async function cmdBackfillLibrary(): Promise<void> {
  await withDb(async (sql) => {
    const result = await runReactor(
      sql,
      coreRegistry,
      reactors.find((r) => r.name === "library-arxiv-backfill")!,
      { kind: "job", payload: {} },
    );
    await catchUpFolds(sql, coreRegistry, folds);
    const rows = await sql`select count(*)::int as n from papers`;
    console.log(
      `backfill: ${result.emitted} papers fetched, ${result.appended} new events; ` +
        `papers table now has ${rows[0]!["n"]} rows`,
    );
  });
}

async function cmdClassify(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { regenerate: { type: "boolean" } } });
  await withDb(async (sql) => {
    await catchUpFolds(sql, coreRegistry, folds);
    const result = await runReactor(
      sql,
      coreRegistry,
      reactors.find((r) => r.name === "taxonomy")!,
      { kind: "job", payload: values.regenerate === true ? { regenerate: true } : {} },
    );
    await catchUpFolds(sql, coreRegistry, folds);
    const groups = await sql`
      select tc.name, count(l.from_id)::int as n
      from taxonomy_categories tc
      left join links l on l.link_type = 'classified_as'
        and l.evidence->>'schemeId' = tc.scheme_id
        and l.to_id in (select entity_id from entities where kind = 'topic' and ref = 'taxonomy:' || tc.slug)
      group by tc.name, tc.position order by tc.position`;
    console.log(`classified: ${result.emitted} events, ${result.appended} new`);
    for (const g of groups) {
      console.log(`  ${g["n"]}\t${g["name"]}`);
    }
  });
}

async function cmdRedrive(args: string[]): Promise<void> {
  const [name, seqArg] = args;
  if (name === undefined || seqArg === undefined || !/^\d+$/.test(seqArg)) {
    fail("usage: redrive <reactor> <seq>");
  }
  const reactor = reactors.find((r) => r.name === name);
  if (reactor === undefined) {
    fail(`no reactor named ${name}`);
  }
  await withDb(async (sql) => {
    const events = await readEvents(sql, coreRegistry, {
      afterSeq: BigInt(seqArg) - 1n,
      limit: 1,
    });
    const event = events[0];
    if (event === undefined || event.seq !== BigInt(seqArg)) {
      fail(`no event at seq ${seqArg}`);
    }
    const result = await runReactor(sql, coreRegistry, reactor, { kind: "event", event });
    await catchUpFolds(sql, coreRegistry, folds);
    console.log(
      `redrive ${name} on seq ${seqArg} (${event.type}): ` +
        `${result.emitted} emitted, ${result.appended} new (run ${result.runId})`,
    );
  });
}

async function cmdRunFilter(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      days: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
    },
  });
  const range = dateRange(values);
  await withDb(async (sql) => {
    await catchUpFolds(sql, coreRegistry, folds);
    const payload = {
      ...range,
      ...(positionals[0] === undefined ? {} : { filter: positionals[0] }),
    };
    const result = await runReactor(
      sql,
      coreRegistry,
      reactors.find((r) => r.name === "paper-filter")!,
      { kind: "job", payload },
    );
    await catchUpFolds(sql, coreRegistry, folds);
    const runRows = await sql`
      select tokens_in, tokens_out from runs where run_id = ${result.runId}`;
    const run = runRows[0]!;
    console.log(
      `judged: ${result.emitted} verdicts, ${result.appended} new ` +
        `(${run["tokens_in"]} tokens in, ${run["tokens_out"]} out, run ${result.runId})`,
    );
  });
}

async function cmdResults(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { rejects: { type: "boolean" } },
  });
  const name = positionals[0];
  if (name === undefined) {
    fail("usage: results <name> [--rejects]");
  }
  await withDb(async (sql) => {
    await catchUpFolds(sql, coreRegistry, folds);
    const filterRows = await sql`select prompt_hash from filters where name = ${name}`;
    if (filterRows.length === 0) {
      fail(`no filter named ${name}`);
    }
    const hash = filterRows[0]!["prompt_hash"];
    const verdict = values.rejects === true ? "reject" : "match";
    const rows = await sql`
      select r.arxiv_id, r.confidence, r.reason, p.title
      from filter_results r
      join papers p on p.arxiv_id = r.arxiv_id
      where r.filter_name = ${name} and r.prompt_hash = ${hash} and r.verdict = ${verdict}
      order by r.confidence desc`;
    const totals = await sql`
      select verdict, count(*)::int as n from filter_results
      where filter_name = ${name} and prompt_hash = ${hash}
      group by verdict`;
    const counts = Object.fromEntries(totals.map((t) => [t["verdict"], t["n"]]));
    console.log(
      `${name} [${hash}]: ${counts["match"] ?? 0} match, ${counts["reject"] ?? 0} reject\n`,
    );
    for (const row of rows) {
      console.log(`  ${row["arxiv_id"]}  (${Number(row["confidence"]).toFixed(2)})  ${row["title"]}`);
      console.log(`      ${row["reason"]}`);
    }
  });
}

async function cmdTail(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { limit: { type: "string" } } });
  const limit = values.limit === undefined ? 20 : Number(values.limit);
  await withDb(async (sql) => {
    const rows = await sql`
      select seq, type, source, occurred_at, idempotency_key
      from events order by seq desc limit ${limit}`;
    for (const row of rows.reverse()) {
      console.log(
        `${row["seq"]}  ${new Date(row["occurred_at"]).toISOString()}  ${row["type"]}  ` +
          `[${row["source"]}]  ${row["idempotency_key"] ?? ""}`,
      );
    }
  });
}

async function cmdDaemon(): Promise<void> {
  await withDb(async (sql) => {
    // A previous daemon killed mid-job (e.g. a deploy) leaves jobs 'running'
    // forever. Requeue them: reactor emission is idempotent, so a partial
    // earlier run cannot double-post.
    const requeued = await sql`
      update jobs set status = 'pending' where status = 'running' returning job_id`;
    if (requeued.length > 0) {
      console.log(`requeued ${requeued.length} stale running job(s)`);
    }
    console.log("worker daemon running (folds, event reactors, cron, jobs); ctrl-c to stop");
    while (true) {
      // Backstop: one bad pass (a transient DB error, an unexpected throw)
      // logs and waits rather than killing the daemon into a restart loop.
      try {
        await catchUpFolds(sql, coreRegistry, folds);
        await catchUpEventReactors(sql, coreRegistry, reactors);
        await enqueueDueCronJobs(sql, reactors);
        // One job per pass, so folds catch up between jobs (a judging job
        // enqueued after an ingest job then sees the ingested papers).
        await processPendingJobs(sql, coreRegistry, reactors, 1);
      } catch (error) {
        console.error(
          `daemon pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await sleep(10_000);
      }
      await sleep(2000);
    }
  });
}

loadEnv();
const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "migrate":
    await withDb(async () => console.log("migrations applied"));
    break;
  case "set-filter":
    await cmdSetFilter(rest);
    break;
  case "filters":
    await cmdFilters();
    break;
  case "ingest-arxiv":
    await cmdIngestArxiv(rest);
    break;
  case "ingest-labs":
    await cmdIngestLabs(rest);
    break;
  case "import-paperpile":
    await cmdImportPaperpile(rest);
    break;
  case "backfill-library":
    await cmdBackfillLibrary();
    break;
  case "classify":
    await cmdClassify(rest);
    break;
  case "redrive":
    await cmdRedrive(rest);
    break;
  case "run-filter":
    await cmdRunFilter(rest);
    break;
  case "results":
    await cmdResults(rest);
    break;
  case "enqueue": {
    const [proc, payloadJson] = rest;
    if (proc === undefined || !reactors.some((r) => `reactor:${r.name}` === proc)) {
      fail(`enqueue: unknown process ${proc ?? "(none)"}; known: ${reactors.map((r) => `reactor:${r.name}`).join(", ")}`);
    }
    await withDb(async (sql) => {
      const jobId = await enqueueJob(sql, proc, JSON.parse(payloadJson ?? "{}"));
      console.log(`enqueued ${jobId} (${proc}) — the daemon picks it up within seconds`);
    });
    break;
  }
  case "tail":
    await cmdTail(rest);
    break;
  case "daemon":
    await cmdDaemon();
    break;
  default:
    fail(usage);
}
