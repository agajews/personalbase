import { agentPaperFilteredV1 } from "@nc/schema";
import type { Fold } from "@nc/process";

export const filterResultsFold: Fold = {
  kind: "fold",
  name: "filter_results",
  version: 1,
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
  async apply(tx, event) {
    const r = agentPaperFilteredV1.parse(event.payload);
    await tx`
      insert into filter_results (filter_name, prompt_hash, arxiv_id, verdict,
                                  confidence, reason, decided_seq)
      values (${r.filterName}, ${r.promptHash}, ${r.arxivId}, ${r.verdict},
              ${r.confidence}, ${r.reason}, ${event.seq.toString()})
      on conflict (filter_name, prompt_hash, arxiv_id) do update set
        verdict = excluded.verdict,
        confidence = excluded.confidence,
        reason = excluded.reason,
        decided_seq = excluded.decided_seq`;
  },
};
