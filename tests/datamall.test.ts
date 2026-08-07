import { test } from "node:test";
import assert from "node:assert/strict";
import { lotsFor, commercialOnly, type CarparkLots } from "../src/lib/sources/datamall";

/**
 * DataMall shares no identifier with this app's sources, so a car park is
 * paired with its live lot count by NAME and position together. Position alone
 * was actively wrong — these pin the cases that proved it. The network call
 * needs a key and isn't exercised here.
 */

const rec = (
  development: string,
  lat: number,
  lng: number,
  availableLots = 10,
  agency = "URA",
): CarparkLots => ({ id: development, development, location: { lat, lng }, availableLots, agency });

test("HDB records are dropped before matching", () => {
  // 94% of the feed is HDB, already covered exactly by car park number from
  // data.gov.sg. Leaving them in lets a mall adopt a housing block's count.
  const feed = [rec("Blk 123", 1.3, 103.8, 5, "HDB"), rec("Paragon", 1.3039, 103.8357, 174)];
  const commercial = commercialOnly(feed);
  assert.equal(commercial.length, 1);
  assert.equal(commercial[0]!.development, "Paragon");
});

test("an exact name match is accepted at distance", () => {
  const feed = [rec("Ngee Ann City", 1.30256, 103.83488, 661)];
  const hit = lotsFor({ lat: 1.3028, lng: 103.8352 }, "Ngee Ann City", feed);
  assert.equal(hit?.availableLots, 661);
});

test("punctuation differences still count as exact", () => {
  const feed = [rec("The Atrium@Orchard", 1.3006, 103.8395, 9)];
  assert.equal(lotsFor({ lat: 1.3006, lng: 103.8395 }, "The Atrium @ Orchard", feed)?.availableLots, 9);
});

test("a longer name containing the record's name matches when close", () => {
  // DataMall says "Cineleisure"; the app says "Cathay Cineleisure Orchard".
  const feed = [rec("Cineleisure", 1.30119, 103.83737, 175)];
  assert.equal(
    lotsFor({ lat: 1.3012, lng: 103.8374 }, "Cathay Cineleisure Orchard", feed)?.availableLots,
    175,
  );
});

test("a different development nearby is never adopted", () => {
  // Each of these was a real mis-pairing when matching on distance alone.
  const feed = [
    rec("Tampines Mall", 1.3525, 103.9447, 277),
    rec("Far East Plaza", 1.3072, 103.8315, 155),
    rec("Paragon", 1.3039, 103.8357, 174),
  ];
  assert.equal(lotsFor({ lat: 1.3524, lng: 103.9439 }, "Century Square", feed), null);
  assert.equal(lotsFor({ lat: 1.3072, lng: 103.8306 }, "Grand Hyatt Singapore", feed), null);
  assert.equal(lotsFor({ lat: 1.3045, lng: 103.8331 }, "22 Bideford Road", feed), null);
});

test("a shared prefix does not pair different malls", () => {
  // "Bugis+" normalises to BUGIS, a substring of BUGISCUBE and BUGISJUNCTION —
  // different malls. Against the live feed those sit 244 m and 158 m from
  // Bugis+ while the Bugis+ car park itself is 70 m away, so a partial name
  // match only counts for a near-neighbour. Offsets below mirror those gaps.
  const bugisPlus = [rec("Bugis+", 1.29869, 103.85535, 142)];
  assert.equal(lotsFor({ lat: 1.30069, lng: 103.85535 }, "Bugis Cube", bugisPlus), null, "222m away");
  assert.equal(lotsFor({ lat: 1.30009, lng: 103.85535 }, "Bugis Junction", bugisPlus), null, "155m away");
  // The Bugis+ car park itself, well inside the partial-match radius.
  assert.equal(
    lotsFor({ lat: 1.29929, lng: 103.85535 }, "BUGIS PLUS", bugisPlus)?.availableLots,
    142,
    "67m away",
  );
});

test("the closer of two same-named records wins", () => {
  const feed = [rec("Marina Square", 1.2925, 103.8575, 5), rec("Marina Square", 1.29115, 103.85728, 1037)];
  assert.equal(lotsFor({ lat: 1.2912, lng: 103.8573 }, "Marina Square", feed)?.availableLots, 1037);
});

test("zero free lots is a real reading, not a missing one", () => {
  // 0 is falsy and easily lost to a truthiness check — "Full" must survive.
  const feed = [rec("Esplanade", 1.2899, 103.8557, 0)];
  const hit = lotsFor({ lat: 1.29, lng: 103.8557 }, "Esplanade Main Carpark", feed);
  assert.notEqual(hit, null);
  assert.equal(hit?.availableLots, 0);
});
