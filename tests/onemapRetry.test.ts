import { test } from "node:test";
import assert from "node:assert/strict";
import { retrySpelling } from "../src/lib/onemap";

/**
 * OneMap cannot find a building by its own name when that name contains "&".
 *
 * Measured 2026-08-28. "ABC BRICKWORKS MARKET & FOOD CENTRE" is indexed under
 * exactly that string and the search returns nothing for it; "ABC BRICKWORKS
 * MARKET FOOD CENTRE" finds it immediately. "TEKKA MARKET & FOOD CENTRE" fails
 * the same way, and so would our own stored "Waterfront Plaza & King's Centre".
 *
 * "Market & Food Centre" is a naming convention here, so this was not one
 * hawker centre — it was all of them.
 */

test("a name with an ampersand gets a second spelling", () => {
  assert.equal(
    retrySpelling("ABC BRICKWORKS MARKET & FOOD CENTRE"),
    "ABC BRICKWORKS MARKET FOOD CENTRE",
  );
  assert.equal(
    retrySpelling("Waterfront Plaza & King's Centre"),
    "Waterfront Plaza King's Centre",
  );
});

test("a name without one gets no retry", () => {
  // Returning the same string would spend a second call to learn nothing.
  assert.equal(retrySpelling("Tiong Bahru Market"), null);
  assert.equal(retrySpelling(""), null);
});

test("the retry cannot itself be retried", () => {
  // geocode() recurses on this, so a second spelling that still needs one
  // would loop.
  const once = retrySpelling("A & B & C");
  assert.equal(once, "A B C");
  assert.equal(retrySpelling(once!), null);
});

test("a query that is only ampersands yields nothing to retry", () => {
  assert.equal(retrySpelling("&"), null);
  assert.equal(retrySpelling(" & "), null);
});
