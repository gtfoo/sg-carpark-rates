import { test } from "node:test";
import assert from "node:assert/strict";
import { searchTermFor } from "../src/lib/onemap";

/**
 * OneMap's search is fuzzy, and for some names a different building outranks
 * the one you asked for. Three confirmed on 2026-08-28:
 *
 *   "Changi General Hospital" -> CGH BUILDING, 131 Killiney Road. An unrelated
 *                                building named after the hospital's acronym,
 *                                13 km from the hospital in Simei. A stored
 *                                rate had already inherited those coordinates.
 *   "The Mill"                -> THE RITZ-CARLTON, MILLENIA SINGAPORE, because
 *                                Millenia begins with Mill. 5.7 km off, and
 *                                again a stored rate had taken its point.
 *   "Tekka Market & Food..."  -> nothing, even after the ampersand retry.
 */

test("a name OneMap answers wrongly is swapped for something unambiguous", () => {
  assert.equal(searchTermFor("Changi General Hospital"), "529889");
  assert.equal(searchTermFor("The Mill"), "159405");
});

test("a name is used where the place has no postal of its own", () => {
  // TEKKA MARKET carries postal "NIL", so the alias points at the adjacent
  // indexed name rather than a code that does not exist.
  assert.equal(searchTermFor("TEKKA MARKET & FOOD CENTRE"), "ZHUJIAO CENTRE");
});

test("matching ignores case and spacing, since a user types neither reliably", () => {
  assert.equal(searchTermFor("  changi   general hospital "), "529889");
  assert.equal(searchTermFor("the mill"), "159405");
});

test("everything else passes through untouched", () => {
  // The list is curated one entry at a time. Anything not on it must reach
  // OneMap exactly as typed — this is a veto on three known-bad answers, not a
  // rewriting layer.
  for (const q of ["Tiong Bahru Market", "313@Somerset", "5 Jalan Kilang", ""]) {
    assert.equal(searchTermFor(q), q);
  }
});
