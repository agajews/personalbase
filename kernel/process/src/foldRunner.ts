import { readEvents, type Sql } from "@nc/log";
import type { SchemaRegistry } from "@nc/schema";
import type { Fold } from "./types.js";

const batchSize = 500;

function checkpointKey(fold: Fold): string {
  return `fold:${fold.name}`;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`invalid table name: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Returns the fold's cursor, rebuilding first if the code version differs
 * from the checkpoint. Rebuild = drop owned tables, init(), cursor to 0 —
 * the normal startup path, not a special script.
 */
async function ensureCheckpoint(sql: Sql, fold: Fold): Promise<bigint> {
  const key = checkpointKey(fold);
  const rows = await sql`select version, last_seq from checkpoints where process = ${key}`;
  const existing = rows[0];
  if (existing !== undefined && existing["version"] === fold.version) {
    return BigInt(existing["last_seq"]);
  }
  await sql.begin(async (tx) => {
    for (const table of fold.tables) {
      await tx.unsafe(`drop table if exists ${quoteIdent(table)} cascade`);
    }
    await fold.init(tx);
    await tx`
      insert into checkpoints (process, version, last_seq)
      values (${key}, ${fold.version}, 0)
      on conflict (process) do update
        set version = ${fold.version}, last_seq = 0, updated_at = now()`;
  });
  return 0n;
}

/** Applies all pending events to one fold. Returns the number applied. */
export async function catchUpFold(
  sql: Sql,
  registry: SchemaRegistry,
  fold: Fold,
): Promise<number> {
  let cursor = await ensureCheckpoint(sql, fold);
  let applied = 0;
  while (true) {
    const events = await readEvents(sql, registry, {
      afterSeq: cursor,
      patterns: fold.consumes,
      limit: batchSize,
    });
    if (events.length === 0) {
      return applied;
    }
    const last = events[events.length - 1]!.seq;
    // Apply + checkpoint advance in one transaction: exactly-once on tables.
    await sql.begin(async (tx) => {
      for (const event of events) {
        await fold.apply(tx, event);
      }
      await tx`
        update checkpoints set last_seq = ${last.toString()}, updated_at = now()
        where process = ${checkpointKey(fold)}`;
    });
    cursor = last;
    applied += events.length;
  }
}

export async function catchUpFolds(
  sql: Sql,
  registry: SchemaRegistry,
  folds: readonly Fold[],
): Promise<void> {
  for (const fold of folds) {
    await catchUpFold(sql, registry, fold);
  }
}
