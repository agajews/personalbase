import { z } from "zod";
import type { Reactor, ReactorEvent, ReactorResult } from "@nc/process";
import { anthropicJudge, type JudgeFn, type PaperForJudging } from "./judge.js";

export const paperFilterJobPayload = z.object({
  /** Defaults to a trailing window ending now, matching the ingest sweep. */
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  /** Filter name; omit to run every defined filter. */
  filter: z.string().optional(),
});
export type PaperFilterJobPayload = z.infer<typeof paperFilterJobPayload>;

const chunkSize = 12;
// Must reach back at least as far as the ingest sweep's window (see
// arxiv.ts): papers announced after a weekend arrive with updated_at several
// days in the past, and a shorter window here would never judge them.
const defaultWindowDays = 6;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

interface FilterRow {
  readonly name: string;
  readonly prompt: string;
  readonly model: string;
  readonly prompt_hash: string;
}

/**
 * Judges papers in the requested date range against defined filters. Papers
 * already judged under the filter's current prompt_hash are skipped, so a
 * prompt edit (new hash) naturally re-judges the range while an unchanged
 * prompt makes reruns free.
 */
export function makePaperFilterReactor(judge: JudgeFn): Reactor {
  return {
    kind: "reactor",
    name: "paper-filter",
    // Judging reacts to papers arriving rather than running on a clock. Each
    // ingested-paper event schedules one shared sweep job (hourly dedupe
    // bucket) instead of judging inline, because judging batches 12 papers
    // per LLM call; the delay gives the papers fold time to catch up before
    // the sweep queries it. Already-judged (filter, prompt_hash, paper)
    // triples are skipped, so sweeps only pay for genuinely new papers or
    // edited prompts.
    trigger: { kind: "event", consumes: ["arxiv.paper.ingested"] },
    async run(ctx, input): Promise<ReactorResult> {
      if (input.kind === "event") {
        return {
          events: [],
          followUps: [
            {
              process: "reactor:paper-filter",
              payload: {},
              runAfterSeconds: 60,
              dedupeKey: `paper-filter:sweep:${new Date().toISOString().slice(0, 13)}`,
            },
          ],
        };
      }
      const parsed = paperFilterJobPayload.parse(input.payload);
      const to = parsed.to ?? new Date().toISOString();
      const payload = {
        ...parsed,
        to,
        from:
          parsed.from ??
          new Date(new Date(to).getTime() - defaultWindowDays * 86_400_000).toISOString(),
      };
      const filters: FilterRow[] =
        payload.filter === undefined
          ? await ctx.sql`select name, prompt, model, prompt_hash from filters`
          : await ctx.sql`
              select name, prompt, model, prompt_hash from filters
              where name = ${payload.filter}`;
      if (payload.filter !== undefined && filters.length === 0) {
        throw new Error(`no filter named ${payload.filter}`);
      }
      const events: ReactorEvent[] = [];
      for (const filter of filters) {
        const papers: PaperForJudging[] = (
          await ctx.sql`
            select p.arxiv_id, p.title, p.abstract, p.categories
            from papers p
            where ((p.updated_at >= ${payload.from} and p.updated_at < ${payload.to})
                or (p.ingested_at >= ${payload.from} and p.ingested_at < ${payload.to}))
              and not exists (
                select 1 from filter_results r
                where r.filter_name = ${filter.name}
                  and r.prompt_hash = ${filter.prompt_hash}
                  and r.arxiv_id = p.arxiv_id
              )
            order by p.updated_at`
        ).map((row) => ({
          arxivId: row["arxiv_id"],
          title: row["title"],
          abstract: row["abstract"],
          categories: row["categories"],
        }));
        for (const chunk of chunks(papers, chunkSize)) {
          const result = await judge(filter.model, filter.prompt, chunk);
          ctx.recordUsage(result.usage);
          const decidedAt = new Date().toISOString();
          for (const judgment of result.judgments) {
            events.push({
              type: "agent.paper.filtered",
              schemaVersion: 1,
              occurredAt: decidedAt,
              payload: {
                filterName: filter.name,
                promptHash: filter.prompt_hash,
                arxivId: judgment.arxivId,
                verdict: judgment.verdict,
                confidence: judgment.confidence,
                reason: judgment.reason,
              },
              idempotencyKey: `paper-filter:${filter.name}:${filter.prompt_hash}:${judgment.arxivId}`,
            });
          }
        }
      }
      return events;
    },
  };
}

export const paperFilterReactor: Reactor = makePaperFilterReactor(anthropicJudge);
