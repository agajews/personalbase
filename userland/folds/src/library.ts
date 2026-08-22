import { paperpileItemImportedV1 } from "@nc/schema";
import { jsonb } from "@nc/log";
import type { Fold } from "@nc/process";
import { entityId } from "./ids.js";
import { libraryItemEntity } from "./graph.js";

export const libraryFold: Fold = {
  kind: "fold",
  name: "library",
  version: 1,
  consumes: ["paperpile.item.imported"],
  tables: ["library_items"],
  async init(tx) {
    await tx`
      create table library_items (
        paperpile_id text primary key,
        entity_id    uuid not null,
        title        text not null,
        authors      jsonb not null,
        pubtype      text not null,
        year         int,
        arxiv_id     text,
        doi          text,
        url          text,
        journal      text,
        folders      jsonb,
        added_at     timestamptz not null,
        imported_seq bigint not null
      )`;
    await tx`create index library_items_entity on library_items (entity_id)`;
    await tx`create index library_items_added on library_items (added_at)`;
  },
  async apply(tx, event) {
    const item = paperpileItemImportedV1.parse(event.payload);
    const target = libraryItemEntity(item);
    await tx`
      insert into library_items (paperpile_id, entity_id, title, authors, pubtype,
                                 year, arxiv_id, doi, url, journal, folders,
                                 added_at, imported_seq)
      values (${item.paperpileId}, ${entityId(target.kind, target.ref)}, ${item.title},
              ${jsonb(tx, item.authors)}, ${item.pubtype}, ${item.year ?? null},
              ${item.arxivId ?? null}, ${item.doi?.toLowerCase() ?? null},
              ${item.url ?? null}, ${item.journal ?? null},
              ${item.folders === undefined ? null : jsonb(tx, item.folders)},
              ${item.addedAt}, ${event.seq.toString()})
      on conflict (paperpile_id) do update set
        entity_id = excluded.entity_id,
        title = excluded.title,
        authors = excluded.authors,
        pubtype = excluded.pubtype,
        year = excluded.year,
        arxiv_id = excluded.arxiv_id,
        doi = excluded.doi,
        url = excluded.url,
        journal = excluded.journal,
        folders = excluded.folders,
        added_at = excluded.added_at,
        imported_seq = excluded.imported_seq`;
  },
};
