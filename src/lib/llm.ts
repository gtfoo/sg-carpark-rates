import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import type { z } from "zod";
import { isRateLimit, recordUsage } from "./usage";

/**
 * The single place the extraction model is chosen, built on the Vercel AI SDK
 * so swapping labs is a config change, not a code change.
 *
 *   LLM_PROVIDER  default provider for entries that don't name one
 *   LLM_MODELS    ordered, comma-separated fallback chain. Entries MAY carry
 *                 their own provider, and for resilience they should:
 *                 "google:gemini-flash-latest,anthropic:claude-haiku-4-5"
 *   LLM_MODEL     single-model fallback if LLM_MODELS is unset.
 *
 * **Cross the provider boundary in the chain.** A chain of same-provider models
 * shares one quota and buys nothing when that quota runs out — see splitEntry.
 *
 * This model only does structured extraction, so any chat-capable model works.
 */
/**
 * One chain entry, which may name its own provider:
 * `"anthropic:claude-haiku-4-5"`. A bare id uses `LLM_PROVIDER`, so existing
 * config keeps working untouched.
 *
 * Per-entry providers are the whole point of the chain. Entries sharing a
 * provider share a quota — so when the Google free tier was exhausted, the
 * fallback loop dutifully tried every Gemini model in turn and each failed
 * identically. The machinery worked; it just had nowhere to go. **A fallback
 * chain that cannot leave its provider is not a fallback chain.**
 */
export function splitEntry(entry: string): { provider: string; id: string } {
  const at = entry.indexOf(":");
  if (at === -1) return { provider: process.env.LLM_PROVIDER ?? "google", id: entry.trim() };
  return { provider: entry.slice(0, at).trim(), id: entry.slice(at + 1).trim() };
}

/** Where each provider's key lives. Also what the configured check reads. */
const PROVIDER_KEYS: Record<string, string> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function hasCredentials(provider: string): boolean {
  const key = PROVIDER_KEYS[provider];
  return key ? Boolean(process.env[key]) : false;
}

function resolveModel(entry: string): LanguageModel {
  const { provider, id } = splitEntry(entry);
  switch (provider) {
    case "google":
      return google(id);
    case "anthropic":
      return anthropic(id);
    case "openai":
      return openai(id);
    default:
      throw new Error(
        `Unknown LLM provider "${provider}". Add a case in src/lib/llm.ts.`,
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

/**
 * Whether ANY entry in the chain has credentials, so the UI only offers lookup
 * when it will actually work.
 *
 * This used to return `true` for every non-Google provider on the theory that
 * they "resolve their own credentials" — which meant setting
 * `LLM_PROVIDER=anthropic` with no key showed the user a working button that
 * failed on every press. Checking the real env var per provider is the point.
 *
 * Any, not all: a chain is usable while one link holds.
 */
export function isLlmConfigured(): boolean {
  return getModelIds().some((entry) => hasCredentials(splitEntry(entry).provider));
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
  /** Labels the call in the usage log, e.g. "rate-lookup". */
  op?: string;
}): Promise<{ object: T; modelId: string }> {
  // Entries without a key are dropped before the loop, not attempted. A
  // missing-credential error does not match shouldFallback(), so attempting one
  // would abort the whole chain — the opposite of what a fallback list is for.
  const all = getModelIds();
  const ids = all.filter((entry) => hasCredentials(splitEntry(entry).provider));
  if (!ids.length) {
    throw new Error(
      `No model in the chain has credentials. Checked: ${all.join(", ")}. ` +
        `Set the key for at least one provider (see .env.example).`,
    );
  }
  let lastErr: unknown;
  for (let i = 0; i < ids.length; i++) {
    const entry = ids[i]!;
    const { provider, id } = splitEntry(entry);
    try {
      const { object, usage } = await generateObject({
        model: resolveModel(entry),
        schema: args.schema,
        prompt: args.prompt,
      });
      // `id` rather than getModelIds()[0]: on a fallback these differ, and the
      // model that answered is the one whose quota was actually spent.
      await recordUsage({
        provider,
        model: id,
        op: args.op,
        requests: 1,
        in_tokens: usage?.inputTokens,
        out_tokens: usage?.outputTokens,
        units: null,
        // Free-tier Gemini has no dollar cost. Null, never 0 — see usage.ts.
        usd: null,
        status: "ok",
      });
      return { object: object as T, modelId: entry };
    } catch (err) {
      lastErr = err;
      // Recorded before deciding whether to fall back, so an exhausted model
      // leaves a line whether or not another one rescued the request. That
      // line is the only evidence of where the free-tier ceiling really is.
      await recordUsage({
        provider,
        model: id,
        op: args.op,
        requests: 1,
        units: null,
        usd: null,
        status: isRateLimit(err) ? "rate_limited" : "error",
      });
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
