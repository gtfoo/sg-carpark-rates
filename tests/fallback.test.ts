import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { splitEntry, hasCredentials, getModelIds, isLlmConfigured } from "../src/lib/llm";
import {
  getSearchProviders,
  hasSearchCredentials,
  isSearchConfigured,
} from "../src/lib/websearch";

/**
 * The resilience contract for both chains.
 *
 * On 2026-08-17 the app went dark: Tavily's quota and Google's free tier were
 * exhausted within the same day. Neither outage should have been fatal, and the
 * reasons they were are pinned below — a chain that cannot leave its provider,
 * and a search path with no chain at all.
 */

const ENV_KEYS = [
  "LLM_PROVIDER",
  "LLM_MODELS",
  "LLM_MODEL",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "SEARCH_PROVIDERS",
  "SEARCH_PROVIDER",
  "TAVILY_API_KEY",
  "BRAVE_API_KEY",
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function only(vars: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}

test("a chain entry can carry its own provider", () => {
  only({});
  assert.deepEqual(splitEntry("anthropic:claude-haiku-4-5"), {
    provider: "anthropic",
    id: "claude-haiku-4-5",
  });
  // A bare id still follows LLM_PROVIDER, so existing config is untouched.
  process.env.LLM_PROVIDER = "google";
  assert.deepEqual(splitEntry("gemini-flash-latest"), {
    provider: "google",
    id: "gemini-flash-latest",
  });
});

test("a model id containing a colon splits on the FIRST one", () => {
  only({});
  // Vendors do put colons in ids (":free" variants, ":latest" tags). Splitting
  // on the last colon would read the tag as the model and lose the provider.
  assert.deepEqual(splitEntry("openai:gpt-4.1-mini:2025"), {
    provider: "openai",
    id: "gpt-4.1-mini:2025",
  });
});

test("the outage: a same-provider chain has nowhere to fall back to", () => {
  only({
    LLM_MODELS: "google:gemini-flash-latest,google:gemini-2.5-flash",
    GOOGLE_GENERATIVE_AI_API_KEY: "x",
  });
  const providers = getModelIds().map((e) => splitEntry(e).provider);
  // Two entries, one provider, one quota — this is what failed. The assertion
  // exists so the shape is visible, not because it is desirable.
  assert.deepEqual(new Set(providers), new Set(["google"]));

  only({
    LLM_MODELS: "google:gemini-flash-latest,anthropic:claude-haiku-4-5",
    GOOGLE_GENERATIVE_AI_API_KEY: "x",
    ANTHROPIC_API_KEY: "y",
  });
  const fixed = getModelIds().map((e) => splitEntry(e).provider);
  assert.equal(new Set(fixed).size, 2, "a real chain spans providers");
});

test("credentials are checked per provider, not assumed", () => {
  only({ LLM_MODELS: "anthropic:claude-haiku-4-5" });
  // The old code returned true for every non-Google provider, so the UI offered
  // a lookup button that failed on every press.
  assert.equal(hasCredentials("anthropic"), false);
  assert.equal(isLlmConfigured(), false);

  only({ LLM_MODELS: "anthropic:claude-haiku-4-5", ANTHROPIC_API_KEY: "y" });
  assert.equal(isLlmConfigured(), true);
});

test("one credentialed link is enough to call the chain usable", () => {
  only({
    LLM_MODELS: "google:gemini-flash-latest,anthropic:claude-haiku-4-5",
    ANTHROPIC_API_KEY: "y", // no Google key at all
  });
  assert.equal(isLlmConfigured(), true);
});

test("search has a provider chain, and honours the old single-provider config", () => {
  only({ SEARCH_PROVIDERS: "tavily,brave" });
  assert.deepEqual(getSearchProviders(), ["tavily", "brave"]);

  only({ SEARCH_PROVIDER: "tavily" });
  assert.deepEqual(getSearchProviders(), ["tavily"]);

  only({});
  assert.deepEqual(getSearchProviders(), ["tavily"], "defaults unchanged");
});

test("search stays configured while any provider holds a key", () => {
  only({ SEARCH_PROVIDERS: "tavily,brave" });
  assert.equal(isSearchConfigured(), false);

  // Tavily exhausted and its key pulled — Brave alone keeps the feature alive.
  only({ SEARCH_PROVIDERS: "tavily,brave", BRAVE_API_KEY: "b" });
  assert.equal(isSearchConfigured(), true);
  assert.equal(hasSearchCredentials("tavily"), false);
  assert.equal(hasSearchCredentials("brave"), true);
});
