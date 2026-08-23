import { agentTaxonomyProposedV1 } from "@nc/schema";
import type { Fold } from "@nc/process";

// The LLM-proposed classification scheme for the saved library. Each
// proposal replaces the scheme wholesale (the latest event wins); paper
// assignments live in the graph as classified_as links carrying the
// schemeId in their evidence.

export const taxonomyFold: Fold = {
  kind: "fold",
  name: "taxonomy",
  version: 1,
  consumes: ["agent.taxonomy.proposed"],
  tables: ["taxonomy_categories"],
  async init(tx) {
    await tx`
      create table taxonomy_categories (
        slug        text primary key,
        name        text not null,
        description text not null,
        scheme_id   text not null,
        position    int not null,      -- order the model proposed them in
        created_seq bigint not null
      )`;
  },
  async apply(tx, events) {
    // Only the last proposal in the batch matters: the scheme is replaced
    // wholesale, matching replay semantics.
    const event = events[events.length - 1]!;
    const t = agentTaxonomyProposedV1.parse(event.payload);
    await tx`delete from taxonomy_categories`;
    await tx`
      insert into taxonomy_categories (slug, name, description, scheme_id, position, created_seq)
      select * from unnest(
        ${t.categories.map((c) => c.slug)}::text[],
        ${t.categories.map((c) => c.name)}::text[],
        ${t.categories.map((c) => c.description)}::text[],
        ${t.categories.map(() => t.schemeId)}::text[],
        ${t.categories.map((_, i) => i)}::int[],
        ${t.categories.map(() => event.seq.toString())}::bigint[]
      )`;
  },
};
