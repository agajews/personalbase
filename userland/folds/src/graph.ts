import {
  agentLinkAssertedV1,
  agentPaperAffiliationsExtractedV1,
  arxivPaperIngestedV1,
} from "@nc/schema";
import { jsonb } from "@nc/log";
import type { TransactionSql } from "@nc/log";
import type { Fold } from "@nc/process";
import { entityId } from "./ids.js";

// The cross-domain graph: an entity registry, an identifier substrate, and
// typed links with provenance. Entity ids are minted deterministically from
// (kind, ref), so replay and independent producers converge.

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function personRef(name: string): string {
  return `arxiv_author:${normalizeName(name).toLowerCase()}`;
}

export function paperRef(arxivId: string): string {
  return `arxiv:${arxivId}`;
}

async function ensureEntity(
  tx: TransactionSql,
  kind: string,
  ref: string,
  displayName: string | null,
  seq: bigint,
): Promise<string> {
  const id = entityId(kind, ref);
  await tx`
    insert into entities (entity_id, kind, canonical_id, display_name, created_seq)
    values (${id}, ${kind}, ${id}, ${displayName}, ${seq.toString()})
    on conflict (entity_id) do update
      set display_name = coalesce(entities.display_name, excluded.display_name)`;
  return id;
}

async function ensureLink(
  tx: TransactionSql,
  args: {
    fromId: string;
    toId: string;
    linkType: string;
    assertedBy: string;
    confidence: number;
    evidence: unknown;
    seq: bigint;
  },
): Promise<void> {
  const linkId = entityId(
    "link",
    `${args.fromId}|${args.toId}|${args.linkType}|${args.assertedBy}`,
  );
  await tx`
    insert into links (link_id, from_id, to_id, link_type, asserted_by,
                       confidence, evidence, created_seq)
    values (${linkId}, ${args.fromId}, ${args.toId}, ${args.linkType},
            ${args.assertedBy}, ${args.confidence},
            ${args.evidence === undefined ? null : jsonb(tx, args.evidence)},
            ${args.seq.toString()})
    on conflict (from_id, to_id, link_type, asserted_by) do update
      set confidence = excluded.confidence, evidence = excluded.evidence`;
}

export const graphFold: Fold = {
  kind: "fold",
  name: "graph",
  version: 1,
  consumes: [
    "arxiv.paper.ingested",
    "agent.link.asserted",
    "agent.paper.affiliations_extracted",
  ],
  tables: ["entities", "identifiers", "links"],
  async init(tx) {
    await tx`
      create table entities (
        entity_id    uuid primary key,
        kind         text not null,
        canonical_id uuid not null,   -- self until merges exist
        display_name text,
        created_seq  bigint not null
      )`;
    await tx`create index entities_kind on entities (kind)`;
    await tx`
      create table identifiers (
        scheme      text not null,    -- 'email' | ...
        value       text not null,
        entity_id   uuid not null,
        asserted_by text not null,
        confidence  real not null default 1.0,
        primary key (scheme, value)
      )`;
    await tx`
      create table links (
        link_id     uuid primary key,
        from_id     uuid not null,
        to_id       uuid not null,
        link_type   text not null,    -- 'authored' | 'published_by' | 'affiliated_with' | 'affiliated_org'
        asserted_by text not null,
        confidence  real not null default 1.0,
        evidence    jsonb,
        created_seq bigint not null,
        unique (from_id, to_id, link_type, asserted_by)
      )`;
    await tx`create index links_from on links (from_id, link_type)`;
    await tx`create index links_to on links (to_id, link_type)`;
  },
  async apply(tx, event) {
    if (event.type === "arxiv.paper.ingested") {
      const p = arxivPaperIngestedV1.parse(event.payload);
      const paper = await ensureEntity(tx, "paper", paperRef(p.arxivId), p.title, event.seq);
      for (const name of p.authors) {
        const person = await ensureEntity(
          tx,
          "person",
          personRef(name),
          normalizeName(name),
          event.seq,
        );
        await ensureLink(tx, {
          fromId: person,
          toId: paper,
          linkType: "authored",
          assertedBy: event.source,
          confidence: 1,
          evidence: undefined,
          seq: event.seq,
        });
      }
      return;
    }
    if (event.type === "agent.link.asserted") {
      const l = agentLinkAssertedV1.parse(event.payload);
      const from = await ensureEntity(
        tx,
        l.from.kind,
        l.from.ref,
        l.from.displayName ?? null,
        event.seq,
      );
      const to = await ensureEntity(tx, l.to.kind, l.to.ref, l.to.displayName ?? null, event.seq);
      await ensureLink(tx, {
        fromId: from,
        toId: to,
        linkType: l.linkType,
        assertedBy: event.source,
        confidence: l.confidence,
        evidence: l.evidence,
        seq: event.seq,
      });
      return;
    }
    if (event.type === "agent.paper.affiliations_extracted") {
      const e = agentPaperAffiliationsExtractedV1.parse(event.payload);
      const paper = await ensureEntity(tx, "paper", paperRef(e.arxivId), null, event.seq);
      for (const author of e.authors) {
        const person = await ensureEntity(
          tx,
          "person",
          personRef(author.name),
          normalizeName(author.name),
          event.seq,
        );
        if (author.email !== undefined) {
          await tx`
            insert into identifiers (scheme, value, entity_id, asserted_by)
            values ('email', ${author.email.toLowerCase()}, ${person}, ${event.source})
            on conflict (scheme, value) do nothing`;
        }
        for (const affiliation of author.affiliations) {
          const org = await ensureEntity(
            tx,
            "org",
            affiliation.org,
            affiliation.raw,
            event.seq,
          );
          await ensureLink(tx, {
            fromId: person,
            toId: org,
            linkType: "affiliated_with",
            assertedBy: event.source,
            confidence: 0.9,
            evidence: { arxivId: e.arxivId, raw: affiliation.raw },
            seq: event.seq,
          });
          await ensureLink(tx, {
            fromId: paper,
            toId: org,
            linkType: "affiliated_org",
            assertedBy: event.source,
            confidence: 0.9,
            evidence: { raw: affiliation.raw },
            seq: event.seq,
          });
        }
      }
      return;
    }
    throw new Error(`graph fold received unexpected event type ${event.type}`);
  },
};
