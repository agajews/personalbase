import { z } from "zod";
import { makeRegistry, type SchemaRegistry } from "./registry.js";

// Payload schemas for every event type in the system, keyed by
// (type, schema_version). This module is the single source of truth;
// everything that produces or consumes events imports its types from here.

export const arxivPaperIngestedV1 = z.object({
  arxivId: z.string(), // canonical id without version suffix, e.g. "2508.12345"
  arxivVersion: z.number().int().min(1),
  title: z.string(),
  abstract: z.string(),
  authors: z.array(z.string()),
  categories: z.array(z.string()),
  publishedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type ArxivPaperIngested = z.infer<typeof arxivPaperIngestedV1>;

export const userFilterDefinedV1 = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
});
export type UserFilterDefined = z.infer<typeof userFilterDefinedV1>;

export const agentPaperFilteredV1 = z.object({
  filterName: z.string(),
  promptHash: z.string(), // identifies the exact prompt version that judged
  arxivId: z.string(),
  verdict: z.enum(["match", "reject"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type AgentPaperFiltered = z.infer<typeof agentPaperFilteredV1>;

/** A reference to an entity by kind + stable external ref; folds mint the id. */
function entityRefSchema() {
  return z.object({
    kind: z.string().min(1), // 'paper' | 'person' | 'org' | ...
    ref: z.string().min(1),  // e.g. 'arxiv:2508.12345', 'anthropic'
  });
}
const entityRef = entityRefSchema().extend({
  displayName: z.string().optional(),
});

export const agentLinkAssertedV1 = z.object({
  from: entityRef,
  to: entityRef,
  linkType: z.string().min(1), // 'published_by' | 'affiliated_with' | ...
  confidence: z.number().min(0).max(1),
  evidence: z.unknown().optional(),
});
export type AgentLinkAsserted = z.infer<typeof agentLinkAssertedV1>;

export const agentPaperAffiliationsExtractedV1 = z.object({
  arxivId: z.string(),
  authors: z.array(
    z.object({
      name: z.string().min(1),
      affiliations: z.array(
        z.object({
          raw: z.string(),            // as printed on the paper
          org: z.string().min(1),     // canonical lowercase slug, e.g. 'deepmind'
        }),
      ),
      email: z.string().optional(),
    }),
  ),
});
export type AgentPaperAffiliationsExtracted = z.infer<
  typeof agentPaperAffiliationsExtractedV1
>;

export const paperpileItemImportedV1 = z.object({
  paperpileId: z.string().min(1),
  pubtype: z.string(),          // PP_PREPRINT | PP_ARTICLE | PP_WEBSITE | ...
  title: z.string().min(1),
  authors: z.array(z.string()),
  year: z.number().int().optional(),
  abstract: z.string().optional(),
  arxivId: z.string().optional(),
  doi: z.string().optional(),
  url: z.string().optional(),
  journal: z.string().optional(),
  folders: z.array(z.string()).optional(),
  /** When the item was added to the library (Paperpile's created time). */
  addedAt: z.iso.datetime({ offset: true }),
});
export type PaperpileItemImported = z.infer<typeof paperpileItemImportedV1>;

export const userPaperMarkedV1 = z.object({
  arxivId: z.string().min(1),
  /** Tiers: none < saved < want_to_read. Latest event per paper wins. */
  mark: z.enum(["saved", "want_to_read", "none"]),
});

/** v2 marks any entity (papers, library resources) by its graph ref. */
export const userPaperMarkedV2 = z.object({
  target: entityRefSchema(),
  mark: z.enum(["saved", "want_to_read", "none"]),
});
export type UserPaperMarked = z.infer<typeof userPaperMarkedV2>;

function upcastMarkedV1(previous: unknown): unknown {
  const v1 = userPaperMarkedV1.parse(previous);
  // Same normalization as paperRef in the graph fold: identity is unversioned.
  return {
    target: { kind: "paper", ref: `arxiv:${v1.arxivId.replace(/v\d+$/, "")}` },
    mark: v1.mark,
  };
}

// ---- dev agents (background agents modifying this system's own code) ----

export const userDevtaskCreatedV1 = z.object({
  /** The full prompt handed to the coding agent; the title is generated. */
  spec: z.string().min(1),
});
export type UserDevtaskCreated = z.infer<typeof userDevtaskCreatedV1>;

/** Emitted by the dev-agent at launch: an LLM-written title for the task. */
export const devTaskTitledV1 = z.object({
  taskUid: z.uuid(),
  title: z.string().min(1).max(200),
});
export type DevTaskTitled = z.infer<typeof devTaskTitledV1>;

/** A follow-up/clarification typed at a task's agent while it works. */
export const userDevmessageSentV1 = z.object({
  taskUid: z.uuid(),
  message: z.string().min(1),
});
export type UserDevmessageSent = z.infer<typeof userDevmessageSentV1>;

export const devRunStartedV1 = z.object({
  /** event_uid of the user.devtask.created event this run works on. */
  taskUid: z.uuid(),
  runUid: z.uuid(),
  kind: z.enum(["feature", "merge"]),
  /** Sandbox (Fly Sprite) name the run executes in. */
  sandbox: z.string().min(1),
  /** Feature runs work on a branch; merge runs operate on a PR. */
  branch: z.string().nullable(),
});
export type DevRunStarted = z.infer<typeof devRunStartedV1>;

export const devTranscriptAppendedV1 = z.object({
  taskUid: z.uuid(),
  runUid: z.uuid(),
  /** Dense from 0 per run; idempotency key dev:<runUid>:chunk:<chunkSeq>. */
  chunkSeq: z.number().int().nonnegative(),
  /** Raw log bytes: setup lines + Claude Code stream-json lines, interleaved. */
  content: z.string(),
});
export type DevTranscriptAppended = z.infer<typeof devTranscriptAppendedV1>;

export const devPrOpenedV1 = z.object({
  taskUid: z.uuid(),
  runUid: z.uuid(),
  prNumber: z.number().int().positive(),
  prUrl: z.string().min(1),
  branch: z.string().min(1),
  title: z.string(),
});
export type DevPrOpened = z.infer<typeof devPrOpenedV1>;

export const userDevmergeRequestedV1 = z.object({
  taskUid: z.uuid(),
  prNumber: z.number().int().positive(),
});
export type UserDevmergeRequested = z.infer<typeof userDevmergeRequestedV1>;

export const devPrMergedV1 = z.object({
  taskUid: z.uuid(),
  runUid: z.uuid(),
  prNumber: z.number().int().positive(),
  mergedSha: z.string().min(1),
});
export type DevPrMerged = z.infer<typeof devPrMergedV1>;

export const devRunFinishedV1 = z.object({
  taskUid: z.uuid(),
  runUid: z.uuid(),
  status: z.enum(["succeeded", "failed"]),
  summary: z.string().nullable(),
  error: z.string().nullable(),
});
export type DevRunFinished = z.infer<typeof devRunFinishedV1>;
export const agentTaxonomyProposedV1 = z.object({
  /** Identifies this scheme version (hash of its categories). */
  schemeId: z.string().min(1),
  categories: z.array(
    z.object({
      slug: z.string().min(1), // kebab-case, stable within a scheme
      name: z.string().min(1),
      description: z.string(),
    }),
  ),
});
export type AgentTaxonomyProposed = z.infer<typeof agentTaxonomyProposedV1>;

// ---- operator chat: conversations are events like everything else ----

export const userChatMessageSentV1 = z.object({
  chatUid: z.uuid(), // client-minted conversation id
  text: z.string().min(1),
});
export type UserChatMessageSent = z.infer<typeof userChatMessageSentV1>;

export const agentChatRepliedV1 = z.object({
  chatUid: z.uuid(),
  /** The assistant's visible reply (markdown). */
  reply: z.string(),
  trace: z.array(
    z.object({ tool: z.string(), summary: z.string(), isError: z.boolean() }),
  ),
  /**
   * The raw API messages this turn appended after the user message
   * (assistant content blocks and tool-result messages), so the
   * conversation can be resumed with full tool-context fidelity.
   */
  apiMessages: z.array(z.unknown()),
});
export type AgentChatReplied = z.infer<typeof agentChatRepliedV1>;

export const coreRegistry: SchemaRegistry = makeRegistry([
  { type: "arxiv.paper.ingested", versions: [{ schema: arxivPaperIngestedV1 }] },
  { type: "user.filter.defined", versions: [{ schema: userFilterDefinedV1 }] },
  { type: "agent.paper.filtered", versions: [{ schema: agentPaperFilteredV1 }] },
  { type: "agent.link.asserted", versions: [{ schema: agentLinkAssertedV1 }] },
  {
    type: "agent.paper.affiliations_extracted",
    versions: [{ schema: agentPaperAffiliationsExtractedV1 }],
  },
  { type: "paperpile.item.imported", versions: [{ schema: paperpileItemImportedV1 }] },
  {
    type: "user.paper.marked",
    versions: [
      { schema: userPaperMarkedV1 },
      { schema: userPaperMarkedV2, upcast: upcastMarkedV1 },
    ],
  },
  { type: "user.devtask.created", versions: [{ schema: userDevtaskCreatedV1 }] },
  { type: "dev.task.titled", versions: [{ schema: devTaskTitledV1 }] },
  { type: "user.devmessage.sent", versions: [{ schema: userDevmessageSentV1 }] },
  { type: "dev.run.started", versions: [{ schema: devRunStartedV1 }] },
  { type: "dev.transcript.appended", versions: [{ schema: devTranscriptAppendedV1 }] },
  { type: "dev.pr.opened", versions: [{ schema: devPrOpenedV1 }] },
  { type: "user.devmerge.requested", versions: [{ schema: userDevmergeRequestedV1 }] },
  { type: "dev.pr.merged", versions: [{ schema: devPrMergedV1 }] },
  { type: "dev.run.finished", versions: [{ schema: devRunFinishedV1 }] },
  { type: "agent.taxonomy.proposed", versions: [{ schema: agentTaxonomyProposedV1 }] },
  { type: "user.chat.message_sent", versions: [{ schema: userChatMessageSentV1 }] },
  { type: "agent.chat.replied", versions: [{ schema: agentChatRepliedV1 }] },
]);
