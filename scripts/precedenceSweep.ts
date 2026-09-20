/**
 * Finds saved AI rates sitting on top of official ones.
 *
 *   npx tsx scripts/precedenceSweep.ts [--radius 150]
 *
 * Mackenzie Road is the case this exists for: two `web-llm` rows ~90 m from
 * three URA `operator-site` rows that already covered the street properly, with
 * the free periods and the $5 night cap the web versions both omitted. One of
 * them carried "$5.00 per 510 mins", which is not a rate at all. The AI path
 * spent a search and an extraction to produce a WORSE copy of data already
 * held.
 *
 * `duplicateSweep.ts` asks which rows sit on top of each other whatever their
 * source. This asks the narrower question that can actually carry a rule:
 * which rows would a PRECEDENCE test have refused — an unofficial rate written
 * where an official one already answers.
 *
 * Why precedence rather than proximity. The write-time guard fires at 25 m and
 * that tightness is deliberate: 60 m reported eight false conflicts along
 * Orchard Road, where 313@Somerset and Pan Pacific Suites are genuinely
 * different car parks. Distance alone cannot separate "duplicate" from
 * "neighbour" in a dense belt. Source can: an `operator-site` row is evidence
 * from the operator, and a `web-llm` row beside it is a guess about the same
 * place. That asymmetry holds at radii where a bare distance test is useless,
 * which is the whole point of measuring it here before writing the rule.
 *
 * Reports only. It prints the radius each pair was found at so the threshold is
 * chosen from the data rather than picked first and justified after.
 */
import { getDb } from "../src/lib/db";
import { haversineMetres } from "../src/lib/geo";
import { parseRate } from "../src/lib/sources/mallRates";

type Row = {
  id: number;
  match_type: string;
  match_value: string;
  display_name: string | null;
  weekday_rate: string | null;
  saturday_rate: string | null;
  sunday_ph_rate: string | null;
  source: string;
  source_url: string | null;
  verified_at: string;
  lat: number | null;
  lng: number | null;
};

const radiusArg = process.argv.indexOf("--radius");
const RADIUS_M = radiusArg > -1 ? Number(process.argv[radiusArg + 1]) : 150;
if (!Number.isFinite(RADIUS_M) || RADIUS_M <= 0) {
  console.error("--radius must be a positive number of metres");
  process.exit(1);
}

const rows = getDb()
  .prepare(
    `SELECT id, match_type, match_value, display_name, weekday_rate, saturday_rate,
            sunday_ph_rate, source, source_url, verified_at, lat, lng
       FROM rate_overrides
      WHERE lat IS NOT NULL AND lng IS NOT NULL`,
  )
  .all() as Row[];

const official = rows.filter((r) => r.source === "operator-site");
const guessed = rows.filter((r) => r.source === "web-llm");

console.log(
  `${rows.length} located rows — ${official.length} operator-site, ${guessed.length} web-llm. ` +
    `Radius ${RADIUS_M} m.\n`,
);

const name = (r: Row) => r.display_name ?? r.match_value;

/** A rate string that quotes money but does not parse is a defect on its own. */
function unparsed(r: Row): string[] {
  const bad: string[] = [];
  for (const [label, text] of [
    ["weekday", r.weekday_rate],
    ["saturday", r.saturday_rate],
    ["sunday/ph", r.sunday_ph_rate],
  ] as const) {
    if (!text) continue;
    if (!/\$/.test(text)) continue;
    const parsed = parseRate(text);
    if (!parsed || parsed.kind === "unparsed") bad.push(`${label}: ${text}`);
  }
  return bad;
}

let pairs = 0;
const buckets = new Map<number, number>();

for (const g of guessed) {
  const near = official
    .map((o) => ({ o, d: haversineMetres({ lat: g.lat!, lng: g.lng! }, { lat: o.lat!, lng: o.lng! }) }))
    .filter((x) => x.d <= RADIUS_M)
    .sort((a, b) => a.d - b.d);
  if (!near.length) continue;

  pairs++;
  const nearest = Math.round(near[0]!.d);
  const bucket = nearest <= 25 ? 25 : nearest <= 50 ? 50 : nearest <= 100 ? 100 : RADIUS_M;
  buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);

  console.log(`web-llm #${g.id} "${name(g)}"  verified ${g.verified_at}`);
  const bad = unparsed(g);
  for (const b of bad) console.log(`    NOT A RATE  ${b}`);
  for (const { o, d } of near.slice(0, 4)) {
    console.log(
      `    ${String(Math.round(d)).padStart(4)} m  operator-site #${o.id} "${name(o)}"` +
        `  verified ${o.verified_at}`,
    );
  }
  console.log(`      web-llm weekday: ${g.weekday_rate ?? "—"}`);
  console.log(`      official weekday: ${near[0]!.o.weekday_rate ?? "—"}`);
  console.log();
}

console.log(`${pairs} web-llm row(s) sit within ${RADIUS_M} m of an operator-site row.`);
if (pairs) {
  console.log("nearest-official distance distribution:");
  for (const b of [25, 50, 100, RADIUS_M]) {
    const n = buckets.get(b);
    if (n) console.log(`  <= ${String(b).padStart(4)} m   ${n}`);
  }
}
console.log("\nReport only — nothing written.");
