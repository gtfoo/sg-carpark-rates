/**
 * How old is what we're quoting?
 *
 *   npm run rates-staleness
 *   npm run rates-staleness -- --list 40
 *
 * Every other check asks whether a rate can be COMPUTED. The corpus gate
 * catches a string that stopped parsing and a fee that's absurd for two hours.
 * Neither asks whether the number is still TRUE — a rate can parse perfectly,
 * price plausibly, and be a year out of date because the operator put prices up
 * in March. This is the only view of that.
 *
 * Ages are measured against `verified_at`, which is meant to be the day the
 * rate was last true at its source — NOT the day we happened to write the row.
 * The two drifted apart once already: rates scraped from OneMotoring were
 * stamped with the scrape date while the page itself had not been revised for
 * three months, so every one of them looked fresher than it was.
 */
interface Row {
  id: number;
  display_name: string | null;
  match_value: string;
  source: string;
  source_url: string | null;
  verified_at: string | null;
  lat: number | null;
}

/** How long each kind of rate can be trusted before it wants another look. */
const SHELF_LIFE_DAYS: Record<string, number> = {
  "URA (official)": 180,
  "LTA OneMotoring": 180,
  // The open dataset stopped being updated in June 2024, so every row sourced
  // from it is already well past this. That is the point: they should sit in
  // the re-verification queue rather than look current.
  "LTA open data": 180,
  "Operator site": 365,
  "AI-retrieved": 90,
  "Entered by hand": 365,
};

function classify(r: Row): string {
  const url = r.source_url ?? "";
  if (r.source === "web-llm") return "AI-retrieved";
  if (r.source === "manual") return "Entered by hand";
  if (/eservice\.ura\.gov\.sg/i.test(url)) return "URA (official)";
  if (/data\.gov\.sg/i.test(url)) return "LTA open data";
  if (/onemotoring\.lta\.gov\.sg/i.test(url)) return "LTA OneMotoring";
  return "Operator site";
}

function ageDays(iso: string | null, today: Date): number | null {
  if (!iso) return null;
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return null;
  return Math.round((today.getTime() - d) / 86_400_000);
}

export interface Staleness {
  total: number;
  byKind: {
    kind: string;
    count: number;
    undated: number;
    median: number | null;
    oldest: number | null;
    overdue: number;
  }[];
  /** Past its shelf life, oldest first — the re-verification queue. */
  overdue: { row: Row; kind: string; age: number }[];
  /** No source_url, so there's nowhere to go and check. */
  unverifiable: Row[];
}

export function assess(rows: Row[], today = new Date()): Staleness {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = classify(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const overdue: { row: Row; kind: string; age: number }[] = [];
  const byKind: Staleness["byKind"] = [];

  for (const [kind, rs] of groups) {
    const ages = rs
      .map((r) => ageDays(r.verified_at, today))
      .filter((a): a is number => a !== null)
      .sort((a, b) => a - b);
    const limit = SHELF_LIFE_DAYS[kind] ?? 365;
    let over = 0;
    for (const r of rs) {
      const age = ageDays(r.verified_at, today);
      if (age !== null && age > limit) {
        overdue.push({ row: r, kind, age });
        over++;
      }
    }
    byKind.push({
      kind,
      count: rs.length,
      undated: rs.length - ages.length,
      median: ages.length ? ages[Math.floor(ages.length / 2)]! : null,
      oldest: ages.length ? ages[ages.length - 1]! : null,
      overdue: over,
    });
  }

  byKind.sort((a, b) => b.count - a.count);
  overdue.sort((a, b) => b.age - a.age);
  return {
    total: rows.length,
    byKind,
    overdue,
    unverifiable: rows.filter((r) => !r.source_url && r.source !== "manual"),
  };
}

// The database is reached lazily so `assess` can be unit-tested without
// loading better-sqlite3's native binding, which is built per Node version.
async function main() {
  const listArg = process.argv.indexOf("--list");
  const listN = listArg > -1 ? Number(process.argv[listArg + 1]) || 20 : 20;

  const { getDb } = await import("../src/lib/db");
  const rows = getDb()
    .prepare(
      `SELECT id, display_name, match_value, source, source_url, verified_at, lat
       FROM rate_overrides`,
    )
    .all() as Row[];

  const s = assess(rows);
  console.log(`stored rates: ${s.total}\n`);
  console.log(
    `  ${"source".padEnd(17)}${"count".padStart(6)}${"median".padStart(9)}${"oldest".padStart(8)}` +
      `${"undated".padStart(9)}${"overdue".padStart(9)}   shelf life`,
  );
  for (const k of s.byKind) {
    console.log(
      `  ${k.kind.padEnd(17)}${String(k.count).padStart(6)}` +
        `${(k.median === null ? "-" : `${k.median}d`).padStart(9)}` +
        `${(k.oldest === null ? "-" : `${k.oldest}d`).padStart(8)}` +
        `${String(k.undated).padStart(9)}${String(k.overdue).padStart(9)}` +
        `   ${SHELF_LIFE_DAYS[k.kind] ?? 365}d`,
    );
  }

  console.log(`\nre-verification queue: ${s.overdue.length} past shelf life`);
  for (const o of s.overdue.slice(0, listN)) {
    const name = (o.row.display_name ?? o.row.match_value).slice(0, 34);
    console.log(
      `  ${String(o.age).padStart(5)}d  ${name.padEnd(35)} ${o.kind.padEnd(16)} ${o.row.source_url ?? ""}`,
    );
  }
  if (s.overdue.length > listN) console.log(`  … ${s.overdue.length - listN} more (--list N)`);

  if (s.unverifiable.length) {
    console.log(
      `\n${s.unverifiable.length} rate(s) have no source URL — nowhere to go and re-check:`,
    );
    for (const r of s.unverifiable.slice(0, 10)) {
      console.log(`  ${(r.display_name ?? r.match_value).slice(0, 40)}`);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("rateStaleness.ts")) main();
