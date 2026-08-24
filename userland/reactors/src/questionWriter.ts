import { createHash, randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Reactor, ReactorEvent } from "@nc/process";

// Poses one matrix/vector-calculus exercise per day, following a progressive
// curriculum. Progression is judged from the record itself: the generator
// reads recent questions AND their solution-discussion chats (each question's
// uid is its chat's uid), advancing when solutions came easily, reinforcing
// with variations when they didn't, and periodically revisiting older skills
// — the spaced-repetition loop, closed through the event log.

export interface QuestionHistoryItem {
  readonly day: string;
  readonly level: number;
  readonly question: string;
  /** Compressed transcript of the solution discussion; empty if undiscussed. */
  readonly discussion: string;
}

export interface GeneratedQuestion {
  readonly level: number;
  readonly question: string;
  readonly notes: string;
}

export type QuestionGenerator = (
  history: readonly QuestionHistoryItem[],
) => Promise<{ generated: GeneratedQuestion; usage: { tokensIn: number; tokensOut: number } }>;

const generatorOutput = z.object({
  level: z.number().int().min(1).max(7),
  question: z.string().min(1),
  notes: z.string(),
});

const generatorSystem = `You write ONE small matrix/vector calculus exercise
per day for Alex, an ML researcher, following a progressive curriculum:

1. Gradients of linear and quadratic forms (aᵀx, xᵀAx, bilinear forms).
2. Jacobians and the vector chain rule.
3. Matrix-argument gradients via traces (∂/∂X tr(AXB), Frobenius products).
4. Determinants and inverses (∂ log det X, ∂X⁻¹, adjugate identities).
5. Norms and compositions ML actually uses (softmax, logsumexp, layernorm).
6. Hessians and second-order structure.
7. Full backprop derivations for real layers (attention, layernorm, losses).

Alex's instruction on the style of the questions, verbatim:

> let's make them simpler and more concise, no need for a lot of preamble or
> multiple parts, just some interesting small problem to work on

Write the question in markdown with $...$ / $$...$$ LaTeX; if a layout
convention matters, settle it in one short parenthetical.

Progression policy, judged from the history you are shown (recent questions
with their solution discussions): if the last solution was correct and came
easily, step forward; if it had errors or the discussion showed struggle,
pose a fresh VARIATION exercising the same skill; if a question went
undiscussed, re-pose its skill differently rather than advancing; and roughly
every fifth question, revisit a skill from an earlier level (retention beats
momentum). Never repeat an exercise verbatim.

notes: one sentence on what it practices. Start at level 1 when there is no
history.`;

let client: Anthropic | undefined;

export const anthropicQuestionGenerator: QuestionGenerator = async (history) => {
  client ??= new Anthropic();
  const historyText =
    history.length === 0
      ? "(no history yet — first question)"
      : history
          .map(
            (h) =>
              `## ${h.day} (level ${h.level})\nQuestion: ${h.question}\n` +
              (h.discussion === "" ? "Not discussed." : `Discussion:\n${h.discussion}`),
          )
          .join("\n\n");
  const response = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,
    system: generatorSystem,
    messages: [{ role: "user", content: `Recent history:\n\n${historyText}` }],
    output_config: { format: zodOutputFormat(generatorOutput) },
  });
  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new Error(`question generation did not parse (stop_reason ${response.stop_reason})`);
  }
  return {
    generated: parsed,
    usage: { tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens },
  };
};

export const questionWriterJobPayload = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Re-pose the day's question (e.g. after a prompt change); the questions
   * fold keeps only the latest posing per (topic, day). */
  replace: z.boolean().optional(),
});

const topic = "matrix-calculus";
const historyDepth = 5;
const discussionChars = 1500;

export function makeQuestionWriterReactor(generate: QuestionGenerator): Reactor {
  return {
    kind: "reactor",
    name: "question-writer",
    trigger: { kind: "cron", schedule: { intervalHours: 24 }, payload: {} },
    async run(ctx, input): Promise<ReactorEvent[]> {
      if (input.kind !== "job") {
        throw new Error("question-writer only supports job triggers");
      }
      const payload = questionWriterJobPayload.parse(input.payload);
      const day = payload.day ?? new Date().toISOString().slice(0, 10);
      const recent = await ctx.sql`
        select question_uid, day, level, question from study_questions
        where topic = ${topic} and day < ${day}::date
        order by day desc limit ${historyDepth}`;
      const history: QuestionHistoryItem[] = [];
      for (const q of [...recent].reverse()) {
        const turns = await ctx.sql`
          select role, text from chat_turns
          where chat_uid = ${q["question_uid"]} order by event_seq`;
        const discussion = turns
          .map((t) => `${t["role"]}: ${t["text"]}`)
          .join("\n")
          .slice(0, discussionChars);
        history.push({
          day: new Date(q["day"]).toISOString().slice(0, 10),
          level: q["level"],
          question: q["question"],
          discussion,
        });
      }
      const { generated, usage } = await generate(history);
      ctx.recordUsage(usage);
      // A replace re-pose keys on the generated content, so retries of one
      // run still dedupe while a fresh generation supersedes (the fold keeps
      // only the latest posing per topic+day).
      const idempotencyKey =
        payload.replace === true
          ? `question:${topic}:${day}:${createHash("sha256").update(generated.question).digest("hex").slice(0, 8)}`
          : `question:${topic}:${day}`;
      return [
        {
          type: "study.question.posed",
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          payload: {
            day,
            questionUid: randomUUID(),
            topic,
            level: generated.level,
            question: generated.question,
            notes: generated.notes,
          },
          idempotencyKey,
        },
      ];
    },
  };
}

export const questionWriterReactor: Reactor = makeQuestionWriterReactor(
  anthropicQuestionGenerator,
);
