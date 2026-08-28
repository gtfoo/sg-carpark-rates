/**
 * Finds car parks stored more than once — rows sitting on top of each other,
 * and what they disagree about.
 *
 *   npx tsx scripts/duplicateSweep.ts
 *
 * `locationSweep.ts` asks the opposite question: which rows cite one source
 * while sitting far apart. This is the mirror, and it is the one that keeps
 * catching real damage — three times in a week:
 *
 *   Midview     two rows, 13 km apart, one holding the other's rates
 *   Mackenzie   two web rows duplicating three official URA rows, one of them
 *               carrying "$5.00 per 510 mins", which is not a rate
 *   Oxley       two rows at the SAME coordinates, $3.50 and $15.00 at 7pm,
 *               because the second lost its time bands to the notes field
 *
 * Nothing prevents this. `upsertOverride` keys on (match_type, match_value), so
 * "OXLEYTOWER" and "OXLEYTOWERBASEMENTCARPARK" are two different rows for one
 * basement, and a forced re-lookup that resolves a postal writes a third. The
 * key is a name; the car park is a place.
 *
 * Reports only. Which row is right needs the operator's page, and picking by
 * rule — newest, longest, most bands — would have chosen wrongly at Mackenzie,
 * where the newest row was the nonsense one.
 */
import { getDb } from "../src/lib/db";
import { haversineMetres } from "../src/lib/geo";
import { parseRate, bandForTime, estimateMallFee, parseLimits } from "../src/lib/sources/mallRates";

type Row = {
  id: number;
  match_type: string;
  match_value: string;
  display_name: string | null;
  source: string;
  verified_at: string | null;
  lat: number | null;
  lng: number | null;
  weekday_rate: string | null;
};

/** What a driver would be charged for two hours, at three arrival times. */
function fees(rate: string | null): string {
  if (!rate) return "no rate";
  return [8, 13, 20]
    .map((h) => {
      const band = bandForTime(rate, h * 60);
      const f = estimateMallFee(parseRate(band), 120, parseLimits(band));
      return f === null ? "—" : "$" + f.toFixed(2);
    })
    .join(" / ");
}

/** Names differing only in case, spacing or punctuation are the same name. */
const nameKey = (s: string | null) =>
  (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function main() {
  // Two signals, both narrow on purpose.
  //
  // A radius does NOT work. The first run of this used 60 m and reported eight
  // disagreeing clusters along Orchard Road — 313@Somerset against Pan Pacific
  // Suites, Cathay Cineleisure against Mandarin Gallery, Liat Towers against
  // Wheelock Place. Every one is a genuinely different car park that happens to
  // be next door, and different rates are the correct answer. In a dense
  // shopping belt, proximity says almost nothing.
  //
  // What does hold up: rows at the SAME point (Oxley's two share their
  // coordinates to the last digit, because the second was written from the
  // first's geocode), and rows under the same NAME. Midview's pair was 13 km
  // apart and only the name caught it.
  const rows = getDb()
    .prepare(
      `SELECT id, match_type, match_value, display_name, source, verified_at, lat, lng, weekday_rate
         FROM rate_overrides
        ORDER BY id`,
    )
    .all() as Row[];

  const groups = new Map<string, Row[]>();
  const add = (k: string, r: Row) => {
    const g = groups.get(k);
    if (g) { if (!g.some((x) => x.id === r.id)) g.push(r); }
    else groups.set(k, [r]);
  };

  for (const r of rows) {
    if (r.lat !== null && r.lng !== null) {
      // ~1 m. Rounding rather than a radius: this asks "written from the same
      // point", not "near each other".
      add(`at:${r.lat.toFixed(5)},${r.lng.toFixed(5)}`, r);
    }
    const n = nameKey(r.display_name);
    if (n) add(`name:${n}`, r);
  }

  let clusters = 0;
  let disagreeing = 0;
  const reported = new Set<string>();

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    // A pair caught by both signals should be printed once.
    const sig = group.map((g) => g.id).sort((a, b) => a - b).join(",");
    if (reported.has(sig)) continue;
    reported.add(sig);
    clusters++;

    const priced = new Set(group.map((g) => fees(g.weekday_rate)));
    const harmful = priced.size > 1;
    if (harmful) disagreeing++;

    console.log(`  ${harmful ? "DISAGREE" : "same    "}  ${group.length} rows  (${key.startsWith("at:") ? "same point" : "same name"})`);
    for (const g of group) {
      console.log(
        `      #${String(g.id).padEnd(5)} [${g.source.padEnd(13)}] ${String(g.display_name).slice(0, 34).padEnd(36)} ${g.verified_at ?? "-"}`,
      );
      console.log(`             key=${g.match_type}=${g.match_value}`);
      console.log(`             8am/1pm/8pm 2h: ${fees(g.weekday_rate)}`);
      console.log(`             ${String(g.weekday_rate ?? "-").slice(0, 96)}`);
    }
    console.log("");
  }

  console.log(`  ${rows.length} rows -> ${clusters} duplicate cluster(s), of which the prices DISAGREE: ${disagreeing}`);
  console.log(`\n  Nothing is changed by this script. Which row is right needs the`);
  console.log(`  operator's page — picking by rule would have chosen the nonsense`);
  console.log(`  row at Mackenzie Road, which was also the newest.`);
}

main();
