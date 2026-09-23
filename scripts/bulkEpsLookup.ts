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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

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
  // `publicEpsCarparks`, not the raw JSON this used to read.
  //
  // Reading the file directly bypassed everything `eps.ts` decides, and the
  // suppression list was the expensive half: AXA TOWER and GOLDEN MILE COMPLEX
  // were suppressed on 2026-09-23 because both buildings were demolished or
  // closed in 2023, and both still appeared at the head of this queue
  // afterwards, ready to be bought. A suppression that stops a card rendering
  // but not a lookup firing saves nothing.
  //
  // It also picks up the other two things eps.ts knows. The loading bays and
  // coach stands no car may park in are excluded, so none is ever looked up.
  // And the names are the CURATED ones — the alias file exists precisely
  // because "TLF" and "BTC_NUS" are unsearchable, and this path was querying
  // the raw codes while the rest of the app used the readable names.
  const { publicEpsCarparks } = await import("../src/lib/sources/eps");
  const eps = publicEpsCarparks.map((c) => ({
    id: c.id,
    name: c.name,
    address: c.address,
    postal: c.postal ?? "",
    lat: c.location.lat,
    lng: c.location.lng,
    publicLots: c.publicLots,
  }));

  // A refusal is not an answer, but it IS evidence about the next batch.
  //
  // Targets are ordered by lot count and a refusal leaves the store unchanged,
  // so a car park the web cannot price stays at the HEAD of the queue and is
  // re-attempted, at full cost, in every batch for ever. Measured: MND (609
  // lots) and STELLAR@TAMPINES (549) were refused on 09-21 and again on 09-23,
  // both times as the first two targets. At the ~47% refusal rate these two
  // batches ran at, the head of the queue silently becomes a list of questions
  // already asked.
  //
  // So refusals are remembered, and skipped for a while. NOT for ever: a rate
  // that is not online today may be online next quarter, and `bulkGapLookup`
  // already records the principle that failing to find an answer is not the
  // same as the question needing none. The cooloff is what turns "ask again"
  // from every batch into every season.
  //
  // Kept in `data/`, which is gitignored and survives deploys, because this is
  // runtime evidence rather than a committed judgement like
  // `eps-suppressed.json` — nobody should review a diff of it.
  const REFUSAL_LOG = join(process.cwd(), "data", "eps-refusals.json");
  const COOLOFF_DAYS = 30;

  type Refusal = { name: string; at: string; reason: string };
  let refusals: Record<string, Refusal> = {};
  try {
    refusals = JSON.parse(readFileSync(REFUSAL_LOG, "utf8")) as Record<string, Refusal>;
  } catch {
    // No log yet, or it is unreadable. Either way the batch proceeds — a
    // missing memory must never stop the work, only stop the saving.
  }
  const freshRefusal = (id: string): Refusal | null => {
    const r = refusals[id];
    if (!r) return null;
    const age = (Date.now() - Date.parse(r.at)) / 86_400_000;
    return Number.isFinite(age) && age < COOLOFF_DAYS ? r : null;
  };
  const retryRefused = process.argv.includes("--retry-refused");

  const alreadyCovered: string[] = [];
  const recentlyRefused: string[] = [];

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
      if (retryRefused) return true;
      const r = freshRefusal(String(c.id));
      if (!r) return true;
      recentlyRefused.push(`${c.name} — ${r.at.slice(0, 10)}: ${r.reason.slice(0, 80)}`);
      return false;
    })
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
  if (recentlyRefused.length) {
    console.log(
      `  ${recentlyRefused.length} skipped — the web had no rate within the last ` +
        `${COOLOFF_DAYS} days (--retry-refused to ask again):`,
    );
    for (const r of recentlyRefused.slice(0, 10)) console.log(`    ${r}`);
    if (recentlyRefused.length > 10) {
      console.log(`    ... ${recentlyRefused.length - 10} more`);
    }
  }

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
        refusals[String(c.id)] = {
          name: c.name,
          at: new Date().toISOString(),
          reason: res.reason ?? res.status,
        };
      }
    } catch (err) {
      missed++;
      console.log(`ERROR  ${err instanceof Error ? err.message : String(err)}`);
      // Deliberately NOT recorded. An exception is a fault on our side — a
      // timeout, a missing key, a provider outage — and holding it against the
      // car park for a month would silently drop a target for a reason that
      // has nothing to do with whether its rate is published.
    }
    // The free tier rate-limits, and a 429 costs a long retry inside the
    // fallback chain — pacing here is cheaper than being throttled there.
    if (i < batch.length - 1) await new Promise((r) => setTimeout(r, pauseMs));
  }

  try {
    mkdirSync(dirname(REFUSAL_LOG), { recursive: true });
    writeFileSync(REFUSAL_LOG, JSON.stringify(refusals, null, 1));
  } catch (err) {
    console.log(`  (could not write ${REFUSAL_LOG}: ${err instanceof Error ? err.message : err})`);
  }

  console.log(`\n${found} saved, ${missed} not found, ${targets.length - batch.length} still queued.`);
  console.log("All saved rates are marked 'AI-retrieved — verify' and need a human check.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
