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
 *
 * Raised from 25 to 29 once the per-block pattern began requiring a "$" on the
 * amount. That silenced a family of confident wrong answers — "Capped at $35
 * per 24hrs" read as $24 an hour, "the first 1 hour" as $1 an hour — which had
 * Clarke Quay, Lot One and Parkway Parade all quoting $24.00 for two hours.
 * Teaching the parser "first", "2-hrs" and multi-hour blocks recovered 18 of
 * those at the right price; the 5 left are malformed at source (the amount
 * written after its period, "sub. 1 per 2 hr") and now read "—" instead of a
 * number that was never right. A rise is only ever acceptable with that kind
 * of accounting, string by string.
 *
 * Raised again, 29 to 31, when band splitting moved from cutting on ";" to
 * cutting wherever a new clock range opens. Two strings lost a price at 1pm:
 * Funan, whose covering band writes the amount after its unit ("Every 15min of
 * part thereof at $0.65") and which had been quoting a LATER band's price, and
 * Jurong Lake Gardens, which lists "Free" ahead of the hours it applies to.
 * Against that, 60 stored rates had a band that could never be selected at all,
 * so afternoon and evening arrivals were priced at the morning rate.
 *
 * Down to 24 once the parser learned the shapes where an amount is written
 * AFTER its period — "1st hour @ $1.60", "Every 15min ... at $0.65" — plus the
 * "(with 9% GST)" note between an amount and its unit, and amounts in cents.
 * 26 prices recovered across four arrival hours, none moved, none lost.
 *
 * Then 36 when the fixture was regenerated after the LTA re-sourcing. Not a
 * parser regression: the open dataset writes weekend columns as "Charges same
 * as wkdays, but $3 per entry after 1pm", which parses as same-as-other and
 * defers correctly in the app via rateForDay — but this probe prices each
 * string IN ISOLATION, where a deferral legitimately reads as null. The "but
 * $3 per entry after ..." addendum those strings carry is a real modelling
 * gap (the deferral keeps the weekday rate and drops the addendum), worth
 * teaching some day; the deferral itself is fine.
 */
// 36 -> 35 when the parser learned "1/2 hr" (The Metropolis — previously
// priced as a two-hour block, a wrong number rather than a blank), then 35 ->
// 29 after the JTC import: the corpus grew 613 -> 684 strings and the count
// still FELL, because the same pass removed the junk rows a broken extractor
// had written and researched the car parks that had gone blank.
//
// Several of the remaining 29 are day columns that just say "Same as wkdays":
// fine in the app, where the day fallback resolves them, but priced standalone
// here they count as unpriceable. Teaching checkCorpus that distinction would
// make this baseline honest rather than merely stable.
const MAX_UNPRICEABLE = 29;

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
