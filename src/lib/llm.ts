import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import type { z } from "zod";

/**
 * The single place the extraction model is chosen, built on the Vercel AI SDK
 * so swapping labs is a config change, not a code change.
 *
 *   LLM_PROVIDER  google (default) | openai | anthropic | ...
 *   LLM_MODELS    ordered, comma-separated fallback chain, e.g.
 *                 "gemini-flash-latest,gemini-2.5-flash". When the first model
 *                 hits its free-tier quota, the next is tried automatically.
 *   LLM_MODEL     single-model fallback if LLM_MODELS is unset.
 *
 * This model only does structured extraction, so any chat-capable model works.
 */
function resolveModel(id: string): LanguageModel {
  const provider = process.env.LLM_PROVIDER ?? "google";
  switch (provider) {
    case "google":
      return google(id);
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${provider}". Add a case in src/lib/llm.ts.`,
      );
  }
}

/** The ordered list of model ids to try, most-preferred first. */
export function getModelIds(): string[] {
  const chain = process.env.LLM_MODELS;
  if (chain) {
    const ids = chain.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length) return ids;
  }
  // "latest" tracks the current free-tier flash model so single-model setups
  // don't rot when Google retires a version.
  const single = process.env.LLM_MODEL ?? "gemini-flash-latest";
  return [single];
}

export function getModel(): LanguageModel {
  return resolveModel(getModelIds()[0]!);
}

/** Whether the extraction model has credentials, so the UI only offers lookup when it'll work. */
export function isLlmConfigured(): boolean {
  const provider = process.env.LLM_PROVIDER ?? "google";
  if (provider === "google") {
    return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  }
  // Other providers resolve their own credentials from the environment.
  return true;
}

/**
 * Errors where retrying with a DIFFERENT model is sensible: a hit free-tier
 * quota/rate-limit, or the model being unavailable for this key. A genuine
 * bad-request (bad prompt/schema) is not retried — it'd fail on every model.
 */
function shouldFallback(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /quota|rate.?limit|429|resource.?exhausted|exhausted|not found|no longer available|404|unavailable|permission|403/i.test(
    m,
  );
}

/**
 * generateObject with automatic fallback down the model chain. Tries each model
 * in getModelIds() in turn; when one hits its quota (or is unavailable), moves
 * to the next. Returns the first success, along with which model produced it.
 */
export async function generateObjectFallback<T>(args: {
  schema: z.ZodType<T>;
  prompt: string;
}): Promise<{ object: T; modelId: string }> {
  const ids = getModelIds();
  let lastErr: unknown;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    try {
      const { object } = await generateObject({
        model: resolveModel(id),
        schema: args.schema,
        prompt: args.prompt,
      });
      return { object: object as T, modelId: id };
    } catch (err) {
      lastErr = err;
      const hasNext = i < ids.length - 1;
      if (hasNext && shouldFallback(err)) {
        console.warn(
          `LLM model "${id}" unavailable (${
            err instanceof Error ? err.message : String(err)
          }); falling back to "${ids[i + 1]}".`,
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
