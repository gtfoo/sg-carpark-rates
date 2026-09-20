/**
 * Rows that hold a rate but cannot be found.
 *
 *   npx tsx scripts/uncoordinatedRows.ts
 *
 * Search ranks by distance, so a row with no coordinates is invisible to it
 * however good its rate is. These are not gaps — the work of finding the price
 * was already done and paid for. They are answers the app cannot reach.
 *
 * Report only, and deliberately so: the fix is a geocode per row, and which
 * ones are geocodable at all is the thing to learn first. OneMap answers a
 * postal code exactly and a name only fuzzily — the same fuzziness that put
 * "Changi General Hospital" 13 km away at CGH BUILDING and gave "The Mill" the
 * Ritz-Carlton. So a row carrying its own postal is a safe automatic fix and a
 * row carrying only a name is not, and this counts the two separately rather
 * than reporting one number and implying they are the same job.
 */
import { getDb } from "../src/lib/db";

type Row = {
  id: number;
  match_type: string;
  match_value: string;
  display_name: string | null;
  source: string;
  notes: string | null;
  source_url: string | null;
  verified_at: string;
};

const rows = getDb()
  .prepare(
    `SELECT id, match_type, match_value, display_name, source, notes, source_url, verified_at
       FROM rate_overrides
      WHERE lat IS NULL OR lng IS NULL
      ORDER BY source, id`,
  )
  .all() as Row[];

const total = (getDb().prepare("SELECT count(*) AS n FROM rate_overrides").get() as { n: number }).n;

console.log(`${rows.length} of ${total} rows have no coordinates and cannot surface in search.\n`);
if (!rows.length) process.exit(0);

const name = (r: Row) => r.display_name ?? r.match_value;

/** A six-digit Singapore postal anywhere in the row's own text. */
const POSTAL = /\b(\d{6})\b/;
function postalFor(r: Row): string | null {
  for (const field of [r.match_value, r.display_name, r.notes, r.source_url]) {
    const m = field ? POSTAL.exec(field) : null;
    if (m) return m[1]!;
  }
  return null;
}

const bySource = new Map<string, Row[]>();
for (const r of rows) {
  if (!bySource.has(r.source)) bySource.set(r.source, []);
  bySource.get(r.source)!.push(r);
}

console.log("by source:");
for (const [src, rs] of [...bySource].sort((a, b) => b[1].length - a[1].length)) {
  const withPostal = rs.filter(postalFor).length;
  console.log(
    `  ${src.padEnd(14)} ${String(rs.length).padStart(4)}   ` +
      `${withPostal} carry a postal, ${rs.length - withPostal} name only`,
  );
}

// JTC is the group the task names; it is identified from the row's own text
// rather than assumed, so the number is checkable.
const jtc = rows.filter((r) =>
  /\bJTC\b/i.test(`${r.match_value} ${r.display_name ?? ""} ${r.notes ?? ""} ${r.source_url ?? ""}`),
);
console.log(`\nJTC rows among them: ${jtc.length}`);

const withPostal = rows.filter(postalFor);
console.log(`\nsafe to geocode automatically (own postal): ${withPostal.length}`);
console.log(`needs a judged lookup (name only):           ${rows.length - withPostal.length}`);

console.log("\nfirst 25:");
for (const r of rows.slice(0, 25)) {
  const p = postalFor(r);
  console.log(
    `  #${String(r.id).padEnd(5)} ${r.source.padEnd(14)} ${p ? `postal ${p}` : "name only "}  ` +
      `${name(r)}`,
  );
}
if (rows.length > 25) console.log(`  … and ${rows.length - 25} more`);

console.log("\nReport only — nothing written.");
