/**
 * Finds car parks stored more than once — rows sitting on top of each other,
 * and what they disagree about.
 *
 *   npx tsx scripts/duplicateSweep.ts
 *   npx tsx scripts/duplicateSweep.ts --metres 80
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

function main() {
  const arg = process.argv.indexOf("--metres");
  const radius = arg > -1 ? Number(process.argv[arg + 1]) : 60;

  const rows = getDb()
    .prepare(
      `SELECT id, match_type, match_value, display_name, source, verified_at, lat, lng, weekday_rate
         FROM rate_overrides
        WHERE lat IS NOT NULL AND lng IS NOT NULL
        ORDER BY id`,
    )
    .all() as Row[];

  console.log(`${rows.length} row(s) with coordinates; clustering within ${radius} m\n`);

  const seen = new Set<number>();
  let clusters = 0;
  let disagreeing = 0;

  for (const a of rows) {
    if (seen.has(a.id)) continue;
    const group = rows.filter(
      (b) =>
        !seen.has(b.id) &&
        haversineMetres({ lat: a.lat!, lng: a.lng! }, { lat: b.lat!, lng: b.lng! }) <= radius,
    );
    if (group.length < 2) continue;
    for (const g of group) seen.add(g.id);
    clusters++;

    // Same prices at every probe means the duplicate is untidy, not harmful.
    const priced = new Set(group.map((g) => fees(g.weekday_rate)));
    const harmful = priced.size > 1;
    if (harmful) disagreeing++;

    console.log(`  ${harmful ? "DISAGREE" : "same    "}  ${group.length} rows within ${radius} m`);
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

  console.log(`  clusters: ${clusters}   of which the prices DISAGREE: ${disagreeing}`);
  console.log(`\n  Nothing is changed by this script. Which row is right needs the`);
  console.log(`  operator's page — picking by rule would have chosen the nonsense`);
  console.log(`  row at Mackenzie Road, which was also the newest.`);
}

main();
