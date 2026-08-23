import { test } from "node:test";
import assert from "node:assert/strict";
import { allEpsCarparks } from "../src/lib/sources/eps";

/**
 * EPS files some car parks under an internal code. `displayName()` rewrites the
 * ones carrying a digit; a purely alphabetic code slips through and reaches a
 * card as written — "TLF", "KBIB", "CP13_CP14_CP15".
 *
 * These pin the generated alias file (`scripts/epsNameFix.ts`), because its
 * value is entirely in WHICH names it changes and which it leaves alone.
 */

const nameOf = (needle: string) =>
  allEpsCarparks.find((c) => c.address.toUpperCase().includes(needle))?.name;

test("an opaque code becomes the site that stands at its postal", () => {
  // 1 Cluny Road / 259569 is the Botanic Gardens. The ADDRESS could not have
  // fixed this — it just repeats the code back.
  assert.equal(nameOf("CLUNY ROAD, TLF"), "SINGAPORE BOTANIC GARDENS");
  assert.equal(nameOf("JALAN PEMIMPIN, KONG BENG"), "KONG BENG INDUSTRIAL BUILDING");
});

test("real names that merely look like acronyms are left alone", () => {
  // The postal agreeing with the existing name is the check working, not the
  // check failing to fire.
  for (const [addr, expected] of [
    ["JURONG GATEWAY RD, SINGAPORE 608549", "JEM"],
    ["SERANGOON CENTRAL, #04-01, NEX", "NEX"],
  ] as const) {
    assert.equal(nameOf(addr), expected, addr);
  }
});

test("a postal that answers with an address does not overwrite a name", () => {
  // "NKF" resolves to "500 CORPORATION ROAD SINGAPORE 649808" — longer, and it
  // throws away the only identity the row had.
  assert.equal(nameOf("CORPORATION ROAD, NKF"), "NKF");
  assert.equal(nameOf("HYDERABAD ROAD"), "HORT PARK");
});

test("the three renames rejected on review stayed rejected", () => {
  // Each was wrong in a way no heuristic here separates from the good ones —
  // "CCK CHOA CHU KANG PARK" shares three words with the WRONG answer, while
  // "TLF" shares none with the right one.
  assert.equal(nameOf("HAMPSHIRE ROAD"), "HSO CAR PARK");
  assert.equal(nameOf("CHOA CHU KANG DRIVE, CCK"), "CCK CHOA CHU KANG PARK");
  assert.equal(nameOf("GOPENG STREET, ICON"), "THE ICON");
});

test("no alias is blank or an address", () => {
  for (const c of allEpsCarparks) {
    assert.ok(c.name.trim().length > 0, `empty name for ${c.id}`);
    assert.ok(!/\bSINGAPORE\s+\d{6}\b/i.test(c.name), `address as name: ${c.name}`);
  }
});
