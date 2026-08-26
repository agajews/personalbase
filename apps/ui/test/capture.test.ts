import { describe, expect, test } from "vitest";
import { arxivIdFromUrl, normalizeCaptureUrl } from "../src/capture.js";

describe("arxivIdFromUrl", () => {
  test("abs, pdf, and html pages, versioned or not", () => {
    expect(arxivIdFromUrl("https://arxiv.org/abs/2501.12345")).toBe("2501.12345");
    expect(arxivIdFromUrl("https://arxiv.org/abs/2501.12345v2")).toBe("2501.12345");
    expect(arxivIdFromUrl("https://arxiv.org/pdf/2501.12345v1")).toBe("2501.12345");
    expect(arxivIdFromUrl("https://arxiv.org/html/2501.12345v1")).toBe("2501.12345");
    expect(arxivIdFromUrl("https://www.arxiv.org/abs/2501.12345")).toBe("2501.12345");
  });

  test("old-style ids keep their archive prefix", () => {
    expect(arxivIdFromUrl("https://arxiv.org/abs/cs/0301012")).toBe("cs/0301012");
    expect(arxivIdFromUrl("https://arxiv.org/abs/math.GT/0309136")).toBe("math.GT/0309136");
  });

  test("non-paper and non-arxiv URLs are null", () => {
    expect(arxivIdFromUrl("https://arxiv.org/list/cs.LG/recent")).toBeNull();
    expect(arxivIdFromUrl("https://example.com/abs/2501.12345")).toBeNull();
    expect(arxivIdFromUrl("https://notarxiv.org/abs/2501.12345")).toBeNull();
    expect(arxivIdFromUrl("not a url")).toBeNull();
  });
});

describe("normalizeCaptureUrl", () => {
  test("strips fragments, tracking params, and trailing slashes", () => {
    expect(
      normalizeCaptureUrl("https://example.com/post/?utm_source=x&fbclid=abc&id=7#section"),
    ).toBe("https://example.com/post?id=7");
    expect(normalizeCaptureUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeCaptureUrl("https://example.com/a/b/")).toBe("https://example.com/a/b");
  });

  test("keeps meaningful query params", () => {
    expect(normalizeCaptureUrl("https://example.com/watch?v=xyz")).toBe(
      "https://example.com/watch?v=xyz",
    );
  });
});
