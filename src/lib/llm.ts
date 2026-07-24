import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

/**
 * The single place the extraction model is chosen, built on the Vercel AI SDK
 * so swapping labs is a config change, not a code change.
 *
 *   LLM_PROVIDER  google (default) | openai | anthropic | ...
 *   LLM_MODEL     provider model id (default: gemini-flash-latest — free tier)
 *
 * This model only does structured extraction from search results, so any
 * chat-capable model works — no provider-specific web-search grounding needed
 * (see websearch.ts for the search step).
 */
export function getModel(): LanguageModel {
  const provider = process.env.LLM_PROVIDER ?? "google";
  // gemini-2.5-* is retired for new API keys; "latest" tracks the current
  // free-tier flash model so this doesn't rot again.
  const modelId = process.env.LLM_MODEL ?? "gemini-flash-latest";

  switch (provider) {
    case "google":
      return google(modelId);
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${provider}". Add a case in src/lib/llm.ts.`,
      );
  }
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
