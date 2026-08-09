import { test } from "node:test";
import assert from "node:assert/strict";
import { displayName } from "../src/lib/sources/eps";

test("any filing code is replaced by the car park's address", () => {
  // A sweep of the inventory found thirteen of these across eight prefixes
  // beyond URA's, so the test is structural rather than a list of prefixes.
  assert.equal(displayName("CP13_CP14_CP15", "0, ARTS LINK"), "ARTS LINK");
  assert.equal(
    displayName("HDH203", "203, HENDERSON INDUSTRIAL PARK, HDH203"),
    "203 HENDERSON INDUSTRIAL PARK",
  );
  assert.equal(displayName("KU5", "3004, UBI ROAD 1, KU5"), "3004 UBI ROAD 1");
  assert.equal(displayName("M38", "38, JALAN PEMIMPIN"), "38 JALAN PEMIMPIN");
  assert.equal(displayName("T99", "9, TUAS SOUTH AVENUE 10"), "9 TUAS SOUTH AVENUE 10");
  assert.equal(
    displayName("TP57_TP59", "1003, TOA PAYOH INDUSTRIAL PARK"),
    "1003 TOA PAYOH INDUSTRIAL PARK",
  );
});

test("filing underscores inside a real name become slashes", () => {
  // The convention the HDB dataset already uses on cards: "Blk 175/183 To 185".
  assert.equal(displayName("28_30 BIDEFORD ROAD", "28, BIDEFORD ROAD"), "28/30 BIDEFORD ROAD");
  assert.equal(
    displayName("BLK 20_22_24_26_28_30 CHANGI NORTH WAY", "20, CHANGI NORTH WAY"),
    "BLK 20/22/24/26/28/30 CHANGI NORTH WAY",
  );
  assert.equal(
    displayName("ARAB_ QUEEN STREET OFF STREET", "1, ARAB STREET"),
    "ARAB / QUEEN STREET OFF STREET",
  );
  assert.equal(
    displayName("47 JALAN PEMIMPIN_ 39A JALAN PEMIMPIN", "47, JALAN PEMIMPIN"),
    "47 JALAN PEMIMPIN / 39A JALAN PEMIMPIN",
  );
  assert.equal(
    displayName("BLK 3004-3007_3014_3015 UBI ROAD 1", "3004, UBI ROAD 1"),
    "BLK 3004-3007/3014/3015 UBI ROAD 1",
  );
  // No underscore, no change — and HDB codes stay verbatim (tested above).
  assert.equal(displayName("The Cathay", "2, HANDY ROAD"), "The Cathay");
});

test("a real place name is never mistaken for a code", () => {
  // The digit requirement is what protects these — without it "AMOY ST" reads
  // as two short reference tokens and gets replaced by its address.
  assert.equal(displayName("AMOY ST", "1, AMOY STREET"), "AMOY ST");
  assert.equal(displayName("112 Katong", "112, EAST COAST ROAD"), "112 Katong");
  assert.equal(displayName("Jem", "50, JURONG GATEWAY ROAD"), "Jem");
  assert.equal(displayName("The Cathay", "2, HANDY ROAD"), "The Cathay");
});

test("a URA internal code is replaced by the car park's address", () => {
  // Reached the card as "Ura_p0075", which tells a driver nothing.
  assert.equal(
    displayName("URA_P0075", "51, LAVENDER STREET, P0075"),
    "51 LAVENDER STREET",
  );
  assert.equal(
    displayName("URA_W0029", "1, WEST COAST PARK, W0029"),
    "1 WEST COAST PARK",
  );
  // A house number of 0 is a placeholder, not an address.
  assert.equal(
    displayName("URA_T0017", "0, TIONG BAHRU ROAD, T0017"),
    "TIONG BAHRU ROAD",
  );
  // Nothing usable in the address — better the code than an empty card.
  assert.equal(displayName("URA_X0001", "X0001"), "URA_X0001");
});

test("ordinary EPS names are left alone", () => {
  assert.equal(displayName("CT HUB 2", "114, LAVENDER STREET, CT HUB 2"), "CT HUB 2");
  // HDB codes stay as they are — they're excluded from search entirely, and
  // the HDB dataset owns those car parks under a readable name.
  assert.equal(displayName("HDB_J4_J5", "BLK 201, JURONG EAST ST 21"), "HDB_J4_J5");
  // The CapitaLand " - C" tier suffix is still trimmed.
  assert.equal(displayName("Plaza Singapura - C", "68, ORCHARD ROAD"), "Plaza Singapura");
});
