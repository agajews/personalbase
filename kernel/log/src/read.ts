import { upcastToLatest, type SchemaRegistry } from "@nc/schema";
import type { Sql, TransactionSql } from "./db.js";

/** An exact event type, or a prefix pattern ending in ".*" (e.g. "arxiv.paper.*"). */
export type EventTypePattern = string;

export interface StoredEvent {
  readonly seq: bigint;
  readonly eventUid: string;
  readonly type: string;
  /** Always the latest version: payloads are upcast on read. */
  readonly schemaVersion: number;
  readonly source: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly payload: unknown;
  readonly causedByUid: string | null;
  readonly correctsUid: string | null;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

export function patternToLike(pattern: EventTypePattern): string {
  return pattern.endsWith(".*")
    ? likeEscape(pattern.slice(0, -1)) + "%"
    : likeEscape(pattern);
}

/**
 * Reads events strictly after `afterSeq` in seq order, upcast to their latest
 * schema version. This is the one consumption path for folds and reactors.
 */
export async function readEvents(
  sql: Sql | TransactionSql,
  registry: SchemaRegistry,
  opts: {
    readonly afterSeq: bigint;
    readonly patterns?: readonly EventTypePattern[];
    readonly limit: number;
  },
): Promise<StoredEvent[]> {
  const likes = opts.patterns?.map(patternToLike);
  const afterSeq = opts.afterSeq.toString();
  const rows = await (likes === undefined
    ? sql`
        select seq, event_uid, type, schema_version, source, occurred_at,
               recorded_at, payload, caused_by_uid, corrects_uid
        from events where seq > ${afterSeq}
        order by seq limit ${opts.limit}`
    : sql`
        select seq, event_uid, type, schema_version, source, occurred_at,
               recorded_at, payload, caused_by_uid, corrects_uid
        from events where seq > ${afterSeq} and type like any(${likes})
        order by seq limit ${opts.limit}`);
  return rows.map((row) => {
    const upcast = upcastToLatest(
      registry,
      row["type"],
      row["schema_version"],
      row["payload"],
    );
    return {
      seq: BigInt(row["seq"]),
      eventUid: row["event_uid"],
      type: row["type"],
      schemaVersion: upcast.schemaVersion,
      source: row["source"],
      occurredAt: row["occurred_at"],
      recordedAt: row["recorded_at"],
      payload: upcast.payload,
      causedByUid: row["caused_by_uid"],
      correctsUid: row["corrects_uid"],
    };
  });
}
