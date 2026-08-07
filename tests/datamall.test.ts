import { test } from "node:test";
import assert from "node:assert/strict";
import { lotsFor, type CarparkLots } from "../src/lib/sources/datamall";

/**
 * DataMall records carry no identifier we already hold, so a car park is
 * matched to its live lot count by position. These pin that matching — the
 * network call itself needs a key and isn't exercised here.
 */

const at = (id: string, lat: number, lng: number, availableLots = 10): CarparkLots => ({
  id,
  development: id,
  location: { lat, lng },
  availableLots,
  agency: "URA",
});

// Two real neighbours ~250 m apart in Tiong Bahru.
const SENG_POH = { lat: 1.2837, lng: 103.8316 };
const ENG_HOON = { lat: 1.2818, lng: 103.8305 };

test("matches the nearest record within range", () => {
  const feed = [at("far", 1.3, 103.9), at("here", 1.28372, 103.83158, 42)];
  assert.equal(lotsFor(SENG_POH, feed)?.id, "here");
  assert.equal(lotsFor(SENG_POH, feed)?.availableLots, 42);
});

test("a car park with no record nearby stays unmatched", () => {
  // Everything in the feed is on the other side of the island.
  const feed = [at("tampines", 1.3496, 103.9568), at("jurong", 1.3329, 103.7436)];
  assert.equal(lotsFor(SENG_POH, feed), null);
});

test("does not borrow a neighbour's count", () => {
  // Only Eng Hoon is in the feed; Seng Poh must not adopt it at ~250 m.
  const feed = [at("eng-hoon", ENG_HOON.lat, ENG_HOON.lng, 99)];
  assert.equal(lotsFor(SENG_POH, feed), null);
  assert.equal(lotsFor(ENG_HOON, feed)?.id, "eng-hoon");
});

test("picks the closer of two candidates", () => {
  const feed = [
    at("100m", 1.28460, 103.8316, 5),
    at("20m", 1.28388, 103.8316, 7),
  ];
  assert.equal(lotsFor(SENG_POH, feed)?.id, "20m");
});

test("zero free lots is a real reading, not a missing one", () => {
  // "Full" must survive: 0 is falsy and easily lost to a truthiness check.
  const feed = [at("full", 1.28372, 103.83158, 0)];
  const hit = lotsFor(SENG_POH, feed);
  assert.equal(hit?.availableLots, 0);
  assert.notEqual(hit, null);
});
