import { agentItemTaggedV2, agentTagVocabProposedV1 } from "@nc/schema";
import type { Fold } from "@nc/process";
import type { TransactionSql } from "@nc/log";
import { entityId } from "./ids.js";

// Granular topic tags over the saved library: a vocabulary the tagger
// invents, plus many tags per item. A new vocabulary replaces the old one
// wholesale and takes its assignments with it — the taxonomy fold's
// replace-by-latest rule, one level finer. Assignments naming a superseded
// vocabulary are dropped, so replay of an interleaved log lands the same
// rows as the live run.

interface TagRow {
  entityId: string;
  slug: string;
  strength: number;
  vocabId: string;
  seq: bigint;
}

async function flushTags(tx: TransactionSql, buffer: TagRow[]): Promise<void> {
  if (buffer.length === 0) {
    return;
  }
  // Dedupe within the batch (a re-tag of the same item); last wins, matching
  // the upsert. The join against tag_vocab drops slugs outside the vocabulary.
  const byKey = new Map(buffer.map((r) => [`${r.entityId}|${r.slug}`, r]));
  const rows = [...byKey.values()];
  await tx`
    insert into item_tags (entity_id, slug, strength, vocab_id, tagged_seq)
    select t.entity_id, t.slug, t.strength, t.vocab_id, t.seq
    from unnest(
      ${rows.map((r) => r.entityId)}::uuid[],
      ${rows.map((r) => r.slug)}::text[],
      ${rows.map((r) => r.strength)}::real[],
      ${rows.map((r) => r.vocabId)}::text[],
      ${rows.map((r) => r.seq.toString())}::bigint[]
    ) as t(entity_id, slug, strength, vocab_id, seq)
    join tag_vocab v on v.slug = t.slug
    on conflict (entity_id, slug) do update set
      strength = excluded.strength,
      vocab_id = excluded.vocab_id,
      tagged_seq = excluded.tagged_seq`;
  buffer.length = 0;
}

export const tagsFold: Fold = {
  kind: "fold",
  name: "tags",
  version: 2, // continuous tag strength
  consumes: ["agent.tagvocab.proposed", "agent.item.tagged"],
  tables: ["tag_vocab", "item_tags"],
  async init(tx) {
    await tx`
      create table tag_vocab (
        slug        text primary key,
        name        text not null,
        description text not null,
        facet       text not null,      -- 'method' | 'task' | ... , for grouping
        vocab_id    text not null,
        position    int not null,       -- order the model proposed them in
        created_seq bigint not null
      )`;
    await tx`
      create table item_tags (
        entity_id  uuid not null,
        slug       text not null,
        strength   real not null,   -- how central the tag is, in [0, 1]
        vocab_id   text not null,
        tagged_seq bigint not null,
        primary key (entity_id, slug)
      )`;
    await tx`create index item_tags_slug on item_tags (slug)`;
  },
  async apply(tx, events) {
    let vocabId: string | null =
      (await tx`select vocab_id from tag_vocab limit 1`)[0]?.["vocab_id"] ?? null;
    const buffer: TagRow[] = [];
    for (const event of events) {
      if (event.type === "agent.tagvocab.proposed") {
        const v = agentTagVocabProposedV1.parse(event.payload);
        buffer.length = 0; // assignments under the vocabulary being replaced
        await tx`delete from item_tags`;
        await tx`delete from tag_vocab`;
        await tx`
          insert into tag_vocab (slug, name, description, facet, vocab_id, position, created_seq)
          select * from unnest(
            ${v.tags.map((t) => t.slug)}::text[],
            ${v.tags.map((t) => t.name)}::text[],
            ${v.tags.map((t) => t.description)}::text[],
            ${v.tags.map((t) => t.facet)}::text[],
            ${v.tags.map(() => v.vocabId)}::text[],
            ${v.tags.map((_, i) => i)}::int[],
            ${v.tags.map(() => event.seq.toString())}::bigint[]
          )`;
        vocabId = v.vocabId;
        continue;
      }
      if (event.type === "agent.item.tagged") {
        // Payloads arrive upcast to v2 (v1 carried a rank-derived confidence).
        const t = agentItemTaggedV2.parse(event.payload);
        if (t.vocabId !== vocabId) {
          continue;
        }
        const id = entityId(t.target.kind, t.target.ref);
        for (const tag of t.tags) {
          buffer.push({
            entityId: id,
            slug: tag.slug,
            strength: tag.strength,
            vocabId: t.vocabId,
            seq: event.seq,
          });
        }
        continue;
      }
      throw new Error(`tags fold received unexpected event type ${event.type}`);
    }
    await flushTags(tx, buffer);
  },
};
