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

/**
 * A page saved from the browser (the capture extension). arXiv URLs never
 * take this path — they go through the arxiv reactor so papers carry the
 * same canonical metadata as the daily sweep. `url` is normalized by the
 * capture endpoint (no fragment, no tracking params).
 */
export const userResourceCapturedV1 = z.object({
  url: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  siteName: z.string().optional(),
});
export type UserResourceCaptured = z.infer<typeof userResourceCapturedV1>;

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
  /** Stop the agent's current turn first instead of queueing behind it. */
  interrupt: z.boolean().default(false),
});
export type UserDevmessageSent = z.infer<typeof userDevmessageSentV1>;

/** Retire a task: stop any running turn, destroy its sandbox, hide it. */
export const userDevtaskArchivedV1 = z.object({
  taskUid: z.uuid(),
});
export type UserDevtaskArchived = z.infer<typeof userDevtaskArchivedV1>;

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

/** The agent started a live dev-server preview in its sandbox. */
export const devPreviewStartedV1 = z.object({
  taskUid: z.uuid(),
  runUid: z.uuid(),
  /** The sandbox's SSO-gated URL (sprite auth; org members only). */
  url: z.string().min(1),
});
export type DevPreviewStarted = z.infer<typeof devPreviewStartedV1>;

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

/**
 * The agent itself asks for the merge (on the user's in-conversation
 * instruction, via nc-request-merge). Same merge lane, same safeguards —
 * only the requester differs.
 */
export const agentDevmergeRequestedV1 = z.object({
  taskUid: z.uuid(),
  prNumber: z.number().int().positive(),
});
export type AgentDevmergeRequested = z.infer<typeof agentDevmergeRequestedV1>;

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

// ---- granular topic tags over the saved library ----

/**
 * The tag vocabulary the tagger invents for this collection: many small,
 * specific tags rather than the taxonomy's handful of broad groups. Each
 * proposal replaces the vocabulary wholesale; `vocabId` hashes its contents,
 * so assignments can name the vocabulary they were made under.
 */
export const agentTagVocabProposedV1 = z.object({
  vocabId: z.string().min(1),
  tags: z.array(
    z.object({
      slug: z.string().min(1), // kebab-case, stable within a vocabulary
      name: z.string().min(1),
      description: z.string(),
      /** Broad facet the tag sits in ('method', 'task', …), for grouping. */
      facet: z.string().min(1),
    }),
  ),
});
export type AgentTagVocabProposed = z.infer<typeof agentTagVocabProposedV1>;

/**
 * Every tag one saved item earned, as a single fact per item — many tags per
 * paper is the point, so the assignment, not the individual tag, is the event.
 */
export const agentItemTaggedV1 = z.object({
  vocabId: z.string().min(1),
  target: entityRefSchema(),
  tags: z.array(
    z.object({
      slug: z.string().min(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

/**
 * v2 makes membership continuous: `strength` is how central the tag is to the
 * work, not how sure the model is that it applies at all. A paper is a strong
 * match for one or two tags and a weak match for several more.
 */
export const agentItemTaggedV2 = z.object({
  vocabId: z.string().min(1),
  target: entityRefSchema(),
  tags: z.array(
    z.object({
      slug: z.string().min(1),
      strength: z.number().min(0).max(1),
    }),
  ),
});
export type AgentItemTagged = z.infer<typeof agentItemTaggedV2>;

function upcastItemTaggedV1(previous: unknown): unknown {
  const v1 = agentItemTaggedV1.parse(previous);
  // v1 confidence was derived from the order the model listed slugs in, which
  // is exactly the ranking `strength` now carries explicitly.
  return {
    vocabId: v1.vocabId,
    target: v1.target,
    tags: v1.tags.map((t) => ({ slug: t.slug, strength: t.confidence })),
  };
}

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

/**
 * The day's resurfacing: which saved items were brought back for another
 * look. A fact, not a recomputation — the timeline shows what was actually
 * surfaced each day, and future surfaced kinds (repetition cards, memos,
 * reading blocks) ride the same rails.
 */
export const surfaceDayResurfacedV1 = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z
    .array(z.object({ kind: z.string().min(1), ref: z.string().min(1) }))
    .min(1),
});
export type SurfaceDayResurfaced = z.infer<typeof surfaceDayResurfacedV1>;

/**
 * The day's study question (spaced repetition). questionUid doubles as the
 * chatUid of its solution-discussion chat, so the tutoring conversation
 * rides the existing chat rails.
 */
export const studyQuestionPosedV1 = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  questionUid: z.uuid(),
  topic: z.string().min(1), // 'matrix-calculus' for now
  /** Curriculum stage, 1 (basics) upward. */
  level: z.number().int().min(1),
  /** Markdown with $/$$ LaTeX. */
  question: z.string().min(1),
  /** One sentence on what this practices. */
  notes: z.string(),
});
export type StudyQuestionPosed = z.infer<typeof studyQuestionPosedV1>;

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
  { type: "user.resource.captured", versions: [{ schema: userResourceCapturedV1 }] },
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
  { type: "user.devtask.archived", versions: [{ schema: userDevtaskArchivedV1 }] },
  { type: "dev.preview.started", versions: [{ schema: devPreviewStartedV1 }] },
  { type: "dev.run.started", versions: [{ schema: devRunStartedV1 }] },
  { type: "dev.transcript.appended", versions: [{ schema: devTranscriptAppendedV1 }] },
  { type: "dev.pr.opened", versions: [{ schema: devPrOpenedV1 }] },
  { type: "user.devmerge.requested", versions: [{ schema: userDevmergeRequestedV1 }] },
  { type: "agent.devmerge.requested", versions: [{ schema: agentDevmergeRequestedV1 }] },
  { type: "dev.pr.merged", versions: [{ schema: devPrMergedV1 }] },
  { type: "dev.run.finished", versions: [{ schema: devRunFinishedV1 }] },
  { type: "agent.taxonomy.proposed", versions: [{ schema: agentTaxonomyProposedV1 }] },
  { type: "agent.tagvocab.proposed", versions: [{ schema: agentTagVocabProposedV1 }] },
  {
    type: "agent.item.tagged",
    versions: [
      { schema: agentItemTaggedV1 },
      { schema: agentItemTaggedV2, upcast: upcastItemTaggedV1 },
    ],
  },
  { type: "user.chat.message_sent", versions: [{ schema: userChatMessageSentV1 }] },
  { type: "agent.chat.replied", versions: [{ schema: agentChatRepliedV1 }] },
  { type: "surface.day.resurfaced", versions: [{ schema: surfaceDayResurfacedV1 }] },
  { type: "study.question.posed", versions: [{ schema: studyQuestionPosedV1 }] },
]);
