import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldFallback } from "../src/lib/llm";

/**
 * When a model in the chain fails, does the chain move on or give up?
 *
 * The real incident, 2026-08-23 07:51 SGT: Gemini returned 503 and the whole
 * lookup died with "Web lookup failed" while two credentialed providers sat
 * idle. The usage log shows `google … error` with no anthropic line after it,
 * where every earlier lookup that day reads `google rate_limited` then
 * `anthropic ok`.
 *
 * The cause is the shape of the error, not the outage: the SDK puts the
 * provider's sentence in `message` and its JSON in `responseBody`, and Gemini's
 * sentence contains no word the old test looked for.
 */

/** The AI SDK's shape: human sentence in message, provider JSON in responseBody. */
function apiError(message: string, statusCode?: number, responseBody?: string) {
  return Object.assign(new Error(message), { statusCode, responseBody });
}

test("the Gemini 503 that broke the chain now falls through", () => {
  // Verbatim. Note it contains none of: quota, rate limit, 429, exhausted,
  // unavailable, 503.
  const msg =
    "This model is currently experiencing high demand. Spikes in demand are " +
    "usually temporary. Please try again later.";
  assert.equal(shouldFallback(apiError(msg)), true, "message alone must be enough");
  assert.equal(
    shouldFallback(
      apiError(msg, 503, '{"error":{"code":503,"status":"UNAVAILABLE"}}'),
    ),
    true,
  );
});

test("a status code alone is enough, whatever the wording", () => {
  // Providers phrase outages a dozen ways; the number is the reliable part.
  for (const status of [429, 500, 502, 503, 504, 529]) {
    assert.equal(shouldFallback(apiError("something opaque", status)), true, `status ${status}`);
  }
});

test("a bad key on one provider does not condemn the next", () => {
  assert.equal(shouldFallback(apiError("Invalid API key", 401)), true);
  assert.equal(shouldFallback(apiError("Forbidden", 403)), true);
});

test("the quota errors that already worked still work", () => {
  assert.equal(
    shouldFallback(
      new Error(
        "You exceeded your current quota. Quota exceeded for metric: " +
          "generativelanguage.googleapis.com/generate_content_free_tier_requests",
      ),
    ),
    true,
  );
  assert.equal(shouldFallback(new Error("429 Too Many Requests")), true);
  assert.equal(shouldFallback(new Error("model not found")), true);
});

test("Anthropic's own overload wording falls through", () => {
  assert.equal(shouldFallback(apiError("Overloaded", 529)), true);
});

test("a genuine programming error is still fatal", () => {
  // Not everything should be retried down the chain — a bug would otherwise be
  // charged to three providers before surfacing.
  assert.equal(shouldFallback(new TypeError("x is not a function")), false);
  assert.equal(shouldFallback(new Error("prompt is required")), false);
});
