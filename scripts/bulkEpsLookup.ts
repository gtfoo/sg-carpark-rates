/**
 * Bulk-fills rates for EPS car parks that genuinely have none.
 *
 *   npx tsx scripts/bulkEpsLookup.ts --dry-run
 *   npx tsx scripts/bulkEpsLookup.ts --limit 8 --min-lots 300
 *
 * Every call costs a Tavily search and an LLM request, so the target list is
 * the point of this script, not the loop. Three filters, in order of how much
 * waste they remove:
 *
 * 1. **Skip what search already prices.** An EPS entry is invisible when a
 *    RATED car park sits within 40 m, or within 300 m under a matching name —
 *    `search.ts` drops it as a duplicate. HDB car parks count as rated, and
 *    they suppress 1,401 of the 3,167 EPS entries on their own. Looking those
 *    up would spend money to change nothing on screen.
 * 2. **Skip machine names.** `HDB_BBM9`, `CP13_CP14_CP15` and friends are feed
 *    artefacts, not places. They are the same car parks the HDB schedule
 *    already prices, and no web search will find "HDB_BBM9".
 * 3. **Prefer size.** `publicLots` is the only proxy the inventory gives for
 *    how likely anyone is to park there.
 *
 * `lookupCarparkRate` refuses low-confidence answers and never overwrites a
 * hand-entered rate, so the worst case of a bad batch is money spent and
 * nothing saved — not a corrupted store.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!m || !m[1]) continue;
        if (process.env[m[1]] === undefined) {
          process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
        }
      }
    } catch {
      /* absent — fine */
    }
  }
}

/** Same rule as search.ts. Kept in sync by hand; see the note in the header. */
const DEDUP_M = 40;
const DEDUP_NAME_M = 300;

const norm = (s: string) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function looseNameMatch(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  return x.length > 3 && y.length > 3 && (x.includes(y) || y.includes(x));
}

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** A feed artefact rather than a place: no web search will ever find it. */
function isMachineName(name: string): boolean {
  return /^HDB[_ ]/i.test(name) || /^CP\d/i.test(name) || /^[A-Z]{1,3}\d+(_[A-Z0-9]+)+$/i.test(name);
}

async function main() {
  loadEnv();

  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: number) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1] ?? fallback) : fallback;
  };
  const limit = flag("--limit", 5);
  const minLots = flag("--min-lots", 200);
  const pauseMs = flag("--pause", 4000);
  const dryRun = argv.includes("--dry-run");

  const { listOverrides, findOverrideForDestination } = await import(
    "../src/lib/store/rates"
  );
  const { fetchHdbCarparks } = await import("../src/lib/sources/hdb");
  const { lookupCarparkRate } = await import("../src/lib/lookup");
  const eps = (await import("../src/lib/sources/eps-carparks.json", { with: { type: "json" } }))
    .default as Array<{
    id: string;
    name: string;
    address: string;
    postal: string;
    lat: number;
    lng: number;
    publicLots: number | null;
  }>;

  const alreadyCovered: string[] = [];

  // Everything search can already price, with the names it would compare on.
  const rated: { loc: { lat: number; lng: number }; names: string[] }[] = [];
  for (const o of listOverrides()) {
    if (o.lat == null || o.lng == null) continue;
    rated.push({ loc: { lat: o.lat, lng: o.lng }, names: [o.displayName ?? "", o.matchValue] });
  }
  const hdb = await fetchHdbCarparks();
  for (const h of hdb) rated.push({ loc: h.location, names: [h.address] });

  const targets = eps
    .filter((c) => Number(c.publicLots) >= minLots)
    .filter((c) => !isMachineName(c.name))
    .filter((c) => {
      const loc = { lat: c.lat, lng: c.lng };
      return !rated.some((r) => {
        const d = metres(loc, r.loc);
        if (d < DEDUP_M) return true;
        return d < DEDUP_NAME_M && r.names.some((n) => looseNameMatch(c.name, n));
      });
    })
    // Then ask the matcher that actually decides at request time. The filter
    // above is this script's own approximation -- proximity plus a fuzzy name
    // -- and it misses saves it should see: Changi General Hospital was stored
    // the same day as "Changi General Hospital (CGH)", from a geocode a little
    // off the EPS point, and still appeared here as a target. Re-buying a rate
    // we already hold is the most avoidable spend there is, and the matcher is
    // also the piece that was fixed on 08-23, so it now knows more than this
    // filter does.
    .filter((c) => {
      const hit = findOverrideForDestination({
        postal: c.postal || null,
        name: c.name,
        lat: c.lat,
        lng: c.lng,
      });
      if (hit) {
        alreadyCovered.push(`${c.name} -> #${hit.id} ${hit.displayName ?? hit.matchValue}`);
        return false;
      }
      return true;
    })
    .sort((a, b) => Number(b.publicLots) - Number(a.publicLots));

  console.log(
    `${eps.length} EPS entries → ${targets.length} unpriced, named, ≥${minLots} lots. ` +
      `Taking ${Math.min(limit, targets.length)}.`,
  );
  if (alreadyCovered.length) {
    console.log(`  ${alreadyCovered.length} skipped — the store already answers for them:`);
    for (const a of alreadyCovered.slice(0, 10)) console.log(`    ${a}`);
    if (alreadyCovered.length > 10) console.log(`    ... ${alreadyCovered.length - 10} more`);
  }

  const batch = targets.slice(0, limit);
  if (dryRun) {
    for (const c of batch) {
      console.log(`  would look up  ${String(c.publicLots).padStart(5)} lots  ${c.name}  (${c.postal})`);
    }
    console.log("\ndry run — nothing called, nothing saved.");
    return;
  }

  let found = 0;
  let missed = 0;
  for (const [i, c] of batch.entries()) {
    process.stdout.write(`[${i + 1}/${batch.length}] ${c.name} … `);
    try {
      const res = await lookupCarparkRate({
        destination: c.name,
        // EPS files some carparks under a code ("TLF" at 1 Cluny Road), and a
        // search for the code alone returns nothing. Query-only; the name is
        // still what identifies and displays the carpark.
        addressHint: c.address || null,
        postal: c.postal || null,
        lat: c.lat,
        lng: c.lng,
      });
      if (res.found && res.override) {
        found++;
        console.log(`FOUND  ${res.override.weekdayRate ?? "(no weekday rate)"}`);
        console.log(`         source: ${res.override.sourceUrl ?? "—"}`);
      } else {
        missed++;
        console.log(`none   (${res.status}: ${res.reason ?? ""})`);
      }
    } catch (err) {
      missed++;
      console.log(`ERROR  ${err instanceof Error ? err.message : String(err)}`);
    }
    // The free tier rate-limits, and a 429 costs a long retry inside the
    // fallback chain — pacing here is cheaper than being throttled there.
    if (i < batch.length - 1) await new Promise((r) => setTimeout(r, pauseMs));
  }

  console.log(`\n${found} saved, ${missed} not found, ${targets.length - batch.length} still queued.`);
  console.log("All saved rates are marked 'AI-retrieved — verify' and need a human check.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
