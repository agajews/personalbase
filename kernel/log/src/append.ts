import { validatePayload, type SchemaRegistry } from "@nc/schema";
import { jsonb, type Sql } from "./db.js";

/** An event to be appended. The only way anything writes to the fact plane. */
export interface NewEvent {
  readonly type: string;
  readonly schemaVersion: number;
  readonly source: string;
  /** ISO 8601 timestamp of when the fact happened in the world. */
  readonly occurredAt: string;
  readonly payload: unknown;
  readonly idempotencyKey?: string;
  readonly sourceRunId?: string;
  readonly causedByUid?: string;
  readonly correctsUid?: string;
}

/**
 * Validates payloads against the registry and appends through the serialized
 * append_events() SQL function. Returns the number of events actually
 * inserted — 0 when every event was an idempotent duplicate.
 */
export async function appendEvents(
  sql: Sql,
  registry: SchemaRegistry,
  events: readonly NewEvent[],
): Promise<number> {
  if (events.length === 0) {
    return 0;
  }
  for (const event of events) {
    validatePayload(registry, event.type, event.schemaVersion, event.payload);
  }
  const batch = events.map((e) => ({
    type: e.type,
    schema_version: e.schemaVersion,
    source: e.source,
    source_run_id: e.sourceRunId ?? null,
    occurred_at: e.occurredAt,
    payload: e.payload,
    idempotency_key: e.idempotencyKey ?? null,
    caused_by_uid: e.causedByUid ?? null,
    corrects_uid: e.correctsUid ?? null,
  }));
  const rows = await sql`select append_events(${jsonb(sql, batch)}) as inserted`;
  return rows[0]!["inserted"];
}
