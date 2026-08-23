import { paperpileItemImportedV1, type PaperpileItemImported } from "@nc/schema";
import type { Fold } from "@nc/process";
import { entityId } from "./ids.js";
import { libraryItemEntity, normalizeArxivId } from "./graph.js";

export const libraryFold: Fold = {
  kind: "fold",
  name: "library",
  version: 4, // batched apply
  consumes: ["paperpile.item.imported"],
  tables: ["library_items"],
  async init(tx) {
    await tx`
      create table library_items (
        paperpile_id text primary key,
        entity_id    uuid not null,
        title        text not null,
        abstract     text,
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
  async apply(tx, events) {
    // Last event per paperpile id wins, matching the upsert against rows.
    const byId = new Map<string, { item: PaperpileItemImported; seq: bigint }>();
    for (const event of events) {
      const item = paperpileItemImportedV1.parse(event.payload);
      byId.set(item.paperpileId, { item, seq: event.seq });
    }
    const rows = [...byId.values()];
    await tx`
      insert into library_items (paperpile_id, entity_id, title, abstract, authors,
                                 pubtype, year, arxiv_id, doi, url, journal, folders,
                                 added_at, imported_seq)
      select paperpile_id, entity_id, title, abstract, authors::jsonb, pubtype,
             year, arxiv_id, doi, url, journal, folders::jsonb, added_at, seq
      from unnest(
        ${rows.map((r) => r.item.paperpileId)}::text[],
        ${rows.map((r) => {
          const target = libraryItemEntity(r.item);
          return entityId(target.kind, target.ref);
        })}::uuid[],
        ${rows.map((r) => r.item.title)}::text[],
        ${rows.map((r) => r.item.abstract ?? null)}::text[],
        ${rows.map((r) => JSON.stringify(r.item.authors))}::text[],
        ${rows.map((r) => r.item.pubtype)}::text[],
        ${rows.map((r) => r.item.year ?? null)}::int[],
        ${rows.map((r) => (r.item.arxivId === undefined ? null : normalizeArxivId(r.item.arxivId)))}::text[],
        ${rows.map((r) => r.item.doi?.toLowerCase() ?? null)}::text[],
        ${rows.map((r) => r.item.url ?? null)}::text[],
        ${rows.map((r) => r.item.journal ?? null)}::text[],
        ${rows.map((r) => (r.item.folders === undefined ? null : JSON.stringify(r.item.folders)))}::text[],
        ${rows.map((r) => r.item.addedAt)}::timestamptz[],
        ${rows.map((r) => r.seq.toString())}::bigint[]
      ) as t(paperpile_id, entity_id, title, abstract, authors, pubtype, year,
             arxiv_id, doi, url, journal, folders, added_at, seq)
      on conflict (paperpile_id) do update set
        entity_id = excluded.entity_id,
        title = excluded.title,
        abstract = excluded.abstract,
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
