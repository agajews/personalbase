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
  marks: { saved: number; wantToRead: number };
  jobs: JobRow[];
  runs: RunRow[];
  tail: TailRow[];
}

export type Mark = "saved" | "want_to_read";

export interface MarkedItem {
  entityId: string;
  title: string | null;
  kind: string;
  mark: Mark;
  markedAt: string;
  arxivId: string | null;
  authors: string[];
}

/** A clickable reference to an entity. */
export interface EntityRef {
  entityId: string;
  name: string;
}

export interface Verdict {
  arxivId: string;
  entityId: string;
  mark: Mark | null;
  title: string;
  abstract: string;
  categories: string[];
  authors: EntityRef[];
  orgs: EntityRef[];
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
  entityId: string;
  mark: Mark | null;
  title: string;
  abstract: string;
  authors: EntityRef[];
  categories: string[];
  publishedAt: string;
  updatedAt: string;
  labs: EntityRef[];
  matches: { filter: string; confidence: number; reason: string }[];
}

export interface Feed {
  days: number;
  items: FeedItem[];
}

export interface EntityLink {
  linkType: string;
  assertedBy: string;
  confidence: number;
  other: { entityId: string; kind: string; displayName: string | null };
}

export interface EntityPage {
  entity: { entityId: string; kind: string; displayName: string | null };
  mark: Mark | null;
  identifiers: { scheme: string; value: string }[];
  linksOut: EntityLink[];
  linksIn: EntityLink[];
  paper: {
    arxiv_id: string;
    arxiv_version: number;
    title: string;
    abstract: string;
    authors: string[];
    categories: string[];
    published_at: string;
    updated_at: string;
    ingested_at: string;
  } | null;
  library: {
    paperpile_id: string;
    title: string;
    authors: string[];
    pubtype: string;
    year: number | null;
    arxiv_id: string | null;
    doi: string | null;
    url: string | null;
    journal: string | null;
    folders: string[] | null;
    added_at: string;
  } | null;
  verdicts: {
    filter_name: string;
    verdict: string;
    confidence: number;
    reason: string;
    current: boolean;
  }[];
}

export interface SearchResults {
  papers: { entityId: string; arxivId: string; title: string; abstract: string }[];
  other: { entityId: string; title: string; pubtype: string; arxivId: string | null }[];
  people: { entityId: string; displayName: string }[];
  orgs: { entityId: string; displayName: string }[];
}

export interface PaperListItem {
  arxivId: string;
  entityId: string;
  mark: Mark | null;
  title: string;
  abstract: string;
  categories: string[];
  authors: EntityRef[];
  orgs: EntityRef[];
  publishedAt: string;
  ingestedAt: string;
}

export interface PapersQuery {
  sort: "published" | "ingested" | "title";
  dir: "asc" | "desc";
  mark?: "saved" | "want_to_read" | "unmarked";
  q?: string;
  offset?: number;
}

export interface PapersPage {
  total: number;
  offset: number;
  items: PaperListItem[];
}

export interface TableList {
  tables: { name: string; rows: number }[];
}

export interface TablePage {
  name: string;
  columns: { name: string; type: string }[];
  sort: string;
  dir: "asc" | "desc";
  offset: number;
  total: number;
  rows: Record<string, unknown>[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error ?? `request failed: ${response.status}`);
  }
  return body as T;
}

function post(path: string, body: unknown): Promise<unknown> {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const api = {
  state: (): Promise<AppState> => request("/api/state"),
  feed: (days: number): Promise<Feed> => request(`/api/feed?days=${days}`),
  results: (name: string): Promise<Results> =>
    request(`/api/results/${encodeURIComponent(name)}`),
  entity: (id: string): Promise<EntityPage> =>
    request(`/api/entity/${encodeURIComponent(id)}`),
  search: (q: string): Promise<SearchResults> =>
    request(`/api/search?q=${encodeURIComponent(q)}`),
  papers: (query: PapersQuery): Promise<PapersPage> => {
    const params = new URLSearchParams({ sort: query.sort, dir: query.dir });
    if (query.mark !== undefined) params.set("mark", query.mark);
    if (query.q !== undefined && query.q !== "") params.set("q", query.q);
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    return request(`/api/papers?${params}`);
  },
  tables: (): Promise<TableList> => request("/api/tables"),
  table: (
    name: string,
    opts: { sort?: string; dir?: "asc" | "desc"; offset?: number },
  ): Promise<TablePage> => {
    const params = new URLSearchParams();
    if (opts.sort !== undefined) params.set("sort", opts.sort);
    if (opts.dir !== undefined) params.set("dir", opts.dir);
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    return request(`/api/tables/${encodeURIComponent(name)}?${params}`);
  },
  saveFilter: (body: { name: string; prompt: string; model: string }): Promise<unknown> =>
    post("/api/filters", body),
  runFilter: (name: string, days: number): Promise<unknown> =>
    post("/api/jobs/filter", { name, days }),
  ingest: (days: number, categories: string[]): Promise<unknown> =>
    post("/api/jobs/ingest", { days, categories }),
  ingestLabs: (): Promise<unknown> => post("/api/jobs/labs", {}),
  mark: (arxivId: string, mark: Mark | "none"): Promise<unknown> =>
    post("/api/mark", { arxivId, mark }),
  marked: (mark: Mark): Promise<{ mark: Mark; items: MarkedItem[] }> =>
    request(`/api/marked/${mark}`),
  devTasks: (): Promise<{ tasks: DevTaskListItem[] }> => request("/api/dev/tasks"),
  devTask: (uid: string): Promise<DevTaskPage> =>
    request(`/api/dev/tasks/${encodeURIComponent(uid)}`),
  devTranscript: (runUid: string, after: number): Promise<{ chunks: TranscriptChunk[] }> =>
    request(`/api/dev/runs/${encodeURIComponent(runUid)}/transcript?after=${after}`),
  createDevTask: (title: string, spec: string): Promise<unknown> =>
    post("/api/dev/tasks", { title, spec }),
  requestMerge: (taskUid: string, prNumber: number): Promise<unknown> =>
    post("/api/dev/merge", { taskUid, prNumber }),
};

export interface DevRunSummary {
  runUid: string;
  kind: "feature" | "merge";
  status: string;
  prNumber: number | null;
  prUrl: string | null;
  summary: string | null;
  error: string | null;
}

export interface DevTaskListItem {
  taskUid: string;
  title: string;
  status: string;
  createdAt: string;
  latestRun: DevRunSummary | null;
}

export interface DevRun {
  runUid: string;
  kind: "feature" | "merge";
  status: string;
  sandbox: string;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prTitle: string | null;
  mergedSha: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DevTaskPage {
  task: { taskUid: string; title: string; spec: string; status: string; createdAt: string };
  runs: DevRun[];
}

export interface TranscriptChunk {
  chunkSeq: number;
  content: string;
  at: string;
}

/** Must match promptHash() in userland/folds: sha256(model + "\n" + prompt), first 12 hex. */
export async function previewHash(model: string, prompt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${model}\n${prompt}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}
