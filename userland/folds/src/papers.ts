import { arxivPaperIngestedV1 } from "@nc/schema";
import { jsonb } from "@nc/log";
import type { Fold } from "@nc/process";
import { entityId } from "./ids.js";

export const papersFold: Fold = {
  kind: "fold",
  name: "papers",
  version: 1,
  consumes: ["arxiv.paper.ingested"],
  tables: ["papers"],
  async init(tx) {
    await tx`
      create table papers (
        entity_id     uuid primary key,
        arxiv_id      text not null unique,
        arxiv_version int not null,
        title         text not null,
        abstract      text not null,
        authors       jsonb not null,
        categories    jsonb not null,
        published_at  timestamptz not null,
        updated_at    timestamptz not null,
        ingested_seq  bigint not null
      )`;
    await tx`create index papers_published on papers (published_at)`;
  },
  async apply(tx, event) {
    const p = arxivPaperIngestedV1.parse(event.payload);
    await tx`
      insert into papers (entity_id, arxiv_id, arxiv_version, title, abstract,
                          authors, categories, published_at, updated_at, ingested_seq)
      values (${entityId("paper", `arxiv:${p.arxivId}`)}, ${p.arxivId}, ${p.arxivVersion},
              ${p.title}, ${p.abstract}, ${jsonb(tx, p.authors)}, ${jsonb(tx, p.categories)},
              ${p.publishedAt}, ${p.updatedAt}, ${event.seq.toString()})
      on conflict (arxiv_id) do update set
        arxiv_version = excluded.arxiv_version,
        title = excluded.title,
        abstract = excluded.abstract,
        authors = excluded.authors,
        categories = excluded.categories,
        published_at = excluded.published_at,
        updated_at = excluded.updated_at,
        ingested_seq = excluded.ingested_seq
      where excluded.arxiv_version >= papers.arxiv_version`;
  },
};
