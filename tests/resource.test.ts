import { test } from "node:test";
import assert from "node:assert/strict";
import { matchByName, type DatasetRow } from "../scripts/resourceLtaRates";

const rec = (carpark: string): DatasetRow => ({
  carpark,
  weekdays_rate_1: "$1 per 30 mins",
  weekdays_rate_2: "",
  saturday_rate: "",
  sunday_publicholiday_rate: "",
});

const RECORDS = [
  rec("Concorde Hotel"),
  rec("Delfi Orchard"),
  rec("Jem"),
  rec("Marina Square Shopping Mall"),
  rec("The Cathay"),
];

test("an exact name wins, ignoring case and punctuation", () => {
  assert.equal(matchByName(["CONCORDE HOTEL"], RECORDS)?.carpark, "Concorde Hotel");
  assert.equal(matchByName(["delfi  orchard"], RECORDS)?.carpark, "Delfi Orchard");
  assert.equal(matchByName(["The Cathay!"], RECORDS)?.carpark, "The Cathay");
});

test("the display name is tried before the match value", () => {
  // Rates are often filed under a scraped name while showing a tidier one.
  assert.equal(
    matchByName(["Delfi Orchard", "SOMETHING ELSE"], RECORDS)?.carpark,
    "Delfi Orchard",
  );
});

test("a loose match needs enough name to mean something", () => {
  // "Marina Square" is inside "Marina Square Shopping Mall" — same car park.
  assert.equal(
    matchByName(["Marina Square"], RECORDS)?.carpark,
    "Marina Square Shopping Mall",
  );
  // "Jem" must NOT match by containment: three letters appear inside all sorts
  // of names, and a wrong match here silently rewrites a car park's prices.
  assert.equal(matchByName(["Jembatan Merah"], RECORDS.filter((r) => r.carpark === "Jem")), null);
});

test("no match returns null rather than a guess", () => {
  assert.equal(matchByName(["Mount Elizabeth Hospital"], RECORDS), null);
  assert.equal(matchByName([null, undefined, ""], RECORDS), null);
});
