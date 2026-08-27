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
// Default sweeps judge by arrival (ingested_at), which tracks arXiv's
// announcement day — submission dates lag announcements by days around
// weekends. 48h reaches back across a missed day; the unjudged-only query
// makes the overlap free.
const defaultWindowHours = 48;

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
 * Judges papers against defined filters. Papers already judged under the
 * filter's current prompt_hash are skipped, so reruns with an unchanged
 * prompt are free. A prompt edit takes effect as new judgments land — the
 * automatic sweep covers fresh arrivals, and the UI's judge button re-judges
 * an explicit range — while verdicts from earlier prompts stand until then.
 */
export function makePaperFilterReactor(judge: JudgeFn): Reactor {
  return {
    kind: "reactor",
    name: "paper-filter",
    // Judging reacts to papers arriving rather than running on a clock. Each
    // ingested-paper event schedules one shared sweep job (hourly dedupe
    // bucket) instead of judging inline, because judging batches 12 papers
    // per LLM call; the delay collapses a burst of arrivals into one sweep.
    // Already-judged (filter, prompt_hash, paper) triples are skipped, so
    // sweeps only pay for genuinely new papers or edited prompts.
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
      // No explicit range = a sweep over the day's arrivals; an explicit
      // range (the UI's judge button, backfills) matches papers whose
      // submission or arrival falls inside it.
      const byArrivalOnly = parsed.from === undefined;
      const to = parsed.to ?? new Date().toISOString();
      const payload = {
        ...parsed,
        to,
        from:
          parsed.from ??
          new Date(new Date(to).getTime() - defaultWindowHours * 3_600_000).toISOString(),
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
          byArrivalOnly
            ? // The arrival sweep fires ~60s after ingestion, when the papers
              // fold may not have applied the new events yet (it lost that
              // race once and the sweep silently judged nothing). The event
              // log is append-time consistent, so read arrivals straight from
              // it; distinct-on keeps the latest version of each paper.
              await ctx.sql`
                select distinct on (payload->>'arxivId')
                  payload->>'arxivId' as arxiv_id,
                  payload->>'title' as title,
                  payload->>'abstract' as abstract,
                  payload->'categories' as categories
                from events
                where type = 'arxiv.paper.ingested'
                  and recorded_at >= ${payload.from} and recorded_at < ${payload.to}
                  and not exists (
                    select 1 from filter_results r
                    where r.filter_name = ${filter.name}
                      and r.prompt_hash = ${filter.prompt_hash}
                      and r.arxiv_id = payload->>'arxivId'
                  )
                order by payload->>'arxivId', recorded_at desc`
            : await ctx.sql`
                select p.arxiv_id, p.title, p.abstract, p.categories
                from papers p
                where ((p.ingested_at >= ${payload.from} and p.ingested_at < ${payload.to})
                    or (p.updated_at >= ${payload.from} and p.updated_at < ${payload.to}))
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
