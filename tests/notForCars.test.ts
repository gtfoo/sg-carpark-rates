import { test } from "node:test";
import assert from "node:assert/strict";
import { isNotForCars } from "../src/lib/notForCars";
import { publicEpsCarparks } from "../src/lib/sources/eps";

/**
 * The EPS inventory and the saved-rate list each had their own copy of this
 * test and the two had drifted apart in BOTH directions — eps.ts knew about
 * loading bays and coach stands but not HVP, search.ts knew HVP but neither of
 * the others. The cases below are grouped by which copy used to miss them, so
 * a future split reintroduces a named failure rather than a silent one.
 */

test("cases the EPS copy used to miss", () => {
  // URA files heavy vehicle parks this way; the EPS inventory surfaced them.
  assert.ok(isNotForCars("URA / FOREST HILL HVP"));
  assert.ok(isNotForCars("BENDEMEER RD HVP"));
});

test("cases the saved-rate copy used to miss", () => {
  // A saved rate named like any of these would have been listed as parking.
  assert.ok(isNotForCars("GOLDEN MILE TOWER LOADING BAY"));
  assert.ok(isNotForCars("ASCENT / LOADING BAY"));
  assert.ok(isNotForCars("THE STAR (LOADING AND UNLOADING BAY)"));
  assert.ok(isNotForCars("CHANGI AIRPORT TERMINAL 2 COACH STAND"));
  assert.ok(isNotForCars("SOME CONTAINER DEPOT"));
});

test("cases both copies already caught", () => {
  assert.ok(isNotForCars("TUAS HEAVY VEHICLE PARK"));
  assert.ok(isNotForCars("HEAVY-VEHICLE PARK"));
  assert.ok(isNotForCars("JURONG LORRY PARK"));
});

test("ordinary car parks are not swept up", () => {
  // "HV" alone is deliberately unmatched — two letters is too short to be safe
  // inside an ordinary name, which is what these guard.
  for (const n of [
    "HARBOURFRONT CENTRE",
    "HV JEWEL", // begins with the two letters that are NOT the rule
    "GOLDEN MILE TOWER", // the building, not its bay
    "GOLDEN MILE COMPLEX",
    "Havelock2",
    "CT HUB 2",
    "112 Katong",
    "AMOY ST",
  ]) {
    assert.ok(!isNotForCars(n), `swept up an ordinary car park: ${n}`);
  }
});

test("the shared rule is what the EPS inventory actually applies", () => {
  // Guards against the predicate being unified in name only while a source
  // keeps filtering on something else.
  for (const c of publicEpsCarparks) {
    assert.ok(!isNotForCars(c.name), `surfaced despite the rule: ${c.name}`);
  }
});
