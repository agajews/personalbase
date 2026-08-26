// Pure helpers for the capture endpoint (the browser extension's POST):
// deciding whether a URL is an arXiv paper and canonicalizing everything else.

/**
 * The arXiv id in any arxiv.org paper URL (abs, pdf, or html pages; new-style
 * "2501.12345" and old-style "cs/0301012" ids), version stripped — identity
 * is unversioned, matching paperRef. Null for anything else.
 */
export function arxivIdFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== "arxiv.org" && !url.hostname.endsWith(".arxiv.org")) {
    return null;
  }
  const match = /^\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/.exec(
    url.pathname,
  );
  return match === null ? null : match[1]!;
}

const trackingParam = /^(utm_.*|fbclid|gclid|ref_src|mc_cid|mc_eid)$/;

/**
 * Canonical form for a captured page URL: no fragment, no tracking params,
 * no trailing slash. This is the resource's identity (`url:<...>` ref), so
 * the same page saved twice converges on one entity.
 */
export function normalizeCaptureUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (trackingParam.test(key)) {
      url.searchParams.delete(key);
    }
  }
  if (url.pathname.endsWith("/") && url.pathname !== "/") {
    url.pathname = url.pathname.slice(0, -1);
  }
  let out = url.toString();
  if (url.pathname === "/" && url.search === "" && out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}
