/**
 * Moves the stored Havelock2 rate onto the building it prices, and names it
 * the way the building is actually named.
 *
 *   npx tsx scripts/fixHavelock2Location.ts            # report only
 *   npx tsx scripts/fixHavelock2Location.ts --apply    # write
 *
 * The override is filed under the name HAVELOCK2 with coordinates
 * 1.2869836758937, 103.833492718787 — 1.3 km west of 2 Havelock Road. OneMap
 * answers postal 059763 with "HAVELOCK2" at 1.287150616166626,
 * 103.8451537368625, which is the building the LTA rate on this row belongs to.
 *
 * Why this is worth a script rather than a shrug. The row's coordinates exist
 * to let `chooseNameMatch` REJECT a name match that is in the wrong place, and
 * that check is skipped for an exact match — "an exact match is not a guess".
 * Since `eps-aliases-manual.json` renamed EPS 3369 to "Havelock2", this row now
 * matches exactly, so its own coordinates are no longer consulted and the error
 * is invisible in normal use. It stays wrong for `duplicateSweep`, for
 * `locationSweep`, and for any future non-exact match — a wrong number under a
 * guard that has stood aside is exactly the shape that produced the MOE (Evans
 * Road) failure.
 *
 * Report-only by default, for the reason `citationAudit.ts` was rewritten that
 * way: a maintenance script that writes on sight has no step at which a human
 * reads the evidence.
 *
 * Run it AS THE deploy USER on the droplet. SQLite recreates -wal and -shm at
 * the process umask whenever it reopens the database, so writing as root leaves
 * root-owned sidecars beside a 0640 deploy:deploy database and the service
 * silently loses the ability to write:
 *
 *   sudo -u deploy npx tsx scripts/fixHavelock2Location.ts --apply
 */
import { getDb } from "../src/lib/db";
import { haversineMetres } from "../src/lib/geo";

/** OneMap, postal 059763 — "2 HAVELOCK ROAD HAVELOCK2 SINGAPORE 059763". */
const TRUE_POINT = { lat: 1.287150616166626, lng: 103.8451537368625 };

/**
 * The building is Havelock2 — one word, digit — which is how OneMap answers
 * 059763 and how the owner names it. The row was stored as "Havelock 2".
 *
 * This is not cosmetic. Once the coordinates are corrected this row sits on
 * top of EPS 3369, and search drops the unpriced EPS card in favour of the
 * rated one within 40 m — so THIS display name is the one that reaches the
 * card, and the eps-aliases-manual.json entry naming 3369 "Havelock2" stops
 * being what the user sees.
 */
const TRUE_NAME = "Havelock2";

/** Anything further than this and the row is not the one described above. */
const EXPECTED_ERROR_M = 1000;

type Row = {
  id: number;
  match_value: string;
  display_name: string | null;
  lat: number | null;
  lng: number | null;
  updated_at: string;
};

const apply = process.argv.includes("--apply");
const db = getDb();

const rows = db
  .prepare(
    `SELECT id, match_value, display_name, lat, lng, updated_at
       FROM rate_overrides
      WHERE match_type = 'name' AND match_value = 'HAVELOCK2'`,
  )
  .all() as Row[];

if (rows.length !== 1) {
  console.error(`Expected exactly 1 HAVELOCK2 override, found ${rows.length}. Stopping.`);
  process.exit(1);
}

const row = rows[0]!;
console.log(`row ${row.id}  "${row.display_name ?? row.match_value}"`);
console.log(`  stored   ${row.lat}, ${row.lng}   name "${row.display_name}"`);
console.log(`  correct  ${TRUE_POINT.lat}, ${TRUE_POINT.lng}   name "${TRUE_NAME}"`);

if (row.lat == null || row.lng == null) {
  console.error("  row has no coordinates — not the defect this script describes. Stopping.");
  process.exit(1);
}

const off = haversineMetres({ lat: row.lat, lng: row.lng }, TRUE_POINT);
console.log(`  apart    ${Math.round(off)} m`);

const nameOk = row.display_name === TRUE_NAME;
if (off < 5 && nameOk) {
  console.log("\nAlready correct — nothing to do.");
  process.exit(0);
}

if (off > EXPECTED_ERROR_M * 2) {
  console.error(
    `\n${Math.round(off)} m is further off than the ${EXPECTED_ERROR_M} m defect this ` +
      `script was written for. That is a different problem — look before writing. Stopping.`,
  );
  process.exit(1);
}

if (!apply) {
  console.log("\nReport only. Re-run with --apply to write.");
  process.exit(0);
}

const before = db.prepare("SELECT count(*) AS n FROM rate_overrides").get() as { n: number };

const res = db
  .prepare(
    `UPDATE rate_overrides
        SET lat = ?, lng = ?, display_name = ?, updated_at = ?
      WHERE id = ? AND match_type = 'name' AND match_value = 'HAVELOCK2'`,
  )
  .run(TRUE_POINT.lat, TRUE_POINT.lng, TRUE_NAME, new Date().toISOString(), row.id);

const after = db.prepare("SELECT count(*) AS n FROM rate_overrides").get() as { n: number };
const check = db
  .prepare("SELECT lat, lng, display_name, updated_at FROM rate_overrides WHERE id = ?")
  .get(row.id) as Row;

console.log(`\nrows changed  ${res.changes}  (want 1)`);
console.log(`row count     ${before.n} -> ${after.n}  (must not move)`);
console.log(`now at        ${check.lat}, ${check.lng}`);
console.log(`now named     "${check.display_name}"`);
console.log(
  `residual      ${Math.round(
    haversineMetres({ lat: check.lat!, lng: check.lng! }, TRUE_POINT),
  )} m`,
);

if (res.changes !== 1 || before.n !== after.n || check.display_name !== TRUE_NAME) {
  console.error("Unexpected write shape — check the row.");
  process.exit(1);
}
console.log("\nDone.");
