import Anthropic from "@anthropic-ai/sdk";

/** Writes a short human title for a dev task from its spec. */
export interface TitleResult {
  readonly title: string;
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number };
}
export type Titler = (spec: string) => Promise<TitleResult>;

const systemText = `You title dev tasks for a personal software project. Given the
task instructions, reply with ONLY a title: 3-8 words, imperative mood, no
quotes, no trailing period. Example: "Add a papers-by-org view".`;

let client: Anthropic | undefined;

export const anthropicTitler: Titler = async (spec) => {
  client ??= new Anthropic();
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 60,
    system: [{ type: "text", text: systemText }],
    messages: [{ role: "user", content: spec.slice(0, 4000) }],
  });
  const title = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim()
    .replace(/^["']+|["'.]+$/g, "");
  if (title === "") {
    throw new Error(`titler returned no text (stop_reason ${response.stop_reason})`);
  }
  return {
    title: title.slice(0, 200),
    usage: {
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    },
  };
};

/** Deterministic stand-in when the LLM call fails: first line of the spec. */
export function fallbackTitle(spec: string): string {
  const first = (spec.trim().split("\n")[0] ?? "").trim();
  if (first === "") {
    return "dev task";
  }
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}
