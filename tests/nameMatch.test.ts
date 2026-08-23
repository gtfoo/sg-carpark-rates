import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseNameMatch } from "../src/lib/store/rates";

/**
 * Name matching for stored rates.
 *
 * A bidirectional substring test let a row stored as "MOE" answer for every
 * MOE-prefixed destination in Singapore. Asking about MOE HQ at Evans Road
 * returned MOE Building's rates from Buona Vista, 3.5 km away — and since that
 * counted as "already covered", no lookup was ever spent finding the real ones.
 */

const MOE_BUONA_VISTA = { match_value: "MOE", lat: 1.305419, lng: 103.7906 };
const EVANS = { lat: 1.318506, lng: 103.81907 }; // 21 Evans Road

test("a short stored name no longer captures a distant destination", () => {
  assert.equal(chooseNameMatch([MOE_BUONA_VISTA], "MOEHQEVANSROAD", EVANS), null);
});

test("the same short name still answers for its own building", () => {
  const at = { lat: 1.3051, lng: 103.7909 };
  assert.equal(chooseNameMatch([MOE_BUONA_VISTA], "MOEBUILDING", at), MOE_BUONA_VISTA);
});

test("with no coordinates to judge by, the match is kept", () => {
  // The rule must not start refusing what it merely cannot check: two of 55
  // rows have no point at all.
  assert.equal(chooseNameMatch([MOE_BUONA_VISTA], "MOEHQEVANSROAD", null), MOE_BUONA_VISTA);
  const coordless = { match_value: "MOE", lat: null, lng: null };
  assert.equal(chooseNameMatch([coordless], "MOEHQEVANSROAD", EVANS), coordless);
});

test("an exact match wins without needing corroboration", () => {
  // Deliberately given coordinates that would fail the distance test: an exact
  // normalized name is not a guess, and a bad geocode must not override it.
  const exact = { match_value: "MOEHQEVANSROAD", lat: 1.0, lng: 103.0 };
  assert.equal(chooseNameMatch([exact, MOE_BUONA_VISTA], "MOEHQEVANSROAD", EVANS), exact);
});

test("the nearest candidate wins when several match", () => {
  const near = { match_value: "JURONGPOINT", lat: 1.3399, lng: 103.7062 };
  const far = { match_value: "JURONGPOINTEXTENSION", lat: 1.4, lng: 103.9 };
  const at = { lat: 1.34, lng: 103.706 };
  assert.equal(chooseNameMatch([far, near], "JURONGPOINTSHOPPINGCENTRE", at), near);
});

test("without coordinates the most specific name wins, not the first row", () => {
  const short = { match_value: "MOE", lat: null, lng: null };
  const full = { match_value: "MOEHQEVANSROADCARPARK", lat: null, lng: null };
  assert.equal(chooseNameMatch([short, full], "MOEHQEVANSROAD", null), full);
});

test("a too-short query still matches nothing", () => {
  assert.equal(chooseNameMatch([MOE_BUONA_VISTA], "MOE", EVANS), null);
});
