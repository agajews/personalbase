import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { coreRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpFolds } from "@nc/process";
import { entityId, graphFold, libraryFold, paperRef } from "@nc/folds";
import { paperpileItemToEvent } from "@nc/reactors";

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

const rawPaperpileItem = {
  _id: "pp-1",
  pubtype: "PP_PREPRINT",
  title: "Improved denoising diffusion probabilistic models",
  author: [
    { first: "Alex", last: "Nichol", formatted: "Nichol A" },
    { first: "Prafulla", last: "Dhariwal", formatted: "Dhariwal P" },
  ],
  published: { year: "2021" },
  arxivid: "2102.09672",
  doi: "10.48550/arXiv.2102.09672",
  url: ["http://arxiv.org/abs/2102.09672"],
  journal: "arXiv [cs.LG]",
  foldersNamed: ["Diffusion"],
  created: 1787418458.035,
};

describe("paperpile import", () => {
  test("items fold into library_items and converge with arXiv paper entities", async () => {
    // The same paper arrives from arXiv ingestion first...
    await appendEvents(sql, coreRegistry, [
      {
        type: "arxiv.paper.ingested",
        schemaVersion: 1,
        source: "reactor:arxiv",
        occurredAt: "2021-02-18T00:00:00.000Z",
        payload: {
          arxivId: "2102.09672",
          arxivVersion: 1,
          title: "Improved denoising diffusion probabilistic models",
          abstract: "DDPMs...",
          authors: ["Alex Nichol", "Prafulla Dhariwal"],
          categories: ["cs.LG"],
          publishedAt: "2021-02-18T00:00:00.000Z",
          updatedAt: "2021-02-18T00:00:00.000Z",
        },
        idempotencyKey: "arxiv:2102.09672v1",
      },
      // ...and then from the Paperpile export.
      { ...paperpileItemToEvent(rawPaperpileItem), source: "reactor:paperpile-import" },
    ]);
    await catchUpFolds(sql, coreRegistry, [graphFold, libraryFold]);

    const expectedEntity = entityId("paper", paperRef("2102.09672"));
    const items = await sql`select entity_id, title, year, folders from library_items`;
    expect(items).toHaveLength(1);
    expect(items[0]!["entity_id"]).toBe(expectedEntity);
    expect(items[0]!["year"]).toBe(2021);
    expect(items[0]!["folders"]).toEqual(["Diffusion"]);

    // One paper entity, not two; authors converge too.
    const papers = await sql`select count(*)::int as n from entities where kind = 'paper'`;
    expect(papers[0]!["n"]).toBe(1);
    const people = await sql`select count(*)::int as n from entities where kind = 'person'`;
    expect(people[0]!["n"]).toBe(2);
    const idents = await sql`select scheme, value from identifiers order by scheme`;
    expect(idents.map((i) => [i["scheme"], i["value"]])).toEqual([
      ["arxiv_id", "2102.09672"],
      ["doi", "10.48550/arxiv.2102.09672"],
    ]);
  });

  test("items without arxiv id or title still map", () => {
    const event = paperpileItemToEvent({
      _id: "pp-2",
      pubtype: "PP_WEBSITE",
      url: ["https://example.com/post"],
      created: 1700000000,
    });
    const payload = event.payload as { title: string; authors: string[] };
    expect(payload.title).toBe("https://example.com/post");
    expect(payload.authors).toEqual([]);
    expect(event.idempotencyKey).toBe("paperpile:pp-2");
  });
});
