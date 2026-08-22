import { createHash } from "node:crypto";
import { userFilterDefinedV1 } from "@nc/schema";
import type { Fold } from "@nc/process";

/**
 * Identifies the exact judging configuration. Editing the prompt (or model)
 * yields a new hash, so past verdicts stay attributed to the prompt version
 * that produced them and a rerun re-judges everything under the new hash.
 */
export function promptHash(model: string, prompt: string): string {
  return createHash("sha256").update(`${model}\n${prompt}`).digest("hex").slice(0, 12);
}

export const filtersFold: Fold = {
  kind: "fold",
  name: "filters",
  version: 1,
  consumes: ["user.filter.defined"],
  tables: ["filters"],
  async init(tx) {
    await tx`
      create table filters (
        name        text primary key,
        prompt      text not null,
        model       text not null,
        prompt_hash text not null,
        defined_seq bigint not null
      )`;
  },
  async apply(tx, event) {
    const f = userFilterDefinedV1.parse(event.payload);
    await tx`
      insert into filters (name, prompt, model, prompt_hash, defined_seq)
      values (${f.name}, ${f.prompt}, ${f.model}, ${promptHash(f.model, f.prompt)},
              ${event.seq.toString()})
      on conflict (name) do update set
        prompt = excluded.prompt,
        model = excluded.model,
        prompt_hash = excluded.prompt_hash,
        defined_seq = excluded.defined_seq`;
  },
};
