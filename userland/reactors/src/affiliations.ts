import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { arxivPaperIngestedV1, type AgentPaperAffiliationsExtracted } from "@nc/schema";
import type { Reactor, ReactorEvent } from "@nc/process";

// Extracts authors, affiliations, and emails from a paper's first-page text.
// Affiliations are printed on the paper itself, not in arXiv metadata, so
// this is an effect (an LLM call) whose output becomes facts in the log.

export interface ExtractionInput {
  readonly arxivId: string;
  readonly title: string;
  readonly text: string;
}

export interface ExtractionResult {
  readonly authors: AgentPaperAffiliationsExtracted["authors"];
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number };
}

export type AffiliationExtractor = (input: ExtractionInput) => Promise<ExtractionResult>;

/** Fetches the arXiv HTML rendering and strips it to plain text; null if absent. */
export async function fetchPaperText(
  arxivId: string,
  arxivVersion: number,
): Promise<string | null> {
  const response = await fetch(`https://arxiv.org/html/${arxivId}v${arxivVersion}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`arxiv html returned ${response.status} for ${arxivId}v${arxivVersion}`);
  }
  const html = await response.text();
  const text = html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 8000);
}

const outputSchema = z.object({
  authors: z.array(
    z.object({
      name: z.string(),
      affiliations: z.array(z.object({ raw: z.string(), org: z.string() })),
      email: z.string().nullable(),
    }),
  ),
});

const systemText = `You extract the author block from the first-page text of an
arXiv paper. Return every author in order with:
- name: as printed
- affiliations: each institution the author is affiliated with, as an object
  {raw, org} where raw is the affiliation as printed and org is a canonical
  lowercase slug for the institution. Slug rules: use the common short name —
  "Google DeepMind" or "DeepMind" -> "deepmind"; "Meta AI", "Meta FAIR", or
  "FAIR" -> "meta"; "OpenAI" -> "openai"; "Anthropic" -> "anthropic";
  "Massachusetts Institute of Technology" -> "mit"; "Stanford University" ->
  "stanford"; "Carnegie Mellon University" -> "cmu"; "UC Berkeley" ->
  "uc-berkeley". For others, kebab-case the common short name.
- email: the author's email if printed, else null. Expand grouped addresses
  like {alice,bob}@lab.com to the matching author.
Only report what is actually present in the text; do not guess affiliations.
The text is noisy (navigation, table of contents) — the author block usually
follows the title.`;

let client: Anthropic | undefined;

export const anthropicExtractor: AffiliationExtractor = async (input) => {
  client ??= new Anthropic();
  const response = await client.messages.parse({
    model: "claude-haiku-4-5",
    max_tokens: 4096,
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: `Title: ${input.title}\n\nFirst-page text:\n${input.text}` },
    ],
    output_config: { format: zodOutputFormat(outputSchema) },
  });
  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new Error(`extractor response did not parse (stop_reason ${response.stop_reason})`);
  }
  return {
    authors: parsed.authors.map((a) => ({
      name: a.name,
      affiliations: a.affiliations,
      ...(a.email === null ? {} : { email: a.email }),
    })),
    usage: {
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    },
  };
};

export function makeAffiliationsReactor(
  extractor: AffiliationExtractor,
  fetchText: typeof fetchPaperText,
): Reactor {
  return {
    kind: "reactor",
    name: "affiliations",
    trigger: { kind: "event", consumes: ["arxiv.paper.ingested"] },
    async run(ctx, input): Promise<ReactorEvent[]> {
      if (input.kind !== "event") {
        throw new Error("affiliations reactor is event-triggered only");
      }
      const paper = arxivPaperIngestedV1.parse(input.event.payload);
      const text = await fetchText(paper.arxivId, paper.arxivVersion);
      if (text === null) {
        // No HTML rendering for this paper (older submissions, some formats).
        console.log(`affiliations: no html for ${paper.arxivId}v${paper.arxivVersion}, skipping`);
        return [];
      }
      const result = await extractor({ arxivId: paper.arxivId, title: paper.title, text });
      ctx.recordUsage(result.usage);
      return [
        {
          type: "agent.paper.affiliations_extracted",
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          payload: { arxivId: paper.arxivId, authors: result.authors },
          idempotencyKey: `affiliations:${paper.arxivId}v${paper.arxivVersion}`,
          causedByUid: input.event.eventUid,
        },
      ];
    },
  };
}

export const affiliationsReactor: Reactor = makeAffiliationsReactor(
  anthropicExtractor,
  fetchPaperText,
);
