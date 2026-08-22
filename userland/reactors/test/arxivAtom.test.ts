import { describe, expect, test } from "vitest";
import { parseArxivAtom } from "@nc/reactors";

const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: ...</title>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">2</opensearch:totalResults>
  <opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2508.11111v2</id>
    <updated>2025-08-21T17:59:00Z</updated>
    <published>2025-08-20T10:00:00Z</published>
    <title>H-Nets: Hierarchical  Networks
 with Wrapped   Titles</title>
    <summary>  We propose a thing.
It is good. </summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="stat.ML" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2508.22222v1</id>
    <updated>2025-08-21T18:59:00Z</updated>
    <published>2025-08-21T18:59:00Z</published>
    <title>Single Author, Single Category</title>
    <summary>Short.</summary>
    <author><name>Solo Author</name></author>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

describe("parseArxivAtom", () => {
  test("parses entries, normalizing ids, whitespace, and singletons", () => {
    const { total, entries } = parseArxivAtom(fixture);
    expect(total).toBe(2);
    expect(entries).toHaveLength(2);

    const first = entries[0]!;
    expect(first.arxivId).toBe("2508.11111");
    expect(first.arxivVersion).toBe(2);
    expect(first.title).toBe("H-Nets: Hierarchical Networks with Wrapped Titles");
    expect(first.abstract).toBe("We propose a thing. It is good.");
    expect(first.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
    expect(first.categories).toEqual(["cs.LG", "stat.ML"]);

    const second = entries[1]!;
    expect(second.authors).toEqual(["Solo Author"]);
    expect(second.categories).toEqual(["cs.CL"]);
  });

  test("an empty feed parses to zero entries", () => {
    const empty = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults>
</feed>`;
    expect(parseArxivAtom(empty)).toEqual({ total: 0, entries: [] });
  });
});
