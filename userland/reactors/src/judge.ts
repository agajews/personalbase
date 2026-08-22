import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export interface PaperForJudging {
  readonly arxivId: string;
  readonly title: string;
  readonly abstract: string;
  readonly categories: readonly string[];
}

export interface Judgment {
  readonly arxivId: string;
  readonly verdict: "match" | "reject";
  readonly confidence: number;
  readonly reason: string;
}

export interface JudgeResult {
  readonly judgments: readonly Judgment[];
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number };
}

export type JudgeFn = (
  model: string,
  filterPrompt: string,
  papers: readonly PaperForJudging[],
) => Promise<JudgeResult>;

const outputSchema = z.object({
  judgments: z.array(
    z.object({
      arxiv_id: z.string(),
      verdict: z.enum(["match", "reject"]),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    }),
  ),
});

const systemText = `You judge arXiv papers against a researcher's interest filter.

You are given the filter (a free-text description of what the researcher wants
to see) and a list of papers, each with an arxiv_id, title, abstract, and
categories. For each paper decide whether it matches the filter: verdict
"match" means the researcher would want this paper surfaced, "reject" means
they would not. Judge on the actual content of the title and abstract, not on
superficial keyword overlap. Set confidence in [0, 1] and give a one-sentence
reason. Return exactly one judgment per paper, with arxiv_id copied exactly as
given.`;

function papersBlock(papers: readonly PaperForJudging[]): string {
  return papers
    .map(
      (p) =>
        `arxiv_id: ${p.arxivId}\ncategories: ${p.categories.join(", ")}\ntitle: ${p.title}\nabstract: ${p.abstract}`,
    )
    .join("\n\n---\n\n");
}

let client: Anthropic | undefined;

async function judgeOnce(
  model: string,
  filterPrompt: string,
  papers: readonly PaperForJudging[],
): Promise<{ byId: Map<string, Judgment>; tokensIn: number; tokensOut: number }> {
  client ??= new Anthropic();
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Filter:\n${filterPrompt}\n\nPapers:\n\n${papersBlock(papers)}`,
      },
    ],
    output_config: { format: zodOutputFormat(outputSchema) },
  });
  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new Error(
      `judge response did not parse (stop_reason ${response.stop_reason})`,
    );
  }
  const byId = new Map(
    parsed.judgments.map((j): [string, Judgment] => [
      j.arxiv_id,
      { arxivId: j.arxiv_id, verdict: j.verdict, confidence: j.confidence, reason: j.reason },
    ]),
  );
  return {
    byId,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
  };
}

export const anthropicJudge: JudgeFn = async (model, filterPrompt, papers) => {
  const first = await judgeOnce(model, filterPrompt, papers);
  let tokensIn = first.tokensIn;
  let tokensOut = first.tokensOut;
  const byId = first.byId;

  // The model occasionally omits a paper from a batch. Re-ask once for just
  // the missing ones rather than failing the whole (already paid-for) run.
  const missing = papers.filter((p) => !byId.has(p.arxivId));
  if (missing.length > 0) {
    const retry = await judgeOnce(model, filterPrompt, missing);
    tokensIn += retry.tokensIn;
    tokensOut += retry.tokensOut;
    for (const [id, judgment] of retry.byId) {
      byId.set(id, judgment);
    }
  }

  const judgments = papers.map((paper): Judgment => {
    const j = byId.get(paper.arxivId);
    if (j === undefined) {
      throw new Error(`judge returned no judgment for ${paper.arxivId} even after retry`);
    }
    return j;
  });
  return { judgments, usage: { tokensIn, tokensOut } };
};
