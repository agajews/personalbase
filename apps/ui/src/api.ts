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
  /** The ref the entity id was minted from ('url:…', 'arxiv:…'). */
  ref: string;
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
  /** Hash of the prompt version that produced this verdict. */
  promptHash: string;
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
  /** Arrival in our log — tracks arXiv's announcement day; feed groups by this. */
  ingestedAt: string;
  labs: EntityRef[];
  matches: { filter: string; promptHash: string; confidence: number; reason: string }[];
}

export interface Feed {
  days: number;
  items: FeedItem[];
  /** Saved items in the library the daily samples draw from. */
  savedTotal: number;
  /** Per-day resurfacing history within the window, newest day first. */
  resurfaced: ResurfacedDay[];
  /** Daily study questions within the window, newest day first. */
  questions: StudyQuestion[];
}

/** One day's spaced-repetition exercise; questionUid is its chat's uid. */
export interface StudyQuestion {
  questionUid: string;
  day: string;
  topic: string;
  level: number;
  question: string;
  notes: string;
  /** Turns in the solution-discussion chat; 0 means not started. */
  turns: number;
}

/** One item from a day's recorded resurfacing over the saved library. */
export interface ResurfacedItem {
  entityId: string;
  kind: string;
  title: string;
  abstract: string | null;
  authors: EntityRef[];
  categories: string[];
  arxivId: string | null;
  journal: string | null;
  year: number | null;
  markedAt: string | null;
  mark: Mark | null;
}

export interface ResurfacedDay {
  day: string;
  items: ResurfacedItem[];
}

export interface EntityLink {
  linkType: string;
  assertedBy: string;
  confidence: number;
  other: { entityId: string; kind: string; displayName: string | null };
}

export interface ItemTag {
  slug: string;
  name: string;
  facet: string;
  /** How central the tag is to the item, in [0, 1]. */
  strength: number;
}

/** The tags carried by the papers around an entity — a lab's subject matter. */
export interface EntityTagGroup {
  slug: string;
  name: string;
  facet: string;
  papers: { entityId: string; title: string | null; strength: number; mark: Mark | null }[];
}

/** What a pasted link turns into: the entity now, its title once fetched. */
export interface SubmittedLink {
  url: string;
  entityId: string;
  kind: string;
  title: string | null;
}

export interface EntityPage {
  entity: { entityId: string; kind: string; ref: string; displayName: string | null };
  mark: Mark | null;
  tags: ItemTag[];
  tagGroups: EntityTagGroup[];
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
  category?: string;
  q?: string;
  offset?: number;
}

export interface PapersPage {
  total: number;
  offset: number;
  items: PaperListItem[];
}

export interface TopicGroup {
  slug: string;
  name: string;
  description: string;
  items: number;
}

export interface TopicItems {
  slug: string;
  name: string;
  description: string;
  items: {
    entityId: string;
    kind: string;
    title: string | null;
    arxivId: string | null;
    mark: Mark | null;
    confidence: number;
  }[];
}

export interface TagSummary {
  slug: string;
  name: string;
  description: string;
  facet: string;
  items: number;
}

/**
 * What the graph is drawn over. Tags, authors and affiliations are the same
 * shape — things saved papers belong to — so one view serves all three.
 */
export type GraphMode = "tags" | "authors" | "orgs";

export const graphModeLabels: Record<GraphMode, string> = {
  tags: "tags",
  authors: "authors",
  orgs: "affiliations",
};

/** For the search box: "Find a tag", "Find an affiliation". */
export const graphModeNoun: Record<GraphMode, string> = {
  tags: "a tag",
  authors: "an author",
  orgs: "an affiliation",
};

export interface EntityGraph {
  mode: GraphMode;
  minShared: number;
  minItems: number;
  nodes: { key: string; name: string; facet: string; items: number; weight: number }[];
  /** `shared` counts the papers; `weight` sums how strongly they belong to both. */
  edges: { source: string; target: string; shared: number; weight: number }[];
}

export interface GraphPaper {
  entityId: string;
  kind: string;
  title: string;
  /** [key, strength] pairs, strongest first. */
  tags: [string, number][];
}

export interface GraphNodePage {
  mode: GraphMode;
  key: string;
  name: string;
  facet: string;
  description: string;
  /** Set when the node is a real entity with a page of its own. */
  entityId: string | null;
  related: { key: string; name: string; shared: number }[];
  papers: {
    entityId: string;
    kind: string;
    title: string | null;
    arxivId: string | null;
    mark: Mark | null;
    strength: number;
  }[];
}

export interface ChatTraceItem {
  tool: string;
  summary: string;
  isError: boolean;
}

export interface ChatSummary {
  chatUid: string;
  title: string;
  lastAt: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  trace: ChatTraceItem[];
}

/** The study question a chat belongs to, when it is a solution discussion. */
export interface ChatQuestion {
  day: string;
  topic: string;
  level: number;
  question: string;
  notes: string;
}

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; item: ChatTraceItem }
  | { type: "done"; reply: string }
  | { type: "error"; message: string };

/** POSTs a chat turn and yields SSE events as they arrive. */
export async function* streamChatTurn(
  chatUid: string,
  message: string,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatUid, message }),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`chat request failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          yield JSON.parse(line.slice(6)) as ChatStreamEvent;
        }
      }
    }
  }
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
    if (query.category !== undefined && query.category !== "") {
      params.set("category", query.category);
    }
    if (query.q !== undefined && query.q !== "") params.set("q", query.q);
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    return request(`/api/papers?${params}`);
  },
  categories: (): Promise<{ categories: { name: string; papers: number }[] }> =>
    request("/api/categories"),
  topics: (): Promise<{ schemeId: string | null; groups: TopicGroup[] }> =>
    request("/api/topics"),
  topicItems: (slug: string): Promise<TopicItems> =>
    request(`/api/topics/${encodeURIComponent(slug)}`),
  classify: (regenerate: boolean): Promise<{ jobId: string }> =>
    post("/api/jobs/classify", { regenerate }) as Promise<{ jobId: string }>,
  tags: (): Promise<{ vocabId: string | null; tagged: number; tags: TagSummary[] }> =>
    request("/api/tags"),
  graph: (mode: GraphMode, minShared: number, minItems: number): Promise<EntityGraph> =>
    request(`/api/graph/${mode}?minShared=${minShared}&minItems=${minItems}`),
  graphPapers: (mode: GraphMode, minItems: number): Promise<{ papers: GraphPaper[] }> =>
    request(`/api/graph/${mode}/papers?minItems=${minItems}`),
  graphNode: (mode: GraphMode, key: string): Promise<GraphNodePage> =>
    request(`/api/graph/${mode}/node/${encodeURIComponent(key)}`),
  runTagger: (regenerate: boolean): Promise<{ jobId: string }> =>
    post("/api/jobs/tag", { regenerate }) as Promise<{ jobId: string }>,
  chats: (): Promise<{ chats: ChatSummary[] }> => request("/api/chats"),
  chatTurns: (chatUid: string): Promise<{ turns: ChatTurn[]; question: ChatQuestion | null }> =>
    request(`/api/chats/${encodeURIComponent(chatUid)}`),
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
  mark: (entityId: string, mark: Mark | "none"): Promise<unknown> =>
    post("/api/mark", { entityId, mark }),
  submitLink: (url: string): Promise<SubmittedLink> =>
    post("/api/links", { url }) as Promise<SubmittedLink>,
  marked: (mark: Mark): Promise<{ mark: Mark; items: MarkedItem[] }> =>
    request(`/api/marked/${mark}`),
  devTasks: (): Promise<{ tasks: DevTaskListItem[] }> => request("/api/dev/tasks"),
  devTask: (uid: string): Promise<DevTaskPage> =>
    request(`/api/dev/tasks/${encodeURIComponent(uid)}`),
  devTranscript: (runUid: string, after: number): Promise<{ chunks: TranscriptChunk[] }> =>
    request(`/api/dev/runs/${encodeURIComponent(runUid)}/transcript?after=${after}`),
  createDevTask: (spec: string): Promise<{ taskUid: string }> =>
    post("/api/dev/tasks", { spec }) as Promise<{ taskUid: string }>,
  requestMerge: (taskUid: string, prNumber: number): Promise<unknown> =>
    post("/api/dev/merge", { taskUid, prNumber }),
  sendDevMessage: (taskUid: string, message: string, interrupt = false): Promise<unknown> =>
    post("/api/dev/message", { taskUid, message, interrupt }),
  archiveDevTask: (taskUid: string): Promise<unknown> =>
    post("/api/dev/archive", { taskUid }),
};

export interface DevRunSummary {
  runUid: string;
  kind: "feature" | "merge";
  status: string;
  prNumber: number | null;
  prUrl: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DevTaskListItem {
  taskUid: string;
  title: string;
  status: string;
  previewUrl: string | null;
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

export interface DevMessage {
  msgUid: string;
  message: string;
  at: string;
}

export interface DevTaskPage {
  task: {
    taskUid: string;
    title: string;
    spec: string;
    status: string;
    previewUrl: string | null;
    createdAt: string;
  };
  messages: DevMessage[];
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
