/**
 * Backfills friday_rate for car parks that already say Friday bills with the
 * weekend.
 *
 *   npx tsx scripts/backfillFriday.ts --dry
 *   npx tsx scripts/backfillFriday.ts
 *
 * The evidence is already in the stored text. LTA OneMotoring writes the
 * weekend column as "Friday to Sunday and Public Holiday ...", and some
 * AI-retrieved rows say so in the notes — but before friday_rate existed there
 * was nowhere to act on it, so Friday quietly fell back to the Monday-Thursday
 * rate at exactly the malls that charge more on a Friday night.
 *
 * Only fills rows where friday_rate is NULL; never overwrites a rate someone
 * set deliberately.
 *
 * Provenance: what this writes is INFERRED from text already in the store, not
 * read fresh off each operator's site. It is only as current as the row it came
 * from. Treat the 13 rows it filled on 2026-08-07 as needing the same
 * confirmation as any other stored rate — if one of them is disputed, go to the
 * operator rather than assuming the inference was the mistake.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(join(process.cwd(), file), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && m[1] && process.env[m[1]] === undefined) {
          process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
        }
      }
    } catch {}
  }
}

/**
 * Does this text group Friday with the weekend?
 *
 * Only a Friday named in the DAY GROUPING that heads the rate counts —
 * "Friday to Sunday and Public Holiday 7.00am-...", "Fri/Sat-Sun/PH:",
 * "(Fri to Sat) ...". A Friday buried later is usually a sub-clause about
 * something else: Centennial Tower, Millenia and the Ritz-Carlton all read
 * "7.00am-1.59am: $2.80 ... Fri/Sat-Sun/PH (Overnight Parking): 2am-6.59am",
 * where only the OVERNIGHT band includes Friday and Friday daytime still bills
 * as a weekday. Taking those would have raised Friday prices wrongly.
 */
const DAY_GROUPING_CHARS = 32;

function fridayBillsAsWeekend(saturday: string, notes: string): boolean {
  if (/\bfri(day)?\b/i.test(saturday.slice(0, DAY_GROUPING_CHARS))) return true;
  // "Friday rates follow weekend rates" and similar, written into the notes.
  if (/\bfri(day)?\b[^.]{0,40}\b(weekend|sat)/i.test(notes)) return true;
  return false;
}

async function main() {
  loadEnv();
  const dry = process.argv.includes("--dry");
  const { getDb } = await import("../src/lib/db");
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT id, display_name, match_value, saturday_rate, notes
         FROM rate_overrides
        WHERE friday_rate IS NULL AND saturday_rate IS NOT NULL`,
    )
    .all() as {
    id: number;
    display_name: string | null;
    match_value: string;
    saturday_rate: string;
    notes: string | null;
  }[];

  const hits = rows.filter((r) => fridayBillsAsWeekend(r.saturday_rate, r.notes ?? ""));
  console.log(
    `${rows.length} rows without a Friday rate; ${hits.length} say Friday bills as a weekend.\n`,
  );

  const update = db.prepare(
    `UPDATE rate_overrides SET friday_rate = saturday_rate, updated_at = ? WHERE id = ?`,
  );
  const now = new Date().toISOString();
  for (const r of hits) {
    console.log(
      `  ${dry ? "would set" : "set"} ${String(r.id).padStart(5)} ${String(
        r.display_name ?? r.match_value,
      ).slice(0, 34).padEnd(35)} <- ${r.saturday_rate.slice(0, 46)}`,
    );
    if (!dry) update.run(now, r.id);
  }
  console.log(`\n${dry ? "would update" : "updated"} ${hits.length} rows.`);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
