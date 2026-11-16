import Anthropic from "@anthropic-ai/sdk";
import type { Part } from "./extract";
import { QUIZ_SCHEMA, SYSTEM_PROMPT, instructionFor, sharedPreamble } from "./prompts";
import type { GenerateEvent, Quiz, QuizQuestion, ResourceKind } from "./types";

type ContentBlock = Anthropic.Beta.BetaContentBlockParam;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const MODEL = process.env.STUDY_MODEL?.trim() || "claude-opus-5-5";
const EFFORT: Effort = (["low", "medium", "high", "xhigh", "max"] as const).includes(
  process.env.STUDY_EFFORT?.trim() as Effort,
)
  ? (process.env.STUDY_EFFORT!.trim() as Effort)
  : "high";

// These models can be declined by safety classifiers; the server-side fallback
// re-runs a declined request on another model inside the same call.
const SUPPORTS_FALLBACK = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(MODEL);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** The shared, cacheable part of the request: context note plus every material. */
function buildSharedContent(parts: Part[], preamble: string): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text: preamble }];
  parts.forEach((part, i) => {
    const label = `Material ${i + 1} of ${parts.length}: ${part.name}`;
    if (part.as === "pdf") {
      blocks.push({ type: "text", text: label });
      blocks.push({
        type: "document",
        title: part.name,
        source: { type: "base64", media_type: "application/pdf", data: part.data.toString("base64") },
      });
    } else if (part.as === "image") {
      blocks.push({ type: "text", text: label });
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: part.mediaType, data: part.data.toString("base64") },
      });
    } else {
      blocks.push({ type: "text", text: `${label}\n<material>\n${part.text}\n</material>` });
    }
  });
  // Everything up to here is identical for all three resources.
  const last = blocks[blocks.length - 1];
  if (last.type === "text" || last.type === "document" || last.type === "image") {
    last.cache_control = { type: "ephemeral" };
  }
  return blocks;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "The server's Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY and restart.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "The server's Anthropic API key doesn't have access to this model.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "The AI service is busy right now. Wait a minute and try again.";
  }
  if (err instanceof Anthropic.BadRequestError) {
    if (/too long|too many|exceed|maximum/i.test(err.message)) {
      return "This material is too large to process in one go. Try fewer files, or split a long PDF into chapters.";
    }
    return `The AI service couldn't process this material: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Lost the connection to the AI service. Check the server's network and try again.";
  }
  if (err instanceof Anthropic.APIError) {
    return `The AI service returned an error (${err.status ?? "unknown"}). Try again shortly.`;
  }
  if (err instanceof Error && /api[_ ]?key|authToken|credentials/i.test(err.message)) {
    return "The server has no Anthropic API key. Set ANTHROPIC_API_KEY and restart.";
  }
  return "Something went wrong while generating. Please try again.";
}

/** Drops malformed questions rather than showing a broken quiz. */
export function normalizeQuiz(raw: unknown): Quiz | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as { title?: unknown; questions?: unknown };
  if (!Array.isArray(data.questions)) return null;
  const questions: QuizQuestion[] = [];
  for (const q of data.questions as Record<string, unknown>[]) {
    if (!q || typeof q.question !== "string" || !Array.isArray(q.options)) continue;
    const options = q.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim());
    const index = q.correctIndex;
    if (options.length !== q.options.length || options.length < 2 || options.length > 4) continue;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= options.length) continue;
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) continue;
    questions.push({
      question: q.question.trim(),
      options,
      correctIndex: index,
      explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
      topic: typeof q.topic === "string" && q.topic.trim() ? q.topic.trim() : "General",
      difficulty:
        q.difficulty === "recall" || q.difficulty === "understanding" || q.difficulty === "application"
          ? q.difficulty
          : "understanding",
    });
  }
  if (questions.length < 3) return null;
  return { title: typeof data.title === "string" ? data.title.trim() : "Practice quiz", questions };
}

interface RunArgs {
  parts: Part[];
  resources: ResourceKind[];
  quizLength: number;
  avoid: string[];
  gradeLevel: string;
  focus: string;
  studentContext: string | null;
  emit: (event: GenerateEvent) => void;
  signal: AbortSignal;
}

export async function runGeneration(args: RunArgs): Promise<void> {
  const { emit, signal } = args;
  const shared = buildSharedContent(
    args.parts,
    sharedPreamble({
      gradeLevel: args.gradeLevel,
      focus: args.focus,
      studentContext: args.studentContext,
      materialCount: args.parts.length,
    }),
  );

  const runOne = async (kind: ResourceKind, onFirstEvent: () => void): Promise<void> => {
    emit({ type: "start", resource: kind });
    try {
      const stream = anthropic().beta.messages.stream(
        {
          model: MODEL,
          max_tokens: 64000,
          ...(SUPPORTS_FALLBACK ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
          output_config: {
            effort: EFFORT,
            ...(kind === "quiz" ? { format: { type: "json_schema" as const, schema: QUIZ_SCHEMA } } : {}),
          },
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [...shared, { type: "text", text: instructionFor(kind, args.quizLength, args.avoid) }],
            },
          ],
        },
        { signal },
      );

      let text = "";
      let questionsSeen = 0;
      let first = true;
      for await (const event of stream) {
        if (first) {
          first = false;
          onFirstEvent();
        }
        if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;
        text += event.delta.text;
        if (kind === "quiz") {
          const count = text.match(/"explanation"\s*:/g)?.length ?? 0;
          if (count !== questionsSeen) {
            questionsSeen = count;
            emit({ type: "progress", resource: "quiz", count });
          }
        } else {
          emit({ type: "delta", resource: kind, text: event.delta.text });
        }
      }

      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") {
        emit({
          type: "error",
          resource: kind,
          message: "The AI declined to generate this resource for the material provided.",
        });
        return;
      }
      const truncated = message.stop_reason === "max_tokens";
      // The final message is authoritative (it differs from the streamed text
      // only if a fallback model took over mid-response).
      const finalText = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      if (kind === "quiz") {
        let quiz: Quiz | null = null;
        try {
          quiz = normalizeQuiz(JSON.parse(finalText));
        } catch {
          quiz = null;
        }
        if (!quiz) {
          emit({
            type: "error",
            resource: kind,
            message: truncated
              ? "The quiz was cut off before it finished. Try a shorter quiz."
              : "The quiz came back in an unexpected format. Try generating it again.",
          });
          return;
        }
        emit({ type: "done", resource: kind, quiz });
      } else if (!finalText.trim()) {
        emit({ type: "error", resource: kind, message: "Nothing was generated. Please try again." });
      } else {
        emit({ type: "done", resource: kind, truncated, ...(finalText !== text ? { text: finalText } : {}) });
      }
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) return;
      console.error(`[generate] ${kind} failed:`, err instanceof Error ? err.message : err);
      emit({ type: "error", resource: kind, message: describeError(err) });
    } finally {
      onFirstEvent();
    }
  };

  // A prompt-cache entry only becomes readable once the first response starts
  // streaming. Start one request, wait for its first event, then start the
  // others so they read the material from cache instead of paying for it again.
  const [firstKind, ...rest] = args.resources;
  let release!: () => void;
  const firstStarted = new Promise<void>((resolve) => (release = resolve));
  const firstRun = runOne(firstKind, release);
  await firstStarted;
  await Promise.all([firstRun, ...rest.map((kind) => runOne(kind, () => {}))]);
}
