/**
 * Manage the persistent rate store from the terminal.
 *
 *   npm run rates list
 *   npm run rates gaps
 *   npm run rates add --match name --value "NTU@one-north" \
 *       --weekday "$1.20 per half hour" --url "https://..." --note "gantry, level 2"
 *   npm run rates del --id 3
 *
 * --match is one of: name | postal | carpark_no  (default: name)
 * Rate text uses the same shape as the LTA dataset, e.g.
 *   "$1.20 per half hour"   "Mon-Fri: $2 for 1st hr; $1 for sub. 30 mins"
 */
import {
  listOverrides,
  upsertOverride,
  deleteOverride,
  setOverrideCoords,
  type MatchType,
} from "../src/lib/store/rates";
import { listGaps, resolveGapsByName } from "../src/lib/store/gaps";
import { geocode } from "../src/lib/onemap";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        out[key] = val;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

function cmdList(): void {
  const rows = listOverrides();
  if (rows.length === 0) {
    console.log("No saved rates yet.");
    return;
  }
  for (const r of rows) {
    console.log(
      `#${r.id}  [${r.matchType}=${r.matchValue}]  ${r.displayName ?? ""}`,
    );
    console.log(
      `     weekday: ${r.weekdayRate ?? "-"}  |  sat: ${r.saturdayRate ?? "-"}  |  sun/ph: ${r.sundayPhRate ?? "-"}`,
    );
    console.log(
      `     ${r.source}, verified ${r.verifiedAt}${r.sourceUrl ? `  ${r.sourceUrl}` : ""}`,
    );
  }
}

function cmdGaps(): void {
  const rows = listGaps(false);
  if (rows.length === 0) {
    console.log("No open rate gaps. Nothing to fill in.");
    return;
  }
  console.log("Destinations searched with no rate and no nearby HDB carpark:\n");
  for (const g of rows) {
    console.log(
      `#${g.id}  ${g.destination}${g.postal ? ` (${g.postal})` : ""}  — searched ${g.hitCount}x, last ${g.lastSeen.slice(0, 10)}`,
    );
  }
  console.log("\nAdd a rate for one with:  npm run rates add --value \"<name>\" --weekday \"...\"");
}

function cmdAdd(f: Record<string, string>): void {
  const value = f.value;
  if (!value) {
    console.error('Missing --value "<name/postal/carpark_no>"');
    process.exit(1);
  }
  const matchType = (f.match ?? "name") as MatchType;
  const ov = upsertOverride({
    matchType,
    matchValue: value,
    displayName: f.name ?? value,
    weekdayRate: f.weekday ?? null,
    saturdayRate: f.sat ?? null,
    sundayPhRate: f.sun ?? null,
    source: f.url ? "operator-site" : "manual",
    sourceUrl: f.url ?? null,
    verifiedAt: f.verified ?? new Date().toISOString().slice(0, 10),
    notes: f.note ?? null,
  });
  const resolved = resolveGapsByName(ov.displayName ?? ov.matchValue);
  console.log(`Saved rate #${ov.id} for "${ov.displayName ?? ov.matchValue}".`);
  if (resolved > 0) console.log(`Cleared ${resolved} matching gap(s).`);
}

function cmdDel(f: Record<string, string>): void {
  const id = Number(f.id);
  if (!Number.isInteger(id)) {
    console.error("Missing --id <number>");
    process.exit(1);
  }
  console.log(deleteOverride(id) ? `Deleted #${id}.` : `No rate #${id}.`);
}

/** Geocodes any saved rate that has no coordinates, so it can be matched by proximity. */
async function cmdBackfill(): Promise<void> {
  loadEnv();
  const missing = listOverrides().filter((o) => o.lat === null || o.lng === null);
  if (missing.length === 0) {
    console.log("All saved rates already have coordinates.");
    return;
  }
  console.log(`Backfilling coordinates for ${missing.length} rate(s)…\n`);
  for (const o of missing) {
    // Try postal (if keyed on one), full display name, then a cleaned display
    // name (drop anything after "/" or "(", which OneMap can't match).
    const cleaned = (o.displayName ?? "").split(/[/(]/)[0]!.trim();
    const candidates = [
      o.matchType === "postal" ? o.matchValue : null,
      o.displayName,
      cleaned,
      o.matchValue,
    ].filter((q): q is string => typeof q === "string" && q.length > 2);

    let place = null;
    let used = "";
    for (const q of candidates) {
      place = await geocode(q).catch(() => null);
      if (place) {
        used = q;
        break;
      }
    }
    if (place) {
      setOverrideCoords(o.id, place.location.lat, place.location.lng);
      console.log(`  #${o.id} ${o.displayName ?? o.matchValue} → ${place.location.lat.toFixed(4)},${place.location.lng.toFixed(4)} (via "${used}")`);
    } else {
      console.log(`  #${o.id} ${o.displayName ?? o.matchValue} → could not geocode`);
    }
  }
}

function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(join(process.cwd(), file), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && m[1] && process.env[m[1]] === undefined) {
          process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
        }
      }
    } catch {
      /* absent — fine */
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  switch (cmd) {
    case "list":
      return cmdList();
    case "gaps":
      return cmdGaps();
    case "add":
      return cmdAdd(f);
    case "del":
      return cmdDel(f);
    case "backfill":
      return cmdBackfill();
    default:
      console.log("Usage: npm run rates <list|gaps|add|del|backfill> [flags]");
      console.log("  add       --value <name> [--match name|postal|carpark_no]");
      console.log("            [--weekday ..] [--sat ..] [--sun ..] [--url ..] [--note ..] [--verified YYYY-MM-DD]");
      console.log("  del       --id <n>");
      console.log("  backfill  add coordinates to saved rates that lack them");
  }
}

main();
