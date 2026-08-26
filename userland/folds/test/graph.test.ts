import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { coreRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { createTestDb } from "@nc/log/testing";
import { catchUpFold } from "@nc/process";
import { entityId, graphFold, paperRef, personRef } from "@nc/folds";

let sql: Sql;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ sql, drop } = await createTestDb());
});
afterAll(async () => {
  await drop();
});

const paperEvent = {
  type: "arxiv.paper.ingested",
  schemaVersion: 1,
  source: "reactor:arxiv",
  occurredAt: "2026-08-20T00:00:00.000Z",
  payload: {
    arxivId: "2608.00001",
    arxivVersion: 1,
    title: "A Paper",
    abstract: "About things.",
    authors: ["Ada Lovelace", "Alan  Turing"], // note double space: normalized
    categories: ["cs.LG"],
    publishedAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  },
  idempotencyKey: "arxiv:2608.00001v1",
};

describe("graph fold", () => {
  test("papers mint paper + person entities and authored links", async () => {
    await appendEvents(sql, coreRegistry, [paperEvent]);
    await catchUpFold(sql, coreRegistry, graphFold);

    const people = await sql`select display_name from entities where kind = 'person' order by display_name`;
    expect(people.map((p) => p["display_name"])).toEqual(["Ada Lovelace", "Alan Turing"]);

    const links = await sql`
      select count(*)::int as n from links
      where link_type = 'authored' and to_id = ${entityId("paper", paperRef("2608.00001"))}`;
    expect(links[0]!["n"]).toBe(2);
  });

  test("affiliation extraction mints orgs, links, and email identifiers", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "agent.paper.affiliations_extracted",
        schemaVersion: 1,
        source: "reactor:affiliations",
        occurredAt: "2026-08-20T01:00:00.000Z",
        payload: {
          arxivId: "2608.00001",
          authors: [
            {
              name: "ada lovelace", // case-insensitive ref converges with the paper author
              affiliations: [{ raw: "Anthropic, San Francisco", org: "anthropic" }],
              email: "Ada@Anthropic.com",
            },
          ],
        },
        idempotencyKey: "affiliations:2608.00001v1",
      },
    ]);
    await catchUpFold(sql, coreRegistry, graphFold);

    // Same person entity as the one minted from the paper's author list.
    const person = entityId("person", personRef("Ada Lovelace"));
    const idents = await sql`select value from identifiers where entity_id = ${person}`;
    expect(idents.map((i) => i["value"])).toEqual(["ada@anthropic.com"]);

    const orgLinks = await sql`
      select l.link_type from links l
      where l.to_id = ${entityId("org", "anthropic")} order by l.link_type`;
    expect(orgLinks.map((l) => l["link_type"])).toEqual(["affiliated_org", "affiliated_with"]);
  });

  test("asserted links create entities and carry provenance", async () => {
    await appendEvents(sql, coreRegistry, [
      {
        type: "agent.link.asserted",
        schemaVersion: 1,
        source: "reactor:lab-publications",
        occurredAt: "2026-08-20T02:00:00.000Z",
        payload: {
          from: { kind: "paper", ref: paperRef("2608.00001") },
          to: { kind: "org", ref: "anthropic", displayName: "Anthropic" },
          linkType: "published_by",
          confidence: 1,
          evidence: { source: "https://www.anthropic.com/research" },
        },
        idempotencyKey: "lab:anthropic:2608.00001:published_by",
      },
    ]);
    await catchUpFold(sql, coreRegistry, graphFold);

    const rows = await sql`
      select asserted_by, confidence from links where link_type = 'published_by'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!["asserted_by"]).toBe("reactor:lab-publications");
  });

  test("captured pages mint resource entities with a url identifier", async () => {
    const url = "https://example.com/great-post";
    await appendEvents(sql, coreRegistry, [
      {
        type: "user.resource.captured",
        schemaVersion: 1,
        source: "ui:capture",
        occurredAt: "2026-08-20T03:00:00.000Z",
        payload: { url, title: "A Great Post", siteName: "Example Blog" },
        idempotencyKey: `capture:${url}`,
      },
    ]);
    await catchUpFold(sql, coreRegistry, graphFold);

    const entity = (await sql`
      select entity_id, kind, display_name from entities where ref = ${"url:" + url}`)[0]!;
    expect(entity["kind"]).toBe("resource");
    expect(entity["display_name"]).toBe("A Great Post");
    expect(entity["entity_id"]).toBe(entityId("resource", `url:${url}`));

    const idents = await sql`
      select scheme, value from identifiers where entity_id = ${entity["entity_id"]}`;
    expect(idents).toEqual([{ scheme: "url", value: url }]);
  });
});
