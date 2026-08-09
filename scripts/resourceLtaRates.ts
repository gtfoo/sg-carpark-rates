/**
 * Re-sources the scraped OneMotoring rates from LTA's open dataset.
 *
 *   npm run resource-lta -- --dry
 *   npm run resource-lta
 *
 * WHY: the stored rows were scraped from onemotoring.lta.gov.sg, whose terms
 * say its contents "shall not be reproduced, republished ... or otherwise
 * distributed in any way, without the prior written permission of LTA". We
 * reproduce them into a database and serve them to users, and the importer got
 * past a 403 by sending a browser user-agent. The same car parks are published
 * on data.gov.sg under the Singapore Open Data Licence, which permits reuse.
 *
 * WHAT IT KEEPS: only the rate text comes from the dataset. The coordinates
 * stay, because they are ours — geocoded from OneMap, not taken from LTA — and
 * without them these car parks stop appearing as nearby cards and show only
 * when searched by name.
 *
 * WHAT IT COSTS: the dataset stopped being updated in June 2024 while the
 * scraped page was revised in April 2026, so amounts drift. In exchange the
 * dataset carries the evening bands the scrape lacked, which now work. Rows are
 * dated to the dataset's own last-updated date, so the staleness report tells
 * the truth about them rather than flattering them.
 *
 * Rows with no match in the dataset are left exactly as they are; there is no
 * licensed substitute for those, and deleting them would just lose the car park.
 */
import { fetchAllRecords, fetchDatasetLastUpdated } from "../src/lib/sources/datagov";
import {
  joinWeekdayBands,
  bandForTime,
  parseRate,
  parseLimits,
  estimateMallFee,
} from "../src/lib/sources/mallRates";

const DATASET = "d_9f6056bdb6b1dfba57f063593e4f34ae";
const DATASET_URL = `https://data.gov.sg/datasets/${DATASET}/view`;

export interface DatasetRow {
  carpark: string;
  weekdays_rate_1: string;
  weekdays_rate_2: string;
  saturday_rate: string;
  sunday_publicholiday_rate: string;
}

const norm = (s: string | null | undefined): string =>
  String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Finds the dataset record for a stored car park.
 *
 * Exact on the normalised name first. Only then a containment test, and only
 * for names long enough to mean something — "JEM" inside "JEMBATAN" is the kind
 * of match that silently rewrites the wrong car park's prices.
 */
export function matchByName(
  names: (string | null | undefined)[],
  records: DatasetRow[],
): DatasetRow | null {
  const keys = names.map(norm).filter(Boolean);
  for (const k of keys) {
    const hit = records.find((r) => norm(r.carpark) === k);
    if (hit) return hit;
  }
  const MIN_LOOSE = 8;
  for (const k of keys) {
    if (k.length < MIN_LOOSE) continue;
    const hit = records.find((r) => {
      const n = norm(r.carpark);
      return n.length >= MIN_LOOSE && (n.includes(k) || k.includes(n));
    });
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const dry = process.argv.includes("--dry");
  const records = await fetchAllRecords<DatasetRow>(DATASET);
  const dated = (await fetchDatasetLastUpdated(DATASET)) ?? null;
  console.log(`open dataset: ${records.length} records, last updated ${dated ?? "unknown"}`);
  if (!dated) {
    console.error("Refusing to run: without the dataset's own date these rows would be undated.");
    process.exit(1);
  }

  const { getDb } = await import("../src/lib/db");
  const { upsertOverride } = await import("../src/lib/store/rates");

  const rows = getDb()
    .prepare(
      `SELECT id, match_type, match_value, display_name, lat, lng, notes, weekday_rate
         FROM rate_overrides
        WHERE source_url LIKE 'https://onemotoring.lta.gov.sg/%'`,
    )
    .all() as {
    id: number;
    match_type: string;
    match_value: string;
    display_name: string | null;
    lat: number | null;
    lng: number | null;
    notes: string | null;
    weekday_rate: string | null;
  }[];
  console.log(`scraped rows to re-source: ${rows.length}\n`);

  /** Arrival hours to price each rate at, so a band change can't hide. */
  const HOURS = [9, 13, 19, 23];
  const price = (text: string, h: number): number | null => {
    const band = bandForTime(text, h * 60);
    return estimateMallFee(parseRate(band), 120, parseLimits(band));
  };
  const impact = {
    same: 0,
    moved: 0,
    gained: 0,
    lost: [] as { name: string; before: (number | null)[]; after: (number | null)[] }[],
  };

  let replaced = 0;
  let unmatched = 0;
  for (const row of rows) {
    const hit = matchByName([row.display_name, row.match_value], records);
    if (!hit) {
      unmatched++;
      continue;
    }
    const weekday = joinWeekdayBands(hit.weekdays_rate_1, hit.weekdays_rate_2);
    if (!weekday) {
      unmatched++;
      continue;
    }
    replaced++;
    if (dry) {
      // What this actually does to the price is the only thing that matters.
      // The dataset is older but band-richer, so both directions are possible
      // and a row that stops pricing altogether must not slip through.
      const before = HOURS.map((h) => price(row.weekday_rate ?? "", h));
      const after = HOURS.map((h) => price(weekday, h));
      const lost = before.some((b, i) => b !== null && after[i] === null);
      const gained = before.some((b, i) => b === null && after[i] !== null);
      const moved = before.some(
        (b, i) => b !== null && after[i] !== null && Math.abs(b - after[i]!) > 0.005,
      );
      if (lost) impact.lost.push({ name: row.display_name ?? row.match_value, before, after });
      else if (gained) impact.gained++;
      if (moved) impact.moved++;
      if (!lost && !gained && !moved) impact.same++;
      continue;
    }
    upsertOverride({
      matchType: row.match_type as "name" | "postal",
      matchValue: row.match_value,
      displayName: row.display_name,
      weekdayRate: weekday,
      saturdayRate: hit.saturday_rate?.trim() || null,
      sundayPhRate: hit.sunday_publicholiday_rate?.trim() || null,
      source: "operator-site",
      sourceUrl: DATASET_URL,
      verifiedAt: dated,
      notes:
        "From LTA's open carpark rates dataset on data.gov.sg " +
        "(Singapore Open Data Licence). Verify before relying on it.",
      lat: row.lat,
      lng: row.lng,
    });
  }

  console.log(`\n  re-sourced from the open dataset : ${replaced}`);
  console.log(`  left as they are, no match       : ${unmatched}`);

  if (dry) {
    const f = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);
    console.log(`\n  priced at ${HOURS.map((h) => `${h}:00`).join("/")}:`);
    console.log(`    identical               : ${impact.same}`);
    console.log(`    price moves             : ${impact.moved}`);
    console.log(`    newly priceable         : ${impact.gained}`);
    console.log(`    STOPS pricing at an hour: ${impact.lost.length}`);
    for (const l of impact.lost.slice(0, 12)) {
      console.log(
        `      ${l.name.slice(0, 34).padEnd(35)} ${l.before.map(f).join(" ")}  ->  ${l.after.map(f).join(" ")}`,
      );
    }
    console.log("\n--dry: nothing written.");
  }
}

if (process.argv[1] && process.argv[1].endsWith("resourceLtaRates.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
