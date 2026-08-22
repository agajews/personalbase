import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Reactor, ReactorEvent } from "@nc/process";

// Imports a Paperpile library export (JSON array). Runs where the file lives
// (via the CLI), not on the deployed worker. occurred_at is the time the item
// was added to the library, so the library's history lands on the timeline.

const rawItem = z.looseObject({
  _id: z.string(),
  pubtype: z.string(),
  title: z.string().optional(),
  author: z
    .array(
      z.looseObject({
        first: z.string().optional(),
        last: z.string().optional(),
        formatted: z.string().optional(),
      }),
    )
    .optional(),
  published: z.looseObject({ year: z.string().optional() }).optional(),
  abstract: z.string().optional(),
  arxivid: z.string().optional(),
  doi: z.string().optional(),
  url: z.array(z.string()).optional(),
  journal: z.string().optional(),
  foldersNamed: z.array(z.string()).optional(),
  created: z.number(),
});

export function paperpileItemToEvent(raw: unknown): ReactorEvent {
  const item = rawItem.parse(raw);
  const authors = (item.author ?? [])
    .map((a) => [a.first, a.last].filter((p) => p !== undefined && p !== "").join(" ") || (a.formatted ?? ""))
    .filter((name) => name !== "");
  const year = item.published?.year === undefined ? undefined : Number(item.published.year);
  const url = item.url?.[0];
  return {
    type: "paperpile.item.imported",
    schemaVersion: 1,
    occurredAt: new Date(item.created * 1000).toISOString(),
    payload: {
      paperpileId: item._id,
      pubtype: item.pubtype,
      // Some items have a missing or empty title (mostly websites); fall
      // back rather than dropping them.
      title:
        (item.title !== undefined && item.title.trim() !== "" ? item.title.trim() : undefined) ??
        url ??
        `(untitled ${item._id})`,
      authors,
      ...(year !== undefined && Number.isFinite(year) ? { year } : {}),
      ...(item.abstract === undefined ? {} : { abstract: item.abstract }),
      ...(item.arxivid === undefined ? {} : { arxivId: item.arxivid }),
      ...(item.doi === undefined ? {} : { doi: item.doi }),
      ...(url === undefined ? {} : { url }),
      ...(item.journal === undefined ? {} : { journal: item.journal }),
      ...(item.foldersNamed === undefined ? {} : { folders: item.foldersNamed }),
      addedAt: new Date(item.created * 1000).toISOString(),
    },
    idempotencyKey: `paperpile:${item._id}`,
  };
}

export const paperpileJobPayload = z.object({ path: z.string().min(1) });

export const paperpileImportReactor: Reactor = {
  kind: "reactor",
  name: "paperpile-import",
  trigger: { kind: "manual" },
  async run(_ctx, input): Promise<ReactorEvent[]> {
    if (input.kind !== "job") {
      throw new Error("paperpile-import reactor only supports manual job triggers");
    }
    const { path } = paperpileJobPayload.parse(input.payload);
    const items = z.array(z.unknown()).parse(JSON.parse(await readFile(path, "utf8")));
    return items.map(paperpileItemToEvent);
  },
};
