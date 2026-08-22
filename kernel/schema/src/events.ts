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
const entityRef = z.object({
  kind: z.string().min(1),  // 'paper' | 'person' | 'org' | ...
  ref: z.string().min(1),   // e.g. 'arxiv:2508.12345', 'anthropic'
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
]);
