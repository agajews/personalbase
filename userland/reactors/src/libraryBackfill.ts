import type { Reactor, ReactorEvent } from "@nc/process";
import { entryToEvent, fetchArxivByIds } from "./arxiv.js";

/**
 * One-shot backfill: library items that are arXiv papers but have no papers
 * row get canonical metadata fetched from the arXiv API and re-enter through
 * the standard arxiv.paper.ingested event, converging onto the same entities.
 * Idempotent; re-running finds nothing left to do.
 */
export function makeLibraryArxivBackfillReactor(
  fetchByIds: typeof fetchArxivByIds,
): Reactor {
  return {
    kind: "reactor",
    name: "library-arxiv-backfill",
    trigger: { kind: "manual" },
    async run(ctx, input): Promise<ReactorEvent[]> {
      if (input.kind !== "job") {
        throw new Error("library-arxiv-backfill only supports job triggers");
      }
      const missing = await ctx.sql`
        select distinct li.arxiv_id from library_items li
        left join papers p on p.arxiv_id = li.arxiv_id
        where li.arxiv_id is not null and p.arxiv_id is null`;
      const ids = missing.map((r) => r["arxiv_id"] as string);
      console.log(`library backfill: ${ids.length} arxiv ids missing from papers`);
      if (ids.length === 0) {
        return [];
      }
      const entries = await fetchByIds(ids);
      const found = new Set(entries.map((e) => e.arxivId));
      const unresolved = ids.filter((id) => !found.has(id));
      if (unresolved.length > 0) {
        console.log(
          `library backfill: ${unresolved.length} ids not returned by arxiv ` +
            `(withdrawn or malformed): ${unresolved.slice(0, 10).join(", ")}${unresolved.length > 10 ? ", …" : ""}`,
        );
      }
      return entries.map(entryToEvent);
    },
  };
}

export const libraryArxivBackfillReactor: Reactor =
  makeLibraryArxivBackfillReactor(fetchArxivByIds);
