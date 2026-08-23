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

/**
 * Every stored event's type is validated against the registry at append time,
 * so wildcard patterns can be expanded to the exact registered types — the
 * query becomes `type = any(...)`, which always uses the (type, seq) index.
 */
export function expandPatterns(
  registry: SchemaRegistry,
  patterns: readonly EventTypePattern[],
): string[] {
  const types = [...registry.keys()];
  return types.filter((type) =>
    patterns.some((p) => (p.endsWith(".*") ? type.startsWith(p.slice(0, -1)) : type === p)),
  );
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
  const exact = opts.patterns === undefined ? undefined : expandPatterns(registry, opts.patterns);
  if (exact !== undefined && exact.length === 0) {
    return [];
  }
  const afterSeq = opts.afterSeq.toString();
  const rows = await (exact === undefined
    ? sql`
        select seq, event_uid, type, schema_version, source, occurred_at,
               recorded_at, payload, caused_by_uid, corrects_uid
        from events where seq > ${afterSeq}
        order by seq limit ${opts.limit}`
    : sql`
        select seq, event_uid, type, schema_version, source, occurred_at,
               recorded_at, payload, caused_by_uid, corrects_uid
        from events where seq > ${afterSeq} and type = any(${exact})
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
