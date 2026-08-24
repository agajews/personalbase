import { surfaceDayResurfacedV1 } from "@nc/schema";
import type { Fold } from "@nc/process";
import { entityId } from "./ids.js";

// The timeline's resurfacing history: which saved items were brought back on
// which day, in sample order.

export const resurfacedFold: Fold = {
  kind: "fold",
  name: "resurfaced",
  version: 1,
  consumes: ["surface.day.resurfaced"],
  tables: ["resurfaced_items"],
  async init(tx) {
    await tx`
      create table resurfaced_items (
        day       date not null,
        position  int not null,
        entity_id uuid not null,
        primary key (day, position)
      )`;
    await tx`create index resurfaced_day on resurfaced_items (day)`;
  },
  async apply(tx, events) {
    // At most one event per day (idempotency key), but replay-safe anyway:
    // last event for a day replaces it wholesale.
    for (const event of events) {
      const s = surfaceDayResurfacedV1.parse(event.payload);
      await tx`delete from resurfaced_items where day = ${s.day}`;
      await tx`
        insert into resurfaced_items (day, position, entity_id)
        select ${s.day}::date, position, id from unnest(
          ${s.items.map((_, i) => i)}::int[],
          ${s.items.map((item) => entityId(item.kind, item.ref))}::uuid[]
        ) as t(position, id)`;
    }
  },
};
