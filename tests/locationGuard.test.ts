import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLocation, MAX_LOCATION_MISMATCH_M } from "../src/lib/geo";

/**
 * The write-time location guard.
 *
 * Two rates were saved against the wrong building on 2026-08-23, both because
 * a similarly-named carpark outranked the right one in the search results.
 * Real coordinates are used throughout — the point of these is that the guard
 * separates the ACTUAL populations, not synthetic ones.
 */

const MOE_EVANS = { lat: 1.318506, lng: 103.81907 }; // 21 Evans Road, S259366
const MOE_BUONA_VISTA = { lat: 1.305419, lng: 103.7906 }; // 1 Nth Buona Vista Dr
const MIDVIEW_CITY = { lat: 1.359021, lng: 103.833761 }; // 24 Sin Ming Lane
const MIDVIEW_BUILDING = { lat: 1.34941, lng: 103.7492 }; // 50 Bukit Batok St 23

test("the two real wrong-building saves are both caught", () => {
  const moe = checkLocation(MOE_EVANS, MOE_BUONA_VISTA);
  assert.equal(moe.ok, false);
  assert.ok(moe.ok === false && moe.metres > 3000, `MOE gap was ${JSON.stringify(moe)}`);

  const midview = checkLocation(MIDVIEW_BUILDING, MIDVIEW_CITY);
  assert.equal(midview.ok, false);
});

test("the widest HONEST disagreement still passes", () => {
  // Singapore Turf Club, 390 m — the largest gap across 46 correct rows
  // between a stored point and the geocode of its own name. If the threshold
  // ever drops below this, real rates start being refused.
  const a = { lat: 1.3, lng: 103.8 };
  const b = { lat: 1.3, lng: 103.80351 }; // ~390 m east
  const v = checkLocation(a, b);
  assert.equal(v.ok, true);
  assert.ok(v.ok === true && v.reason === "verified");
  assert.ok(MAX_LOCATION_MISMATCH_M > 500, "threshold must clear the observed honest maximum");
});

test("missing data is never treated as a mismatch", () => {
  // The guard fires only on positive contradiction. Two of 55 rows have no
  // stored point at all, and the model often cannot find an address. Refusing
  // those would reject good rates and spend a lookup on each.
  for (const [q, f] of [
    [null, MOE_EVANS],
    [MOE_EVANS, null],
    [null, null],
    [undefined, undefined],
  ] as const) {
    const v = checkLocation(q, f);
    assert.equal(v.ok, true);
    assert.ok(v.ok === true && v.reason === "unverifiable");
  }
});

test("the same building from two sources agrees", () => {
  const v = checkLocation(MOE_EVANS, { lat: 1.3185, lng: 103.8191 });
  assert.ok(v.ok === true && v.reason === "verified" && v.metres < 50);
});

test("the boundary is inclusive, so exactly-at-threshold is allowed", () => {
  // ~1000 m north. A rate sitting exactly on the line is not evidence of
  // anything, and rejecting it would make the threshold effectively tighter
  // than the measurement that justified it.
  const v = checkLocation({ lat: 1.3, lng: 103.8 }, { lat: 1.308993, lng: 103.8 });
  assert.equal(v.ok, true);
});
