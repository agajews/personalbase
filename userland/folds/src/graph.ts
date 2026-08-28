import {
  agentLinkAssertedV1,
  agentPaperAffiliationsExtractedV1,
  arxivPaperIngestedV1,
  paperpileItemImportedV1,
  userLinkSubmittedV1,
  webPageIngestedV1,
  type PaperpileItemImported,
} from "@nc/schema";
import type { Fold } from "@nc/process";
import type { StoredEvent } from "@nc/log";
import { entityId } from "./ids.js";

// The cross-domain graph: an entity registry, an identifier substrate, and
// typed links with provenance. Entity ids are minted deterministically from
// (kind, ref), so replay and independent producers converge. Application is
// set-based: each batch is folded into in-memory maps (with the same merge
// rules the SQL upserts apply against existing rows), then written with one
// multi-row upsert per table.

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function personRef(name: string): string {
  return `author:${normalizeName(name).toLowerCase()}`;
}

/** Some sources store versioned ids ("2205.01068v1"); identity is unversioned. */
export function normalizeArxivId(id: string): string {
  return id.replace(/v\d+$/, "");
}

export function paperRef(arxivId: string): string {
  return `arxiv:${normalizeArxivId(arxivId)}`;
}

// arxiv.org/abs/2508.12345v2, /pdf/2508.12345.pdf, /html/…, and the old
// slashed ids (hep-th/9901001) all name the same paper.
const arxivUrlPattern =
  /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/([^?#]+?)(?:\.pdf)?\/?$/i;

/** The arXiv id a URL points at, or null when it points somewhere else. */
export function arxivIdFromUrl(url: string): string | null {
  const match = arxivUrlPattern.exec(url.trim());
  return match === null ? null : normalizeArxivId(match[1]!);
}

/**
 * Where a pasted link lands in the graph. arXiv links converge on the paper
 * arXiv ingestion already owns rather than minting a second entity for it;
 * everything else is a resource keyed by its URL, the same ref library
 * items use.
 */
export function submittedLinkEntity(url: string): { kind: string; ref: string } {
  const arxivId = arxivIdFromUrl(url);
  if (arxivId !== null) {
    return { kind: "paper", ref: paperRef(arxivId) };
  }
  return { kind: "resource", ref: `url:${url}` };
}

/**
 * Tidies what a human pasted into a URL: surrounding whitespace, and a bare
 * host with no scheme. Deliberately nothing else — refs are compared as
 * written, so any further rewriting would fork the entity for a link the
 * library already holds. Null when the result still isn't a URL.
 */
export function normalizeSubmittedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  // A bare word is a valid hostname to the URL parser, so a typo would
  // otherwise become a resource entity. Demand a dot when we supplied the
  // scheme ourselves; someone who typed http://localhost meant it.
  if (!hasScheme && !parsed.hostname.includes(".")) {
    return null;
  }
  return withScheme;
}

const scholarlyPubtypes = new Set([
  "PP_PREPRINT",
  "PP_ARTICLE",
  "PP_CONFERENCE_PAPER",
  "PP_REPORT",
  "PP_THESIS",
]);

/**
 * Identity precedence for library items: arXiv id (converging with arXiv
 * ingestion), then DOI, then URL, then the Paperpile id as a last resort.
 */
export function libraryItemEntity(
  item: Pick<PaperpileItemImported, "pubtype" | "arxivId" | "doi" | "url" | "paperpileId">,
): { kind: string; ref: string } {
  const kind = scholarlyPubtypes.has(item.pubtype) ? "paper" : "resource";
  if (item.arxivId !== undefined) {
    return { kind: "paper", ref: paperRef(item.arxivId) };
  }
  if (item.doi !== undefined) {
    return { kind, ref: `doi:${item.doi.toLowerCase()}` };
  }
  if (item.url !== undefined) {
    return { kind, ref: `url:${item.url}` };
  }
  return { kind, ref: `paperpile:${item.paperpileId}` };
}

interface EntityRow {
  kind: string;
  ref: string;
  displayName: string | null;
  seq: bigint;
}

interface LinkRow {
  fromId: string;
  toId: string;
  linkType: string;
  assertedBy: string;
  confidence: number;
  evidence: unknown;
  seq: bigint;
}

interface IdentifierRow {
  scheme: string;
  value: string;
  entityId: string;
  assertedBy: string;
}

class Batch {
  entities = new Map<string, EntityRow>();
  links = new Map<string, LinkRow>();
  identifiers = new Map<string, IdentifierRow>();

  /** Shortest non-null display name wins — commutative, order-independent. */
  entity(kind: string, ref: string, displayName: string | null, seq: bigint): string {
    const id = entityId(kind, ref);
    const prev = this.entities.get(id);
    if (prev === undefined) {
      this.entities.set(id, { kind, ref, displayName, seq });
    } else if (
      displayName !== null &&
      (prev.displayName === null || displayName.length < prev.displayName.length)
    ) {
      prev.displayName = displayName;
    }
    return id;
  }

  link(row: LinkRow): void {
    // Last assertion wins (matches the upsert's confidence/evidence update).
    this.links.set(`${row.fromId}|${row.toId}|${row.linkType}|${row.assertedBy}`, row);
  }

  identifier(row: IdentifierRow): void {
    // First wins (matches on conflict do nothing).
    const key = `${row.scheme}|${row.value}`;
    if (!this.identifiers.has(key)) {
      this.identifiers.set(key, row);
    }
  }
}

function fold(batch: Batch, event: StoredEvent): void {
  if (event.type === "arxiv.paper.ingested") {
    const p = arxivPaperIngestedV1.parse(event.payload);
    const paper = batch.entity("paper", paperRef(p.arxivId), p.title, event.seq);
    for (const name of p.authors) {
      const person = batch.entity("person", personRef(name), normalizeName(name), event.seq);
      batch.link({
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
    const from = batch.entity(l.from.kind, l.from.ref, l.from.displayName ?? null, event.seq);
    const to = batch.entity(l.to.kind, l.to.ref, l.to.displayName ?? null, event.seq);
    batch.link({
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
  if (event.type === "paperpile.item.imported") {
    const item = paperpileItemImportedV1.parse(event.payload);
    const target = libraryItemEntity(item);
    const entity = batch.entity(target.kind, target.ref, item.title, event.seq);
    if (item.arxivId !== undefined) {
      batch.identifier({
        scheme: "arxiv_id",
        value: normalizeArxivId(item.arxivId),
        entityId: entity,
        assertedBy: event.source,
      });
    }
    if (item.doi !== undefined) {
      batch.identifier({
        scheme: "doi",
        value: item.doi.toLowerCase(),
        entityId: entity,
        assertedBy: event.source,
      });
    }
    for (const name of item.authors) {
      const person = batch.entity("person", personRef(name), normalizeName(name), event.seq);
      batch.link({
        fromId: person,
        toId: entity,
        linkType: "authored",
        assertedBy: event.source,
        confidence: 1,
        evidence: undefined,
        seq: event.seq,
      });
    }
    return;
  }
  if (event.type === "user.link.submitted") {
    const link = userLinkSubmittedV1.parse(event.payload);
    const target = submittedLinkEntity(link.url);
    // The entity exists from the moment the link is pasted, so the mark it
    // carries is never an orphan. It has no name yet — the ingestion event
    // below supplies one, and until then the UI shows the URL.
    batch.entity(target.kind, target.ref, null, event.seq);
    return;
  }
  if (event.type === "web.page.ingested") {
    const page = webPageIngestedV1.parse(event.payload);
    batch.entity("resource", `url:${page.url}`, page.title, event.seq);
    return;
  }
  if (event.type === "agent.paper.affiliations_extracted") {
    const e = agentPaperAffiliationsExtractedV1.parse(event.payload);
    const paper = batch.entity("paper", paperRef(e.arxivId), null, event.seq);
    for (const author of e.authors) {
      const person = batch.entity("person", personRef(author.name), normalizeName(author.name), event.seq);
      if (author.email !== undefined) {
        batch.identifier({
          scheme: "email",
          value: author.email.toLowerCase(),
          entityId: person,
          assertedBy: event.source,
        });
      }
      for (const affiliation of author.affiliations) {
        const org = batch.entity("org", affiliation.org, affiliation.raw, event.seq);
        batch.link({
          fromId: person,
          toId: org,
          linkType: "affiliated_with",
          assertedBy: event.source,
          confidence: 0.9,
          evidence: { arxivId: e.arxivId, raw: affiliation.raw },
          seq: event.seq,
        });
        batch.link({
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
}

export const graphFold: Fold = {
  kind: "fold",
  name: "graph",
  version: 6, // pasted links and the pages they resolve to
  consumes: [
    "arxiv.paper.ingested",
    "agent.link.asserted",
    "agent.paper.affiliations_extracted",
    "paperpile.item.imported",
    "user.link.submitted",
    "web.page.ingested",
  ],
  tables: ["entities", "identifiers", "links"],
  async init(tx) {
    await tx`
      create table entities (
        entity_id    uuid primary key,
        kind         text not null,
        ref          text not null,     -- stable external ref the id was minted from
        canonical_id uuid not null,     -- self until merges exist
        display_name text,
        created_seq  bigint not null
      )`;
    await tx`create index entities_kind on entities (kind)`;
    await tx`
      create table identifiers (
        scheme      text not null,
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
        link_type   text not null,
        asserted_by text not null,
        confidence  real not null default 1.0,
        evidence    jsonb,
        created_seq bigint not null,
        unique (from_id, to_id, link_type, asserted_by)
      )`;
    await tx`create index links_from on links (from_id, link_type)`;
    await tx`create index links_to on links (to_id, link_type)`;
  },
  async apply(tx, events) {
    const batch = new Batch();
    for (const event of events) {
      fold(batch, event);
    }
    const entities = [...batch.entities.entries()];
    if (entities.length > 0) {
      await tx`
        insert into entities (entity_id, kind, ref, canonical_id, display_name, created_seq)
        select id, kind, ref, id, display_name, seq from unnest(
          ${entities.map(([id]) => id)}::uuid[],
          ${entities.map(([, e]) => e.kind)}::text[],
          ${entities.map(([, e]) => e.ref)}::text[],
          ${entities.map(([, e]) => e.displayName)}::text[],
          ${entities.map(([, e]) => e.seq.toString())}::bigint[]
        ) as t(id, kind, ref, display_name, seq)
        on conflict (entity_id) do update
          set display_name = case
            when excluded.display_name is null then entities.display_name
            when entities.display_name is null then excluded.display_name
            when length(excluded.display_name) < length(entities.display_name)
              then excluded.display_name
            else entities.display_name
          end`;
    }
    const identifiers = [...batch.identifiers.values()];
    if (identifiers.length > 0) {
      await tx`
        insert into identifiers (scheme, value, entity_id, asserted_by)
        select * from unnest(
          ${identifiers.map((i) => i.scheme)}::text[],
          ${identifiers.map((i) => i.value)}::text[],
          ${identifiers.map((i) => i.entityId)}::uuid[],
          ${identifiers.map((i) => i.assertedBy)}::text[]
        )
        on conflict (scheme, value) do nothing`;
    }
    const links = [...batch.links.values()];
    if (links.length > 0) {
      await tx`
        insert into links (link_id, from_id, to_id, link_type, asserted_by,
                           confidence, evidence, created_seq)
        select link_id, from_id, to_id, link_type, asserted_by, confidence,
               evidence::jsonb, seq
        from unnest(
          ${links.map((l) => entityId("link", `${l.fromId}|${l.toId}|${l.linkType}|${l.assertedBy}`))}::uuid[],
          ${links.map((l) => l.fromId)}::uuid[],
          ${links.map((l) => l.toId)}::uuid[],
          ${links.map((l) => l.linkType)}::text[],
          ${links.map((l) => l.assertedBy)}::text[],
          ${links.map((l) => l.confidence)}::real[],
          ${links.map((l) => (l.evidence === undefined ? null : JSON.stringify(l.evidence)))}::text[],
          ${links.map((l) => l.seq.toString())}::bigint[]
        ) as t(link_id, from_id, to_id, link_type, asserted_by, confidence,
               evidence, seq)
        on conflict (from_id, to_id, link_type, asserted_by) do update
          set confidence = excluded.confidence, evidence = excluded.evidence`;
    }
  },
};
