// One-click capture: the action button saves the current page into
// personalbase via POST /api/capture. The server decides what the page is
// (arXiv URLs become papers with canonical metadata via the arxiv reactor;
// everything else a captured resource) — this worker only collects the URL
// and the page's own metadata.
//
// Auth is the transport, matching the system's no-password rule: requests to
// the sprite URL carry the browser's Fly SSO session (credentials: include),
// and local dev talks to loopback.

const defaults = { baseUrl: "https://nc-main-ui-bzsz6.sprites.app", mark: "saved" };

async function settings() {
  const stored = await chrome.storage.sync.get(["baseUrl", "mark"]);
  return {
    baseUrl: stored.baseUrl || defaults.baseUrl,
    mark: stored.mark || defaults.mark,
  };
}

function flashBadge(tabId, text, color, ms) {
  void chrome.action.setBadgeBackgroundColor({ tabId, color });
  void chrome.action.setBadgeText({ tabId, text });
  if (ms !== undefined) {
    setTimeout(() => void chrome.action.setBadgeText({ tabId, text: "" }), ms);
  }
}

// Reads the page's own metadata; og: tags win over the bare <title>.
// Fails on pages scripts can't touch (Chrome's PDF viewer, chrome:// pages) —
// callers fall back to the tab's title.
async function pageMeta(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const meta = (name) => {
        const tag = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
        return tag === null || tag.content === "" ? null : tag.content;
      };
      return {
        title: meta("og:title") ?? document.title,
        description: meta("og:description") ?? meta("description"),
        siteName: meta("og:site_name"),
      };
    },
  });
  return injection.result;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined || !/^https?:/.test(tab.url ?? "")) {
    return;
  }
  const tabId = tab.id;
  const { baseUrl, mark } = await settings();
  flashBadge(tabId, "…", "#68726c");
  let meta = { title: tab.title ?? tab.url, description: null, siteName: null };
  try {
    meta = await pageMeta(tabId);
  } catch {
    // PDF viewer or restricted page: the tab title is all we get.
  }
  try {
    const response = await fetch(new URL("/api/capture", baseUrl), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: tab.url,
        title: meta.title ?? tab.title ?? tab.url,
        ...(meta.description ? { description: meta.description } : {}),
        ...(meta.siteName ? { siteName: meta.siteName } : {}),
        mark,
      }),
    });
    // An SSO redirect lands on an HTML sign-in page, not JSON: surface it as
    // "go sign in" rather than a silent failure.
    const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
    if (!isJson) {
      flashBadge(tabId, "!", "#b3261e", 4000);
      await chrome.tabs.create({ url: baseUrl });
      return;
    }
    const body = await response.json();
    if (!response.ok || body.error !== undefined) {
      console.error("capture failed:", body.error ?? response.status);
      flashBadge(tabId, "✗", "#b3261e", 4000);
      return;
    }
    flashBadge(tabId, "✓", "#24413b", 2500);
  } catch (error) {
    console.error("capture failed:", error);
    flashBadge(tabId, "✗", "#b3261e", 4000);
  }
});
