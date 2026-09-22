/**
 * Deletes one override row, after printing it and requiring a reason.
 *
 *   npx tsx scripts/deleteRow.ts --id 3450 --why "superseded by #3472"
 *   npx tsx scripts/deleteRow.ts --id 3450 --why "..." --apply
 *
 * Run as the deploy user on the droplet — SQLite recreates -wal/-shm at the
 * process umask on reopen, so a root write leaves root-owned sidecars beside a
 * 0640 deploy:deploy database and the service loses write access.
 *
 * Deleting a rate has been ad-hoc here: the stale RWS row went out through the
 * admin endpoint with a hand-written curl, and the two parkaholic rows by hand.
 * That is a lot of quoting around an irreversible write, and nothing recorded
 * WHY afterwards. This prints the row, appends it to a dated backup file with
 * the reason attached, and only then deletes.
 *
 * Report-only by default, for the reason citationAudit.ts was rewritten that
 * way: a maintenance script that writes on sight has no step at which a human
 * reads the evidence.
 *
 * It does NOT decide which of two rows is right. duplicateSweep deliberately
 * refuses to, because picking by rule — newest, longest, most bands — would
 * have chosen the nonsense row at Mackenzie Road, which was also the newest.
 * The caller supplies the id and the reason; this only makes the write safe.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { getDb } from "../src/lib/db";
import { deleteOverride } from "../src/lib/store/rates";

const BACKUP_DIR = "/home/deploy/backups";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const id = Number(arg("--id"));
const why = arg("--why");
const apply = process.argv.includes("--apply");

if (!Number.isInteger(id) || id <= 0 || !why || why.trim().length < 8) {
  console.error('usage: --id <rowId> --why "<reason, 8+ chars>" [--apply]');
  process.exit(1);
}

const row = getDb().prepare("SELECT * FROM rate_overrides WHERE id = ?").get(id) as
  | Record<string, unknown>
  | undefined;

if (!row) {
  console.error(`No override #${id}.`);
  process.exit(1);
}

console.log(JSON.stringify(row, null, 1));
console.log(`\nreason: ${why}`);

if (!apply) {
  console.log("\nReport only. Re-run with --apply to delete.");
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10);
const file = `${BACKUP_DIR}/deleted-rows-${stamp}.jsonl`;
try {
  mkdirSync(BACKUP_DIR, { recursive: true });
  appendFileSync(file, JSON.stringify({ deletedAt: new Date().toISOString(), why, row }) + "\n");
  console.log(`backed up to ${file}`);
} catch (err) {
  // Refuse rather than delete something that is not written down anywhere.
  console.error(`could not write the backup (${err instanceof Error ? err.message : err})`);
  console.error("Not deleting — an unbacked-up delete is the one that cannot be undone.");
  process.exit(1);
}

const before = getDb().prepare("SELECT count(*) AS n FROM rate_overrides").get() as { n: number };
const ok = deleteOverride(id);
const after = getDb().prepare("SELECT count(*) AS n FROM rate_overrides").get() as { n: number };

console.log(`deleted: ${ok}`);
console.log(`rows: ${before.n} -> ${after.n}  (want a drop of exactly 1)`);
if (!ok || before.n - after.n !== 1) {
  console.error("Unexpected delete shape — check the table.");
  process.exit(1);
}
console.log("Done.");
