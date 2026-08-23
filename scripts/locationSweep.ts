/**
 * Finds rates that may belong to a DIFFERENT carpark from the one they are
 * filed under.
 *
 *   npx tsx scripts/locationSweep.ts
 *
 * `checkLocation` stops new ones at write time by comparing the queried point
 * with the geocode of the address the source states. That address was never
 * stored, so it cannot be replayed over rows already written — this looks for
 * the evidence those rows DO carry.
 *
 * ## Why the obvious retrospective check does not work
 *
 * The tempting one is: geocode each row's display_name and compare it with the
 * row's stored point. Run over the corpus it finds nothing — median 0 m, max
 * 390 m — INCLUDING the known-bad MOE (Evans Road) row. That row was named
 * correctly and geocoded correctly; only its RATES came from a building 3.5 km
 * away. A check that passes the very row it was written to catch is worthless,
 * so it is not what this does. (It is still run below, because a name that
 * disagrees with its own coordinates would be a different, real defect.)
 *
 * ## What actually betrays it
 *
 * A shared source_url. MOE (Evans Road) and Ministry of Education Building
 * cite the identical motorist.sg page and sit 3.5 km apart. One page cannot be
 * the authority for two carparks that far from each other, so at least one of
 * them is wrong. That is a claim about the DATA, not about whether a website
 * happens to answer us today.
 *
 * Sharing a URL is not by itself a fault: an operator's single rates page
 * legitimately covers several nearby carparks. Distance is what turns it into
 * a finding, which is why both conditions are required.
 */
import { getDb } from "../src/lib/db";
import { geocode } from "../src/lib/onemap";
import { haversineMetres, checkLocation, MAX_LOCATION_MISMATCH_M } from "../src/lib/geo";

type Row = {
  id: number;
  name: string;
  match_value: string;
  source: string;
  source_url: string | null;
  lat: number | null;
  lng: number | null;
  weekday_rate: string | null;
};

async function main() {
  const rows = getDb()
    .prepare(
      `SELECT id, display_name AS name, match_value, source, source_url, lat, lng, weekday_rate
         FROM rate_overrides
        WHERE source = 'web-llm'
        ORDER BY id`,
    )
    .all() as Row[];

  console.log(`${rows.length} AI-retrieved row(s)\n`);

  // ---- 1. the check that works: one citation, two distant carparks ----
  const byUrl = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.source_url || r.lat == null || r.lng == null) continue;
    const list = byUrl.get(r.source_url);
    if (list) list.push(r);
    else byUrl.set(r.source_url, [r]);
  }

  let found = 0;
  console.log("  --- one source_url cited by carparks far apart ---");
  for (const [url, group] of byUrl) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const m = Math.round(
          haversineMetres({ lat: a.lat!, lng: a.lng! }, { lat: b.lat!, lng: b.lng! }),
        );
        if (m <= MAX_LOCATION_MISMATCH_M) continue;
        found++;
        console.log(`  ${(m / 1000).toFixed(1)} km apart, same citation:`);
        console.log(`      #${a.id} ${a.name}`);
        console.log(`      #${b.id} ${b.name}`);
        console.log(`      ${url}`);
        console.log(`      rates identical: ${a.weekday_rate === b.weekday_rate}`);
      }
    }
  }
  if (!found) console.log("  none");

  // ---- 2. the weaker check, run for completeness ----
  console.log("\n  --- display_name that disagrees with its own coordinates ---");
  let odd = 0;
  for (const r of rows) {
    if (r.lat == null || r.lng == null || !r.name) continue;
    const g = await geocode(r.name).catch(() => null);
    const v = checkLocation({ lat: r.lat, lng: r.lng }, g?.location ?? null);
    if (!v.ok) {
      odd++;
      console.log(`  ${(v.metres / 1000).toFixed(1)} km  #${r.id} ${r.name}`);
    }
  }
  if (!odd) {
    console.log("  none — expected, and NOT evidence the corpus is clean:");
    console.log("  this check passes the known-bad MOE row too.");
  }

  console.log(`\n  Nothing is changed by this script.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
