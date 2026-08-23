import { agentPaperFilteredV1, type AgentPaperFiltered } from "@nc/schema";
import type { Fold } from "@nc/process";

export const filterResultsFold: Fold = {
  kind: "fold",
  name: "filter_results",
  version: 2, // batched apply
  consumes: ["agent.paper.filtered"],
  tables: ["filter_results"],
  async init(tx) {
    await tx`
      create table filter_results (
        filter_name text not null,
        prompt_hash text not null,
        arxiv_id    text not null,
        verdict     text not null,
        confidence  real not null,
        reason      text not null,
        decided_seq bigint not null,
        primary key (filter_name, prompt_hash, arxiv_id)
      )`;
  },
  async apply(tx, events) {
    // Last verdict per (filter, prompt, paper) wins, matching the upsert.
    const byKey = new Map<string, { r: AgentPaperFiltered; seq: bigint }>();
    for (const event of events) {
      const r = agentPaperFilteredV1.parse(event.payload);
      byKey.set(`${r.filterName}|${r.promptHash}|${r.arxivId}`, { r, seq: event.seq });
    }
    const rows = [...byKey.values()];
    await tx`
      insert into filter_results (filter_name, prompt_hash, arxiv_id, verdict,
                                  confidence, reason, decided_seq)
      select * from unnest(
        ${rows.map((x) => x.r.filterName)}::text[],
        ${rows.map((x) => x.r.promptHash)}::text[],
        ${rows.map((x) => x.r.arxivId)}::text[],
        ${rows.map((x) => x.r.verdict)}::text[],
        ${rows.map((x) => x.r.confidence)}::real[],
        ${rows.map((x) => x.r.reason)}::text[],
        ${rows.map((x) => x.seq.toString())}::bigint[]
      )
      on conflict (filter_name, prompt_hash, arxiv_id) do update set
        verdict = excluded.verdict,
        confidence = excluded.confidence,
        reason = excluded.reason,
        decided_seq = excluded.decided_seq`;
  },
};
