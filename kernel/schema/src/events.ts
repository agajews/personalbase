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

export const coreRegistry: SchemaRegistry = makeRegistry([
  { type: "arxiv.paper.ingested", versions: [{ schema: arxivPaperIngestedV1 }] },
  { type: "user.filter.defined", versions: [{ schema: userFilterDefinedV1 }] },
  { type: "agent.paper.filtered", versions: [{ schema: agentPaperFilteredV1 }] },
]);
