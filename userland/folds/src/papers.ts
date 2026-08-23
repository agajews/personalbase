import { arxivPaperIngestedV1, type ArxivPaperIngested } from "@nc/schema";
import type { Fold } from "@nc/process";
import { entityId } from "./ids.js";
import { paperRef } from "./graph.js";

interface PaperRow {
  p: ArxivPaperIngested;
  seq: bigint;
  ingestedAt: Date;
}

export const papersFold: Fold = {
  kind: "fold",
  name: "papers",
  version: 3, // batched apply
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
        ingested_at   timestamptz not null,  -- when WE first saw it (feed recency)
        ingested_seq  bigint not null
      )`;
    await tx`create index papers_published on papers (published_at)`;
    await tx`create index papers_ingested on papers (ingested_at)`;
  },
  async apply(tx, events) {
    // Dedupe within the batch: highest arXiv version wins (ties: later event),
    // first-seen time is the minimum. The upsert applies the same rules
    // against existing rows.
    const byArxivId = new Map<string, PaperRow>();
    for (const event of events) {
      const p = arxivPaperIngestedV1.parse(event.payload);
      const prev = byArxivId.get(p.arxivId);
      const ingestedAt =
        prev !== undefined && prev.ingestedAt < event.recordedAt
          ? prev.ingestedAt
          : event.recordedAt;
      if (prev === undefined || p.arxivVersion >= prev.p.arxivVersion) {
        byArxivId.set(p.arxivId, { p, seq: event.seq, ingestedAt });
      } else {
        prev.ingestedAt = ingestedAt;
      }
    }
    const rows = [...byArxivId.values()];
    await tx`
      insert into papers (entity_id, arxiv_id, arxiv_version, title, abstract,
                          authors, categories, published_at, updated_at,
                          ingested_at, ingested_seq)
      select id, arxiv_id, arxiv_version, title, abstract,
             authors::jsonb, categories::jsonb, published_at, updated_at,
             ingested_at, seq
      from unnest(
        ${rows.map((r) => entityId("paper", paperRef(r.p.arxivId)))}::uuid[],
        ${rows.map((r) => r.p.arxivId)}::text[],
        ${rows.map((r) => r.p.arxivVersion)}::int[],
        ${rows.map((r) => r.p.title)}::text[],
        ${rows.map((r) => r.p.abstract)}::text[],
        ${rows.map((r) => JSON.stringify(r.p.authors))}::text[],
        ${rows.map((r) => JSON.stringify(r.p.categories))}::text[],
        ${rows.map((r) => r.p.publishedAt)}::timestamptz[],
        ${rows.map((r) => r.p.updatedAt)}::timestamptz[],
        ${rows.map((r) => r.ingestedAt.toISOString())}::timestamptz[],
        ${rows.map((r) => r.seq.toString())}::bigint[]
      ) as t(id, arxiv_id, arxiv_version, title, abstract, authors, categories,
             published_at, updated_at, ingested_at, seq)
      on conflict (arxiv_id) do update set
        arxiv_version = excluded.arxiv_version,
        title = excluded.title,
        abstract = excluded.abstract,
        authors = excluded.authors,
        categories = excluded.categories,
        published_at = excluded.published_at,
        updated_at = excluded.updated_at,
        ingested_at = least(papers.ingested_at, excluded.ingested_at),
        ingested_seq = excluded.ingested_seq
      where excluded.arxiv_version >= papers.arxiv_version`;
  },
};
