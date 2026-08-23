import { test } from "node:test";
import assert from "node:assert/strict";
import { describeNonRate } from "../src/lib/sources/mallRates";

/**
 * Several stored rows are not rates. The fee engine returns null for each and
 * the card said "not computable" — which reads as a parser failure, invites
 * distrust of the whole row, and throws away the specific thing the operator
 * actually told us.
 *
 * Every string here is real, taken from the store.
 */

test("a stated restriction is not a parse failure", () => {
  assert.equal(
    describeNonRate("7.00am-5.59pm: No Entry (Staff Parking Only)"),
    "No public parking at this time.",
  );
  assert.equal(
    describeNonRate("10.30pm-7.00am: Reserved Parking only"),
    "No public parking at this time.",
  );
  assert.equal(describeNonRate("Closed"), "Closed at this time.");
});

test("text that points elsewhere says so", () => {
  assert.equal(
    describeNonRate(
      "Available at current Parliament House, The Adelphi and the road side along Empress Place",
    ),
    "No parking here — the rate text names where to park instead.",
  );
  assert.match(describeNonRate("URA coupon parking") ?? "", /coupon/);
});

test("anything quoting money is a rate we failed to read, not a statement", () => {
  // The distinction is the whole point: this one IS a bug, and must keep
  // saying so rather than being explained away.
  assert.equal(
    describeNonRate("7.00am-7.00pm: $1.80 for 1st hr or part thereof; $0.80 for sub. 1 per 2 hr"),
    null,
  );
  // Even alongside restriction words.
  assert.equal(describeNonRate("Reserved parking only $2.00 per hour"), null);
});

test("ordinary unparseable prose stays null", () => {
  assert.equal(describeNonRate(""), null);
  assert.equal(describeNonRate("   "), null);
  assert.equal(describeNonRate("Ask the security guard"), null);
});
