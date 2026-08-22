export interface FilterSummary {
  name: string;
  model: string;
  prompt: string;
  promptHash: string;
  matches: number;
  rejects: number;
}

export interface JobRow {
  job_id: string;
  process: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  run_after: string;
}

export interface RunRow {
  process: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  emitted_count: number | null;
  tokens_in: string | null;
  tokens_out: string | null;
  error: string | null;
}

export interface TailRow {
  seq: string;
  type: string;
  source: string;
  occurred_at: string;
}

export interface AppState {
  filters: FilterSummary[];
  papers: { total: number; latest: string | null };
  jobs: JobRow[];
  runs: RunRow[];
  tail: TailRow[];
}

export interface Verdict {
  arxivId: string;
  title: string;
  abstract: string;
  categories: string[];
  authors: string[];
  orgs: string[];
  confidence: number;
  reason: string;
  updatedAt: string;
}

export interface Results {
  promptHash: string;
  matches: Verdict[];
  rejects: Verdict[];
}

export interface FeedItem {
  arxivId: string;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  publishedAt: string;
  updatedAt: string;
  labs: string[];
  matches: { filter: string; confidence: number; reason: string }[];
}

export interface Feed {
  days: number;
  items: FeedItem[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? `request failed: ${response.status}`);
  }
  return body as T;
}

export const api = {
  state: (): Promise<AppState> => request("/api/state"),
  feed: (days: number): Promise<Feed> => request(`/api/feed?days=${days}`),
  results: (name: string): Promise<Results> =>
    request(`/api/results/${encodeURIComponent(name)}`),
  saveFilter: (body: { name: string; prompt: string; model: string }): Promise<void> =>
    request("/api/filters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  runFilter: (name: string, days: number): Promise<{ jobId: string }> =>
    request("/api/jobs/filter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, days }),
    }),
  ingest: (days: number, categories: string[]): Promise<{ jobId: string }> =>
    request("/api/jobs/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days, categories }),
    }),
  ingestLabs: (): Promise<{ jobId: string }> =>
    request("/api/jobs/labs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
};

/** Must match promptHash() in userland/folds: sha256(model + "\n" + prompt), first 12 hex. */
export async function previewHash(model: string, prompt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${model}\n${prompt}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}
