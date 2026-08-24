import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { coreRegistry } from "@nc/schema";
import { appendEvents, type Sql } from "@nc/log";
import { catchUpFolds, enqueueJob } from "@nc/process";
import { chatsFold } from "@nc/folds";

// The chat surface: Opus with the database as its hands. Reads are arbitrary
// read-only SQL; actions are appended events (validated against the schema
// registry) and enqueued jobs (executed by the worker daemon). Everything it
// does is recorded with source agent:chat — the chat has agency only through
// the same bus as every other process.

const maxIterations = 15;
const maxResultChars = 20_000;
const maxResultRows = 50;

// Reactors the chat may enqueue jobs for, with payload documentation. Kept
// here (not imported from the worker registry) so the prompt and validation
// stay in one place.
const reactorCatalog = `
- reactor:arxiv — ingest papers from arXiv.
    payload: {ids?: string[]} to ingest specific papers (bare ids like "2508.12345"),
    or {from?, to?, categories?: string[]} for a submission-date sweep
    (defaults: trailing 3 days; omitted categories means ALL of arXiv — avoid).
- reactor:paper-filter — LLM-judge ingested papers against saved filters.
    payload: {from?, to?, filter?: string} (defaults: trailing 3 days, all filters).
- reactor:lab-publications — read OpenAI/DeepMind/Anthropic/Meta publication pages.
    payload: {lab?: "openai"|"deepmind"|"anthropic"|"meta"} (omit for all).
- reactor:taxonomy — classify saved items into the topic scheme.
    payload: {regenerate?: boolean} (regenerate discards and re-derives the scheme).
- reactor:library-arxiv-backfill — fetch arXiv metadata for library items missing it.
    payload: {}
`.trim();

const allowedProcesses = new Set([
  "reactor:arxiv",
  "reactor:paper-filter",
  "reactor:lab-publications",
  "reactor:taxonomy",
  "reactor:library-arxiv-backfill",
]);

function eventTypeDocs(): string {
  const lines: string[] = [];
  for (const [type, def] of coreRegistry) {
    const latest = def.versions[def.versions.length - 1]!;
    const jsonSchema = z.toJSONSchema(latest.schema as z.ZodType);
    lines.push(
      `- ${type} (schemaVersion ${def.versions.length}): ${JSON.stringify(jsonSchema)}`,
    );
  }
  return lines.join("\n");
}

function systemPrompt(): string {
  return `You are the operator console of "personalbase", Alex's personal
research database: an event-sourced system where an append-only "events"
table is the sole source of truth and every current-state table is a
rebuildable fold over it. You act ONLY through your tools; report plainly
what you did.

## Reading (query tool — read-only SQL, Postgres)
Key fold tables:
- papers(entity_id, arxiv_id, arxiv_version, title, abstract, authors jsonb,
  categories jsonb, published_at, updated_at, ingested_at)
- library_items(paperpile_id, entity_id, title, abstract, authors, pubtype,
  year, arxiv_id, doi, url, journal, folders, added_at) — Alex's imported library
- entities(entity_id, kind, ref, canonical_id, display_name) — kinds: paper,
  resource, person, org, topic; entity_id is deterministic uuidv5(kind, ref)
- links(from_id, to_id, link_type, asserted_by, confidence, evidence jsonb) —
  authored, affiliated_with, affiliated_org, published_by, classified_as
- identifiers(scheme, value, entity_id) — email, doi, arxiv_id
- paper_marks(entity_id, mark, marked_at) — mark: saved | want_to_read
- filters(name, prompt, model, prompt_hash); filter_results(filter_name,
  prompt_hash, arxiv_id, verdict, confidence, reason)
- taxonomy_categories(slug, name, description, scheme_id); assignments are
  classified_as links to topic entities with ref 'taxonomy:<slug>'
- dev_tasks / dev_runs / dev_transcript_chunks — background coding agents
- events (the log), jobs, runs, checkpoints — inspectable like everything else
Full-text search: to_tsvector('english', title || ' ' || abstract) @@
websearch_to_tsquery('english', $query), or ilike for names. Query
information_schema when unsure of a column.

## Acting
1. append_events — append validated events to the log. Common intents:
   - Save / shortlist a paper: user.paper.marked v2
     {target: {kind: "paper"|"resource", ref: <entities.ref>}, mark:
     "saved"|"want_to_read"|"none"} — look the ref up in entities first.
   - Define or edit a filter: user.filter.defined v1 {name, prompt, model}.
   - Start a background CODING agent that modifies this system itself:
     user.devtask.created v1 {title?, spec} — the dev pipeline picks it up,
     works in a sandbox, and opens a PR for approval. Use for "build/change a
     feature" requests. The spec MUST carry Alex's instruction verbatim: quote
     their words exactly as written, unparaphrased and unabridged. If context
     you gathered would help (file paths, entity refs, findings from your
     queries), append it AFTER the quoted instruction under a clearly separate
     "Context from the operator console:" section — never blend it into or
     rewrite the instruction itself.
   Emit user.* events for Alex's intents. Do not fabricate agent.* or dev.*
   facts — those belong to their own reactors.
   Event payload schemas (latest versions):
${eventTypeDocs()}

2. enqueue_job — start a background task agent; the always-on worker picks it
   up within seconds and its progress is visible in the runs table and UI.
${reactorCatalog}

## Conduct
- Read before you write; verify refs/ids by querying rather than guessing.
- When handing Alex's instructions to any other agent (dev tasks, filter
  prompts they dictate, follow-up messages), forward their words in as
  unedited a form as possible. Your reformulations lose intent the original
  preserves; the receiving agent is capable of reading Alex directly.
- Take the requested actions directly, then state exactly what you did
  (events appended, jobs enqueued) and how to watch progress. If a request is
  genuinely ambiguous, ask instead of acting.
- Results are truncated at ${maxResultRows} rows — use LIMIT, ORDER BY, and
  count(*) deliberately.`;
}

const queryInput = z.object({ sql: z.string().min(1) });
const appendInput = z.object({
  events: z
    .array(
      z.object({
        type: z.string().min(1),
        schemaVersion: z.number().int().min(1),
        payload: z.unknown(),
        idempotencyKey: z.string().optional(),
      }),
    )
    .min(1),
});
const enqueueInput = z.object({
  process: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

const tools: Anthropic.Tool[] = [
  {
    name: "query",
    description:
      "Run read-only SQL against the database. Returns rows as JSON " +
      `(truncated to ${maxResultRows} rows).`,
    input_schema: {
      type: "object" as const,
      properties: { sql: { type: "string" } },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "append_events",
    description:
      "Append events to the log (the only way state changes). Payloads are " +
      "validated against the schema registry; invalid events are rejected " +
      "with the validation error.",
    input_schema: {
      type: "object" as const,
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              schemaVersion: { type: "integer" },
              payload: {},
              idempotencyKey: { type: "string" },
            },
            required: ["type", "schemaVersion", "payload"],
            additionalProperties: false,
          },
        },
      },
      required: ["events"],
      additionalProperties: false,
    },
  },
  {
    name: "enqueue_job",
    description:
      "Enqueue a background job for a reactor; the worker daemon executes it.",
    input_schema: {
      type: "object" as const,
      properties: {
        process: { type: "string" },
        payload: { type: "object" },
      },
      required: ["process"],
      additionalProperties: false,
    },
  },
];

export interface ChatTraceItem {
  tool: string;
  summary: string;
  isError: boolean;
}

function stringifyRows(rows: unknown[]): string {
  const shown = rows.slice(0, maxResultRows);
  const text = JSON.stringify(
    { rowCount: rows.length, truncated: rows.length > maxResultRows, rows: shown },
    (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
  );
  return text.length > maxResultChars ? text.slice(0, maxResultChars) + "…(truncated)" : text;
}

async function execTool(
  sql: Sql,
  name: string,
  input: unknown,
): Promise<{ content: string; isError: boolean; summary: string }> {
  try {
    if (name === "query") {
      const { sql: q } = queryInput.parse(input);
      const rows = await sql.begin("read only", (tx) => tx.unsafe(q));
      return {
        content: stringifyRows(rows as unknown[]),
        isError: false,
        summary: `query (${(rows as unknown[]).length} rows): ${q.replace(/\s+/g, " ").slice(0, 120)}`,
      };
    }
    if (name === "append_events") {
      const { events } = appendInput.parse(input);
      const appended = await appendEvents(
        sql,
        coreRegistry,
        events.map((e) => ({
          type: e.type,
          schemaVersion: e.schemaVersion,
          source: "agent:chat",
          occurredAt: new Date().toISOString(),
          payload: e.payload,
          ...(e.idempotencyKey === undefined ? {} : { idempotencyKey: e.idempotencyKey }),
        })),
      );
      return {
        content: JSON.stringify({ appended, deduplicated: events.length - appended }),
        isError: false,
        summary: `append_events: ${events.map((e) => e.type).join(", ")} (${appended} new)`,
      };
    }
    if (name === "enqueue_job") {
      const { process, payload } = enqueueInput.parse(input);
      if (!allowedProcesses.has(process)) {
        throw new Error(
          `unknown process ${process}; known: ${[...allowedProcesses].join(", ")}`,
        );
      }
      const jobId = await enqueueJob(sql, process, payload);
      return {
        content: JSON.stringify({ jobId }),
        isError: false,
        summary: `enqueue_job: ${process} ${JSON.stringify(payload)}`,
      };
    }
    throw new Error(`unknown tool ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: `Error: ${message}`, isError: true, summary: `${name} failed: ${message}` };
  }
}

let client: Anthropic | undefined;
const cachedSystem = systemPrompt();

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; item: ChatTraceItem }
  | { type: "done"; reply: string }
  | { type: "error"; message: string };

/** Rebuilds the API transcript for a conversation from the chats fold. */
async function loadTranscript(sql: Sql, chatUid: string): Promise<Anthropic.MessageParam[]> {
  const turns = await sql`
    select role, text, api_messages from chat_turns
    where chat_uid = ${chatUid} order by event_seq`;
  const messages: Anthropic.MessageParam[] = [];
  for (const turn of turns) {
    if (turn["role"] === "user") {
      messages.push({ role: "user", content: turn["text"] });
    } else {
      messages.push(...((turn["api_messages"] ?? []) as Anthropic.MessageParam[]));
    }
  }
  return messages;
}

/**
 * One chat turn: appends the user message to the log, streams the model's
 * work (text deltas + tool activity), and appends the reply — the
 * conversation itself is events, folded like everything else.
 */
export async function streamChat(
  sql: Sql,
  chatUid: string,
  userText: string,
  rawEmit: (event: ChatStreamEvent) => Promise<void>,
): Promise<void> {
  client ??= new Anthropic();
  // Serialize SSE writes: text deltas arrive on synchronous SDK events, and
  // unawaited concurrent writes can interleave frame bytes on the wire.
  let chain = Promise.resolve();
  const emit = (event: ChatStreamEvent): Promise<void> => {
    chain = chain.then(() => rawEmit(event));
    return chain;
  };
  // Load prior turns BEFORE appending this message, so a fast worker fold
  // can't make the new message show up twice.
  const prior = await loadTranscript(sql, chatUid);
  await appendEvents(sql, coreRegistry, [
    {
      type: "user.chat.message_sent",
      schemaVersion: 1,
      source: "ui:web",
      occurredAt: new Date().toISOString(),
      payload: { chatUid, text: userText },
    },
  ]);

  const messages: Anthropic.MessageParam[] = [...prior, { role: "user", content: userText }];
  const newMessages: Anthropic.MessageParam[] = [];
  const trace: ChatTraceItem[] = [];
  let reply = "";
  for (let i = 0; i < maxIterations; i++) {
    const stream = client.messages.stream({
      model: "claude-opus-5",
      max_tokens: 16000,
      system: [{ type: "text", text: cachedSystem, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });
    stream.on("text", (delta) => {
      void emit({ type: "delta", text: delta });
    });
    const response = await stream.finalMessage();
    const assistantTurn: Anthropic.MessageParam = { role: "assistant", content: response.content };
    messages.push(assistantTurn);
    newMessages.push(assistantTurn);
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text !== "") {
      reply = reply === "" ? text : `${reply}\n\n${text}`;
    }
    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) {
      break;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const result = await execTool(sql, toolUse.name, toolUse.input);
      const item = { tool: toolUse.name, summary: result.summary, isError: result.isError };
      trace.push(item);
      await emit({ type: "tool", item });
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      });
    }
    const resultTurn: Anthropic.MessageParam = { role: "user", content: results };
    messages.push(resultTurn);
    newMessages.push(resultTurn);
    if (i === maxIterations - 1) {
      reply += "\n\n(stopped after too many tool iterations)";
    }
  }
  await appendEvents(sql, coreRegistry, [
    {
      type: "agent.chat.replied",
      schemaVersion: 1,
      source: "agent:chat",
      occurredAt: new Date().toISOString(),
      payload: { chatUid, reply, trace, apiMessages: newMessages },
    },
  ]);
  await catchUpFolds(sql, coreRegistry, [chatsFold]);
  await emit({ type: "done", reply });
  await chain;
}
