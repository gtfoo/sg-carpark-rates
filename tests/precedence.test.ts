import { test } from "node:test";
import assert from "node:assert/strict";
import { isCodeName } from "../src/lib/sources/eps";
import { nearestOfficial } from "../src/lib/store/rates";

/**
 * The rule that stops a web lookup overwriting an official one.
 *
 * Every name below is a REAL stored row that `scripts/precedenceSweep.ts`
 * flagged on 2026-09-20 as sitting within 150 m of an `operator-site` row. That
 * is the whole point of the fixture: the obvious rule — "refuse a web rate when
 * an official row is nearby" — flags 47 of 100 stored web rows, and 46 of them
 * are correct. A mall's basement and the URA street parking outside it are
 * different car parks. Proximity cannot tell them apart and neither can source.
 *
 * The name can. A filing code names a facility an official feed files, so a web
 * row wearing one is a second copy of an official record. A building name is
 * not, however close the street row sits.
 */

/** Flagged by proximity, and every one a genuinely different car park. */
const REAL_BUILDINGS = [
  "*SCAPE",
  "Tekka Place",
  "Aperia Mall",
  "Bangkok Bank Building",
  "Chinatown Point",
  "Far Eastern Bank Building",
  "Hub Synergy Point",
  "Icon Village",
  "Marina Bay Link Mall",
  "OUE Downtown 2",
  "Raffles Hotel Singapore",
  "Robinson 77",
  "Shenton House",
  "Sim Lim Square",
  "UE Square",
  "Samsung Hub",
  "CT Hub",
  "51 Cuppage Road",
  "Frasers Tower",
  "Maxwell Chambers Suites",
  "Oxley Tower Basement Car Park",
  "CapitaSky",
  "UIC Building",
  "Alexandra Central",
  "Raffles Holland V",
  "Clarke Quay Central",
  "Amara Hotel Singapore",
  "Altez",
  "Kallang Riverside Condominium",
  "LASALLE College of the Arts (McNally Campus)",
  "JTC LaunchPad @ one-north (Block 71 Ayer Rajah Crescent)",
];

test("a building keeps its own rate however close an official row sits", () => {
  for (const n of REAL_BUILDINGS) {
    assert.ok(!isCodeName(n), `would have been refused as a filing code: ${n}`);
  }
});

test("a filing code is a second copy of an official record", () => {
  // #3459 "N0012", 61 m from NORTH BRIDGE RD MARKET OFF ST, quoting the same
  // $0.60 per 30 mins WITHOUT the $5.00 cap the official row carries — the
  // Mackenzie signature exactly.
  assert.ok(isCodeName("N0012"));
  assert.ok(isCodeName("URA_P0075"));
  assert.ok(isCodeName("CP13_CP14_CP15"));
});

test("nearestOfficial ignores everything that is not an operator's own figures", () => {
  const here = { lat: 1.3, lng: 103.85 };
  const rows = [
    { source: "web-llm", lat: 1.3, lng: 103.85 }, // on the spot, but a guess
    { source: "manual", lat: 1.3, lng: 103.85 }, // on the spot, but not official
    { source: "operator-site", lat: 1.30045, lng: 103.85 }, // ~50 m
  ];
  const hit = nearestOfficial(rows, here, 150);
  assert.ok(hit);
  assert.equal(hit.row.source, "operator-site");
  assert.ok(hit.metres > 40 && hit.metres < 60, `unexpected distance ${hit.metres}`);
});

test("nearestOfficial respects the radius and missing coordinates", () => {
  const here = { lat: 1.3, lng: 103.85 };
  // ~500 m away, well outside any radius the guard uses.
  const far = [{ source: "operator-site", lat: 1.3045, lng: 103.85 }];
  assert.equal(nearestOfficial(far, here, 150), null);

  // A row with no coordinates cannot be near anything, and must not throw.
  const nowhere = [{ source: "operator-site", lat: null, lng: null }];
  assert.equal(nearestOfficial(nowhere, here, 150), null);
});

test("the nearest official row wins, not merely the first in range", () => {
  const here = { lat: 1.3, lng: 103.85 };
  const rows = [
    { source: "operator-site", lat: 1.3009, lng: 103.85, id: "far" },
    { source: "operator-site", lat: 1.30018, lng: 103.85, id: "near" },
  ];
  const hit = nearestOfficial(rows, here, 150);
  assert.equal(hit?.row.id, "near");
});
