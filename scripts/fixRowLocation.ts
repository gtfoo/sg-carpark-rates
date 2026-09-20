/**
 * Puts one stored row on the point its POSTAL CODE resolves to.
 *
 *   npx tsx scripts/fixRowLocation.ts --id 1527 --postal 529889
 *   npx tsx scripts/fixRowLocation.ts --id 1527 --postal 529889 --apply
 *
 * Report-only by default. Run it as the deploy user on the droplet — SQLite
 * recreates -wal and -shm at the process umask on reopen, so a root write
 * leaves root-owned sidecars beside a 0640 deploy:deploy database and the
 * service loses its write access:
 *
 *   sudo -u deploy npx tsx scripts/fixRowLocation.ts --id N --postal P --apply
 *
 * POSTAL, deliberately, and never a name. OneMap answers a postal exactly and a
 * name only fuzzily, and the fuzzy path is what created the damage this script
 * repairs: "Changi General Hospital" returns CGH BUILDING at 131 Killiney Road,
 * 13 km from the hospital, and "The Mill" returns the Ritz-Carlton because
 * Millenia begins with Mill. Re-geocoding a bad row by its name would reproduce
 * the original error and call it a fix. So the caller supplies the postal, which
 * means a human has decided which building this row is — the judgement stays
 * with the person and the script only does the arithmetic.
 *
 * The 109 rows with no coordinates cannot use this yet: none of them carries a
 * postal, which is exactly why that task is blocked behind the OneMap one
 * rather than being a loop over this script.
 */
import { getDb } from "../src/lib/db";
import { haversineMetres } from "../src/lib/geo";
import { setOverrideCoords, SAME_PLACE_M } from "../src/lib/store/rates";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const id = Number(arg("--id"));
const postal = arg("--postal");
const apply = process.argv.includes("--apply");

if (!Number.isInteger(id) || id <= 0 || !postal || !/^\d{6}$/.test(postal)) {
  console.error("usage: --id <rowId> --postal <6 digits> [--apply]");
  process.exit(1);
}

type Row = {
  id: number;
  match_value: string;
  display_name: string | null;
  source: string;
  lat: number | null;
  lng: number | null;
};

const row = getDb()
  .prepare(
    "SELECT id, match_value, display_name, source, lat, lng FROM rate_overrides WHERE id = ?",
  )
  .get(id) as Row | undefined;

if (!row) {
  console.error(`No override #${id}.`);
  process.exit(1);
}

console.log(`row #${row.id}  "${row.display_name ?? row.match_value}"  (${row.source})`);

// Narrowed once, here: `row` is `Row | undefined`, and TypeScript does not
// carry the narrowing above into main()'s closure.
const found: Row = row;
console.log(`  stored  ${row.lat ?? "—"}, ${row.lng ?? "—"}`);

// Wrapped rather than written as top-level await: tsx transforms these scripts
// as CommonJS, where top-level await is a TransformError at run time — and tsc
// does NOT catch it, because it only checks types. Every other script here is
// synchronous, so this is the first one to meet it.
async function main(): Promise<void> {
const url =
  "https://www.onemap.gov.sg/api/common/elastic/search" +
  `?searchVal=${postal}&returnGeom=Y&getAddrDetails=Y`;

// Surfaced, never swallowed. A `.catch(() => null)` here would turn OneMap
// throttling into "no such postal", which is how 54 fabricated "no building"
// results once reached a committed file.
const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
if (!res.ok) {
  console.error(`OneMap HTTP ${res.status} — not treating this as "postal not found".`);
  process.exit(1);
}
const body = (await res.json()) as {
  found?: number;
  results?: { SEARCHVAL?: string; POSTAL?: string; LATITUDE?: string; LONGITUDE?: string }[];
};

const hits = body.results ?? [];
if (!hits.length) {
  console.error(`OneMap returned nothing for ${postal}. Stopping.`);
  process.exit(1);
}

// Every result must agree on the point, or the postal is not the unambiguous
// answer this script assumes it is.
const pts = hits
  .filter((h) => h.POSTAL === postal)
  .map((h) => ({ lat: Number(h.LATITUDE), lng: Number(h.LONGITUDE), name: h.SEARCHVAL ?? "?" }))
  .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

if (!pts.length) {
  console.error(`No result actually carries postal ${postal}. Stopping.`);
  process.exit(1);
}
const spread = Math.max(...pts.map((p) => haversineMetres(pts[0]!, p)));
if (spread > 150) {
  console.error(`${pts.length} results for ${postal} span ${Math.round(spread)} m — ambiguous.`);
  for (const p of pts) console.error(`   ${p.name}  ${p.lat}, ${p.lng}`);
  process.exit(1);
}

const target = pts[0]!;
console.log(`  postal  ${postal} -> "${target.name}"  ${target.lat}, ${target.lng}`);

if (found.lat != null && found.lng != null) {
  const off = haversineMetres({ lat: found.lat, lng: found.lng }, target);
  console.log(`  moves   ${Math.round(off)} m`);
  if (off < 5) {
    console.log("\nAlready there — nothing to do.");
    process.exit(0);
  }
} else {
  console.log("  moves   row had no coordinates at all");
}

// Is the destination already occupied? `setOverrideCoords` writes coordinates
// directly and so bypasses `upsertOverride`'s overlap guard — moving a row is
// the one way to create the duplicate that guard exists to prevent, and it
// would do it silently. Same 25 m as SAME_PLACE_M, for the same reason: at
// 60 m this reports genuinely different car parks next door to each other.
const occupants = getDb()
  .prepare(
    `SELECT id, match_value, display_name, lat, lng FROM rate_overrides
      WHERE id != ? AND lat IS NOT NULL AND lng IS NOT NULL`,
  )
  .all(found.id) as Row[];
const collisions = occupants
  .map((o) => ({ o, d: haversineMetres({ lat: o.lat!, lng: o.lng! }, target) }))
  .filter((x) => x.d <= SAME_PLACE_M);

if (collisions.length) {
  console.error(`\n${collisions.length} row(s) already sit on that point:`);
  for (const { o, d } of collisions) {
    console.error(`   #${o.id} "${o.display_name ?? o.match_value}"  ${Math.round(d)} m`);
  }
  console.error("Moving this row there would create the duplicate upsert refuses. Stopping.");
  process.exit(1);
}

if (!apply) {
  console.log("\nReport only. Re-run with --apply to write.");
  process.exit(0);
}

const before = getDb().prepare("SELECT count(*) AS n FROM rate_overrides").get() as { n: number };
setOverrideCoords(found.id, target.lat, target.lng);
const after = getDb().prepare("SELECT count(*) AS n FROM rate_overrides").get() as { n: number };
const check = getDb()
  .prepare("SELECT lat, lng FROM rate_overrides WHERE id = ?")
  .get(found.id) as { lat: number; lng: number };

console.log(`\nrow count  ${before.n} -> ${after.n}  (must not move)`);
console.log(`now at     ${check.lat}, ${check.lng}`);
console.log(`residual   ${Math.round(haversineMetres(check, target))} m`);

if (before.n !== after.n || haversineMetres(check, target) > 1) {
  console.error("Unexpected write shape — check the row.");
  process.exit(1);
}
console.log("\nDone.");
}

main().catch((err) => {
  // Surfaced, not swallowed: a network failure here must never read as
  // "the postal does not exist".
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
