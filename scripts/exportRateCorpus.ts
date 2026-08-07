/**
 * Snapshots every distinct rate string in the store into a fixture the tests
 * can price without a database.
 *
 *   npm run export-rate-corpus
 *
 * The corpus is the point: three mispricing bugs this month were only found by
 * accident, and each was a PARSING failure that a thousand real strings would
 * have caught immediately — the band-split regression alone turned 142 rates
 * into "not computable". CI has no database, so the strings have to be in the
 * repo for tests/corpus.test.ts to run on every push.
 *
 * Re-run after importing new rates, then check the baseline in the test.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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

async function main() {
  loadEnv();
  const { getDb } = await import("../src/lib/db");
  const rows = getDb()
    .prepare(
      `SELECT display_name, match_value, weekday_rate, friday_rate, saturday_rate,
              sunday_ph_rate, notes
         FROM rate_overrides`,
    )
    .all() as Record<string, string | null>[];

  // One entry per distinct rate string. The name and notes ride along so a
  // failure names the car park and so caps/grace parse in context.
  const seen = new Map<string, { name: string; rate: string; notes: string }>();
  for (const r of rows) {
    const name = (r.display_name ?? r.match_value ?? "?").slice(0, 60);
    for (const col of ["weekday_rate", "friday_rate", "saturday_rate", "sunday_ph_rate"]) {
      const rate = r[col];
      if (!rate || !rate.trim()) continue;
      if (seen.has(rate)) continue;
      seen.set(rate, { name, rate, notes: (r.notes ?? "").slice(0, 200) });
    }
  }

  const corpus = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  const out = join(process.cwd(), "tests", "fixtures", "rate-corpus.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(corpus, null, 1));
  console.log(
    `Wrote ${corpus.length} distinct rate strings (from ${rows.length} car parks) ` +
      `to ${out} — ${(JSON.stringify(corpus).length / 1024).toFixed(0)} KB`,
  );
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
