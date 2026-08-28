import { test } from "node:test";
import assert from "node:assert/strict";
import { overlappingOverride, SAME_PLACE_M } from "../src/lib/store/rates";

/**
 * One car park, one row.
 *
 * `upsertOverride` keys on (match_type, match_value), so a car park is
 * identified by a NAME when it is really a PLACE. Oxley Tower was saved twice
 * on the same day from the same geocode — "OXLEYTOWER" charging $3.50 at 7pm
 * and "OXLEYTOWERBASEMENTCARPARK" charging $15.00, because the second lost its
 * time bands. Three duplicates arrived this way in a week.
 */

const OXLEY = { lat: 1.27870608494088, lng: 103.848418970551 };

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  match_type: "name",
  match_value: "OXLEYTOWER",
  lat: OXLEY.lat,
  lng: OXLEY.lng,
  ...over,
});

test("a second name for the same point is refused", () => {
  const hit = overlappingOverride([row()], OXLEY, {
    matchType: "name",
    matchValue: "Oxley Tower Basement Car Park",
  });
  assert.equal(hit?.match_value, "OXLEYTOWER");
});

test("updating the row that already holds the key is not a clash", () => {
  // The same key is an UPDATE, which is the mechanism working. Note the input
  // is raw text: match_value is normalised at write time, so the comparison
  // has to normalise too or every update looks like a duplicate.
  assert.equal(
    overlappingOverride([row()], OXLEY, { matchType: "name", matchValue: "Oxley Tower" }),
    null,
  );
});

test("a postal key does not collide with a name key at the same point", () => {
  // It should: they are the same car park. This is exactly how MOE (Evans
  // Road) gained #3409 beside #3404 — a forced re-lookup that resolved a
  // postal wrote under a different key.
  const hit = overlappingOverride([row()], OXLEY, {
    matchType: "postal",
    matchValue: "068906",
  });
  assert.equal(hit?.match_value, "OXLEYTOWER");
});

test("a genuinely different car park nearby is left alone", () => {
  // 313@Somerset and Pan Pacific Suites sit within 60 m of each other and are
  // not the same place. A radius that catches them would refuse real rates, so
  // the threshold is small enough to mean "written from the same geocode".
  const nearby = { lat: OXLEY.lat + 0.0005, lng: OXLEY.lng }; // ~55 m
  assert.equal(
    overlappingOverride([row()], nearby, { matchType: "name", matchValue: "Somewhere Else" }),
    null,
  );
  assert.ok(SAME_PLACE_M < 60, "must not reach a next-door car park");
});

test("rows with no coordinates cannot clash", () => {
  // Two of 55 AI-retrieved rows have no point. Absent data is not evidence of
  // a duplicate, and refusing on it would block rates we can still price.
  assert.equal(
    overlappingOverride([row({ lat: null, lng: null })], OXLEY, {
      matchType: "name",
      matchValue: "Anything",
    }),
    null,
  );
});
