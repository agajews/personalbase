import { z } from "zod";
import type { Reactor, ReactorEvent } from "@nc/process";

// Draws the day's resurfacing sample from the saved library and records it
// as a fact. The md5(entity_id || day) ordering is deterministic, so a rerun
// on the same day derives the identical sample and the daily idempotency key
// dedups it — one surface.day.resurfaced event per day, ever.

export const resurfacerJobPayload = z.object({
  /** Defaults to today (UTC). */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** How many saved items to bring back. */
  count: z.number().int().min(1).max(50).optional(),
});

const defaultCount = 12;

export const resurfacerReactor: Reactor = {
  kind: "reactor",
  name: "resurfacer",
  // 6am Pacific: the sample day is the UTC date, and any morning-Pacific
  // hour maps to the same UTC calendar day, so "today's" shelf appears with
  // the morning batch instead of at whatever hour the cron drifted to.
  trigger: {
    kind: "cron",
    schedule: { dailyAtHour: 6, timeZone: "America/Los_Angeles" },
    payload: {},
  },
  async run(ctx, input): Promise<ReactorEvent[]> {
    if (input.kind !== "job") {
      throw new Error("resurfacer only supports job triggers");
    }
    const payload = resurfacerJobPayload.parse(input.payload);
    const day = payload.day ?? new Date().toISOString().slice(0, 10);
    const count = payload.count ?? defaultCount;
    const rows = await ctx.sql`
      select e.kind, e.ref
      from paper_marks m
      join entities e on e.entity_id = m.entity_id
      where m.mark = 'saved'
      order by md5(m.entity_id::text || ${day})
      limit ${count}`;
    if (rows.length === 0) {
      console.log("resurfacer: nothing saved yet");
      return [];
    }
    return [
      {
        type: "surface.day.resurfaced",
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        payload: {
          day,
          items: rows.map((r) => ({ kind: r["kind"], ref: r["ref"] })),
        },
        idempotencyKey: `resurfaced:${day}`,
      },
    ];
  },
};
