import { paperpileItemImportedV1, userPaperMarkedV1 } from "@nc/schema";
import type { Fold } from "@nc/process";
import { entityId } from "./ids.js";
import { libraryItemEntity, paperRef } from "./graph.js";

// Paper marks: none < saved < want_to_read. Explicit user marks always win
// (latest event per paper); library imports auto-save an item only when the
// user hasn't marked it, so an import can never downgrade a want_to_read.

export const marksFold: Fold = {
  kind: "fold",
  name: "marks",
  version: 1,
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
  async apply(tx, event) {
    if (event.type === "user.paper.marked") {
      const m = userPaperMarkedV1.parse(event.payload);
      const id = entityId("paper", paperRef(m.arxivId));
      if (m.mark === "none") {
        await tx`delete from paper_marks where entity_id = ${id}`;
        return;
      }
      await tx`
        insert into paper_marks (entity_id, mark, source, marked_at, marked_seq)
        values (${id}, ${m.mark}, ${event.source}, ${event.occurredAt.toISOString()},
                ${event.seq.toString()})
        on conflict (entity_id) do update set
          mark = excluded.mark,
          source = excluded.source,
          marked_at = excluded.marked_at,
          marked_seq = excluded.marked_seq`;
      return;
    }
    if (event.type === "paperpile.item.imported") {
      const item = paperpileItemImportedV1.parse(event.payload);
      const target = libraryItemEntity(item);
      await tx`
        insert into paper_marks (entity_id, mark, source, marked_at, marked_seq)
        values (${entityId(target.kind, target.ref)}, 'saved', ${event.source},
                ${item.addedAt}, ${event.seq.toString()})
        on conflict (entity_id) do nothing`;
      return;
    }
    throw new Error(`marks fold received unexpected event type ${event.type}`);
  },
};
