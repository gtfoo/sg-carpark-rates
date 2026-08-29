/**
 * Works the rate-gap queue: the destinations people actually searched for and
 * did not get a price.
 *
 *   npx tsx scripts/bulkGapLookup.ts --dry-run
 *   npx tsx scripts/bulkGapLookup.ts --limit 5
 *
 * `bulkEpsLookup.ts` works an INVENTORY, ordered by lot count — what exists.
 * This works DEMAND, ordered by how many times someone asked — what was wanted
 * and missing. The queue had a producer (`recordGap`, on every search that
 * finds no rate) and a viewer (`scripts/rates.ts`, `/api/gaps`) but nothing
 * that acted on it, so a gap sat until a person noticed it.
 *
 * It re-checks before it spends, and that is not a formality. Of the eleven
 * gaps standing when this was written, several name car parks we already hold
 * a rate for — MOE BUILDING, SOLARIS, the Changi terminals. They were recorded
 * when the name matcher was returning the wrong row (or nothing), and that was
 * fixed on 2026-08-23. A queue that predates a matcher fix is partly a list of
 * questions already answered, and paying a search and an extraction to
 * rediscover them would be the most avoidable spend in the app.
 */
import { listGaps, resolveGap } from "../src/lib/store/gaps";
import { findOverrideForDestination } from "../src/lib/store/rates";

function loadEnv() {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
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
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const li = argv.indexOf("--limit");
  const limit = li > -1 ? Number(argv[li + 1]) : 5;

  const { lookupCarparkRate } = await import("../src/lib/lookup");

  const gaps = listGaps(false);
  console.log(`${gaps.length} unresolved gap(s), most-asked first\n`);

  // Free pass: anything the store can already answer is closed without a call.
  let alreadyCovered = 0;
  const open: typeof gaps = [];
  for (const g of gaps) {
    const hit = findOverrideForDestination({
      postal: g.postal,
      name: g.destination,
      lat: g.lat,
      lng: g.lng,
    });
    if (hit) {
      alreadyCovered++;
      console.log(
        `  covered   ${String(g.hitCount).padStart(3)}x  ${g.destination.slice(0, 40).padEnd(42)} -> #${hit.id} ${hit.displayName}`,
      );
      if (!dryRun) resolveGap(g.id);
    } else {
      open.push(g);
    }
  }
  console.log(
    `\n  ${alreadyCovered} already covered${dryRun ? " (would be closed)" : " — closed, no lookup spent"}`,
  );
  console.log(`  ${open.length} genuinely missing\n`);

  const batch = open.slice(0, limit);
  if (dryRun) {
    for (const g of batch) {
      console.log(
        `  would look up  ${String(g.hitCount).padStart(3)}x  ${g.destination.slice(0, 44).padEnd(46)} ${g.postal ?? "-"}`,
      );
    }
    if (open.length > batch.length) console.log(`  ... ${open.length - batch.length} more beyond --limit`);
    console.log(`\n  Dry run: nothing looked up, nothing spent.`);
    return;
  }

  let found = 0;
  for (const g of batch) {
    console.log(`\n  ${g.hitCount}x  ${g.destination}`);
    const res = await lookupCarparkRate({
      destination: g.destination,
      postal: g.postal,
      lat: g.lat,
      lng: g.lng,
    });
    if (res.found && res.override) {
      found++;
      console.log(`      SAVED #${res.override.id}  ${res.override.weekdayRate}`);
      console.log(`      ${res.override.sourceUrl ?? "no source"}`);
      // lookupCarparkRate resolves gaps by name itself; this covers the case
      // where the saved display name differs from what was searched.
      resolveGap(g.id);
    } else {
      // Deliberately NOT resolved. A refusal is "we could not answer this",
      // not "this needs no answer" — closing it here would hide the question.
      console.log(`      not saved: ${res.reason ?? res.status}`);
    }
  }
  console.log(`\n  ${found} of ${batch.length} saved. ${open.length - batch.length} still queued.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
