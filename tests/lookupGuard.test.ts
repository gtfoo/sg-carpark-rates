import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRate,
  bandForTime,
  estimateMallFee,
  parseLimits,
} from "../src/lib/sources/mallRates";

/**
 * The write-time guard in `lookupCarparkRate`.
 *
 * An AI-retrieved rate used to be stored verbatim. If the fee engine could not
 * price it, the card rendered "not computable" beside a confident-looking
 * string — and the row's existence marked the carpark as covered, so nothing
 * ever retried it. A bad rate was therefore permanent AND invisible.
 *
 * These pin the predicate the guard uses. It is duplicated here rather than
 * exported because the guard's value is entirely in WHICH strings it rejects.
 */
function pricesAtSomeHour(rate: string): boolean {
  return [8, 13, 20, 1].some((h) => {
    const band = bandForTime(rate, h * 60);
    return estimateMallFee(parseRate(band), 120, parseLimits(band)) !== null;
  });
}

test("rates the engine can price are accepted", () => {
  for (const good of [
    "$1.20 per half hour",
    "$2.18 for 1st hr; $1.64 per sub 30 mins",
    "8am-6pm: $1.10 per 30 mins; 6pm-8am: $1.10 per 30 mins (capped at $5.00)",
    "$1.50 per hour; Capped at $28.00",
    "1st 15 mins free, $1.00 per subsequent 30 mins",
  ]) {
    assert.equal(pricesAtSomeHour(good), true, good);
  }
});

test("prose that is not a rate is rejected before it reaches the store", () => {
  // All real strings that reached the corpus and price to null. Stored, each
  // one produced a card quoting nothing while blocking a retry.
  for (const bad of [
    "URA coupon parking",
    "Parking is available at the public car park adjacent to the temple",
    "Closed",
    "7.00am-5.59pm: No Entry (Staff Parking Only)",
  ]) {
    assert.equal(pricesAtSomeHour(bad), false, bad);
  }
});

test("a rate priced in only one band still counts as priceable", () => {
  // Reserved parking overnight is a real shape: no public rate at 1am, a
  // perfectly good one at noon. The guard must not reject it for the gap,
  // which is why it asks "some hour" rather than "every hour".
  const partial = "7.00am-10.30pm: $0.60 per 30 mins; 10.30pm-7.00am: Reserved Parking only";
  assert.equal(pricesAtSomeHour(partial), true);
  assert.equal(estimateMallFee(parseRate(bandForTime(partial, 1 * 60)), 120), null);
});
