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
 * Applies one batch of pending events to the fold in a single transaction.
 * A per-fold advisory xact lock makes concurrent runners safe: whoever holds
 * the lock is the single writer for that batch; everyone else backs off.
 * Rebuild (on version mismatch or missing checkpoint) happens under the same
 * lock — drop owned tables, init(), cursor to 0 — the normal startup path.
 *
 * Returns the number of events applied, or null if another runner holds the
 * fold's lock.
 */
async function stepFold(
  sql: Sql,
  registry: SchemaRegistry,
  fold: Fold,
): Promise<number | null> {
  const key = checkpointKey(fold);
  return sql.begin(async (tx) => {
    const lock = await tx`select pg_try_advisory_xact_lock(hashtext(${key}), 1) as ok`;
    if (lock[0]!["ok"] !== true) {
      return null;
    }
    const rows = await tx`select version, last_seq from checkpoints where process = ${key}`;
    let cursor: bigint;
    if (rows[0] !== undefined && rows[0]["version"] > fold.version) {
      // A newer code version owns this fold (e.g. deployed worker vs local
      // CLI mid-upgrade). Back off instead of rebuilding backwards.
      return null;
    }
    if (rows[0] !== undefined && rows[0]["version"] === fold.version) {
      cursor = BigInt(rows[0]["last_seq"]);
    } else {
      for (const table of fold.tables) {
        await tx.unsafe(`drop table if exists ${quoteIdent(table)} cascade`);
      }
      await fold.init(tx);
      await tx`
        insert into checkpoints (process, version, last_seq)
        values (${key}, ${fold.version}, 0)
        on conflict (process) do update
          set version = ${fold.version}, last_seq = 0, updated_at = now()`;
      cursor = 0n;
    }
    const events = await readEvents(tx, registry, {
      afterSeq: cursor,
      patterns: fold.consumes,
      limit: batchSize,
    });
    if (events.length === 0) {
      return 0;
    }
    await fold.apply(tx, events);
    const last = events[events.length - 1]!.seq;
    await tx`
      update checkpoints set last_seq = ${last.toString()}, updated_at = now()
      where process = ${key}`;
    return events.length;
  });
}

/** Applies all pending events to one fold. Returns the number applied. */
export async function catchUpFold(
  sql: Sql,
  registry: SchemaRegistry,
  fold: Fold,
): Promise<number> {
  let applied = 0;
  while (true) {
    const step = await stepFold(sql, registry, fold);
    if (step === null || step === 0) {
      return applied;
    }
    applied += step;
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
