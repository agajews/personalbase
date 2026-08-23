import { paperpileItemImportedV1, userPaperMarkedV2 } from "@nc/schema";
import type { Fold } from "@nc/process";
import type { TransactionSql } from "@nc/log";
import { entityId } from "./ids.js";
import { libraryItemEntity } from "./graph.js";

// Marks: none < saved < want_to_read, on any paper or resource entity.
// Explicit user marks always win (latest event per entity); library imports
// auto-save an item only when no mark exists, so an import can never
// downgrade a want_to_read. Import runs are bulk-inserted; the rare user
// marks are applied individually, with buffer flushes preserving seq order.

interface ImportRow {
  entityId: string;
  source: string;
  markedAt: string;
  seq: bigint;
}

async function flushImports(tx: TransactionSql, buffer: ImportRow[]): Promise<void> {
  if (buffer.length === 0) {
    return;
  }
  // Dedupe within the buffer (duplicate library items converge on one
  // entity); first wins, matching on conflict do nothing.
  const byEntity = new Map<string, ImportRow>();
  for (const row of buffer) {
    if (!byEntity.has(row.entityId)) {
      byEntity.set(row.entityId, row);
    }
  }
  const rows = [...byEntity.values()];
  await tx`
    insert into paper_marks (entity_id, mark, source, marked_at, marked_seq)
    select id, 'saved', source, marked_at, seq from unnest(
      ${rows.map((r) => r.entityId)}::uuid[],
      ${rows.map((r) => r.source)}::text[],
      ${rows.map((r) => r.markedAt)}::timestamptz[],
      ${rows.map((r) => r.seq.toString())}::bigint[]
    ) as t(id, source, marked_at, seq)
    on conflict (entity_id) do nothing`;
  buffer.length = 0;
}

export const marksFold: Fold = {
  kind: "fold",
  name: "marks",
  version: 2, // entity-target marks (any paper or resource), batched apply
  consumes: ["user.paper.marked", "paperpile.item.imported"],
  tables: ["paper_marks"],
  async init(tx) {
    await tx`
      create table paper_marks (
        entity_id  uuid primary key,
        mark       text not null,        -- 'saved' | 'want_to_read'
        source     text not null,
        marked_at  timestamptz not null,
        marked_seq bigint not null
      )`;
    await tx`create index paper_marks_mark on paper_marks (mark, marked_at)`;
  },
  async apply(tx, events) {
    const importBuffer: ImportRow[] = [];
    for (const event of events) {
      if (event.type === "paperpile.item.imported") {
        const item = paperpileItemImportedV1.parse(event.payload);
        const target = libraryItemEntity(item);
        importBuffer.push({
          entityId: entityId(target.kind, target.ref),
          source: event.source,
          markedAt: item.addedAt,
          seq: event.seq,
        });
        continue;
      }
      if (event.type === "user.paper.marked") {
        // Payloads arrive upcast to v2 (v1 carried a bare arXiv id).
        const m = userPaperMarkedV2.parse(event.payload);
        const id = entityId(m.target.kind, m.target.ref);
        await flushImports(tx, importBuffer); // preserve seq order vs imports
        if (m.mark === "none") {
          await tx`delete from paper_marks where entity_id = ${id}`;
        } else {
          await tx`
            insert into paper_marks (entity_id, mark, source, marked_at, marked_seq)
            values (${id}, ${m.mark}, ${event.source}, ${event.occurredAt.toISOString()},
                    ${event.seq.toString()})
            on conflict (entity_id) do update set
              mark = excluded.mark,
              source = excluded.source,
              marked_at = excluded.marked_at,
              marked_seq = excluded.marked_seq`;
        }
        continue;
      }
      throw new Error(`marks fold received unexpected event type ${event.type}`);
    }
    await flushImports(tx, importBuffer);
  },
};
