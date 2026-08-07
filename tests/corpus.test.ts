import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCorpus, checkCorpus, IMPLAUSIBLE_2H } from "../scripts/rateHealth";

/**
 * Prices every real rate string in the store against the parser.
 *
 * The unit tests pin cases we already fixed; this catches the ones nobody
 * thought of. Three mispricing bugs shipped this month and every one was found
 * by accident — the band-split regression turned 142 rates into "not
 * computable" and nothing failed. Running the whole corpus on each push is
 * what makes that impossible to miss.
 *
 * Refresh with `npm run export-rate-corpus` after importing rates.
 */

/**
 * Strings that genuinely aren't rates — "Carpark Closed", "Street Parking is
 * available along Mosque Street", "No Entry (Staff Parking Only)" — plus a
 * handful the parser can't read yet. The app shows these as "—", which is the
 * honest outcome, so they're tolerated rather than fixed.
 *
 * This number must never RISE: that means a rate that used to price stopped
 * pricing. Lowering it is the goal; do that by teaching the parser, then drop
 * the baseline in the same commit.
 */
const MAX_UNPRICEABLE = 25;

test("every stored rate still prices, or was already known not to", () => {
  const health = checkCorpus(loadCorpus());
  assert.ok(health.total > 400, `corpus looks truncated: ${health.total} strings`);

  assert.ok(
    health.unpriceable.length <= MAX_UNPRICEABLE,
    `${health.unpriceable.length} rate strings no longer price (baseline ${MAX_UNPRICEABLE}).\n` +
      `Newly broken, most likely:\n` +
      health.unpriceable
        .slice(0, 12)
        .map((e) => `  ${e.name} :: ${e.rate.slice(0, 80)}`)
        .join("\n") +
      `\nRun \`npm run rates-health\` for the full list.`,
  );
});

test("no rate prices to an implausible amount", () => {
  // "$3.27.00" once parsed as $27.00 and quoted $30.28 for two hours. A
  // confident wrong number is worse than a blank, and only a sweep catches it.
  const health = checkCorpus(loadCorpus());
  assert.deepEqual(
    health.implausible.map((x) => `${x.entry.name}: $${x.fee.toFixed(2)} :: ${x.entry.rate.slice(0, 70)}`),
    [],
    `rate(s) priced above $${IMPLAUSIBLE_2H} for two hours — almost certainly a misparse`,
  );
});

test("no rate silently prices as free", () => {
  // A half-parsed rate can yield $0, which reads as "Free" on the card. Only
  // text that actually says free may do that.
  const health = checkCorpus(loadCorpus());
  assert.deepEqual(
    health.suspiciousFree.map((e) => `${e.name} :: ${e.rate.slice(0, 70)}`),
    [],
    "rate(s) priced at $0 without saying they are free",
  );
});
