/**
 * Files JTC's published car park rates into the rate store.
 *
 *   curl -sL -o /tmp/jtc-carparks.pdf "https://www.jtc.gov.sg/-/media/project/jtc-cx/corpweb/assets/get-help/season-parking/jtc_carpark-details_jan-2025.pdf"
 *   python3 scripts/jtcRates.py /tmp/jtc-carparks.pdf /tmp/jtc-rates.json
 *   npx tsx scripts/importJtc.ts -- --dry
 *   npx tsx scripts/importJtc.ts --geocode
 *
 * The PDF is JTC's own "carpark details" document (Jan 2025 edition) — one
 * block per car park with per-day, per-band rates. jtcRates.py turns it into
 * JSON; this files the Car rates, borrowing coordinates from the EPS inventory
 * where the names line up so the car park can appear as a nearby card. Rows
 * are dated to the document's edition, not the day this ran.
 *
 * WITHOUT COORDINATES A ROW BARELY EXISTS: it can only be found by searching
 * its exact name, never as a nearby car park, which is how people actually use
 * this. EPS covers 51 of the 120; --geocode looks the rest up through OneMap.
 * The estate names ("Defu Industrial Estate (Defu Lane 10)") don't geocode
 * well as-is, so the bracketed part — which is the actual road — is tried
 * first, then the whole name.
 *
 * Re-running replaces the previous JTC import (matched by source URL).
 */
import { readFileSync } from "node:fs";
import { publicEpsCarparks } from "../src/lib/sources/eps";
import { geocode } from "../src/lib/onemap";

const JSON_PATH = "/tmp/jtc-rates.json";
const SOURCE_URL =
  "https://www.jtc.gov.sg/-/media/project/jtc-cx/corpweb/assets/get-help/season-parking/jtc_carpark-details_jan-2025.pdf";
/** The document's edition, which is when these rates were last true at source. */
const EDITION = "2025-01-01";

interface JtcRow {
  name: string;
  operator: string | null;
  weekday: string | null;
  friday: string | null;
  saturday: string | null;
  sundayPh: string | null;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** EPS coordinates for a JTC name, when the names genuinely line up. */
function epsCoords(name: string): { lat: number; lng: number } | null {
  const k = norm(name);
  const exact = publicEpsCarparks.find(
    (c) => norm(c.name) === k || norm(c.address) === k,
  );
  if (exact) return exact.location;
  if (k.length < 8) return null;
  const loose = publicEpsCarparks.find((c) => {
    const n = norm(c.name);
    const a = norm(c.address);
    return (
      (n.length >= 8 && (n.includes(k) || k.includes(n))) ||
      (a.length >= 8 && a.includes(k))
    );
  });
  return loose ? loose.location : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Singapore's bounding box. OneMap will happily return a confident match for a
 * name it doesn't really know, and a car park pinned in the wrong place is
 * worse than one with no pin at all — it shows up as "nearby" to the wrong
 * destination entirely.
 */
function inSingapore(p: { lat: number; lng: number }): boolean {
  return p.lat > 1.13 && p.lat < 1.5 && p.lng > 103.55 && p.lng < 104.15;
}

/** OneMap lookup for a JTC name, most specific form first. */
async function geocodeName(name: string): Promise<{ lat: number; lng: number } | null> {
  const inBrackets = name.match(/\(([^)]+)\)/)?.[1]?.trim();
  const candidates = [inBrackets, name.replace(/\s*\([^)]*\)/, "").trim(), name]
    .filter((v): v is string => Boolean(v && v.length > 3));

  for (const q of [...new Set(candidates)]) {
    const hit = await geocode(q).catch(() => null);
    await sleep(300); // be gentle on OneMap
    if (hit && inSingapore(hit.location)) return hit.location;
  }
  return null;
}

async function main() {
  const dry = process.argv.includes("--dry");
  const doGeocode = process.argv.includes("--geocode");
  const rows = JSON.parse(readFileSync(JSON_PATH, "utf8")) as JtcRow[];
  const usable = rows.filter((r) => r.weekday || r.friday);
  console.log(`JTC car parks: ${rows.length}, with a car rate: ${usable.length}`);

  let withCoords = 0;
  for (const r of usable) if (epsCoords(r.name)) withCoords++;
  console.log(`  coordinates borrowed from EPS: ${withCoords}, coordless: ${usable.length - withCoords}`);

  if (dry) {
    for (const r of usable.slice(0, 5)) {
      const c = epsCoords(r.name);
      console.log(`\n  ${r.name}  ${c ? `@ ${c.lat.toFixed(4)},${c.lng.toFixed(4)}` : "(no coords)"}`);
      console.log(`    wk: ${(r.weekday ?? "-").slice(0, 90)}`);
    }
    console.log("\n--dry: nothing written.");
    return;
  }

  const { upsertOverride, deleteOverridesBySourceUrlLike } = await import(
    "../src/lib/store/rates"
  );
  const removed = deleteOverridesBySourceUrlLike(`${new URL(SOURCE_URL).origin}%`);
  if (removed > 0) console.log(`Cleared ${removed} rows from a previous JTC import.`);

  let saved = 0;
  let geocoded = 0;
  for (const r of usable) {
    let c = epsCoords(r.name);
    if (!c && doGeocode) {
      c = await geocodeName(r.name);
      if (c) geocoded++;
    }
    upsertOverride({
      matchType: "name",
      matchValue: r.name,
      displayName: r.name,
      weekdayRate: r.weekday,
      fridayRate: r.friday,
      saturdayRate: r.saturday,
      sundayPhRate: r.sundayPh,
      source: "operator-site",
      sourceUrl: SOURCE_URL,
      verifiedAt: EDITION,
      notes:
        `From JTC's carpark details document (Jan 2025 edition), jtc.gov.sg.` +
        (r.operator ? ` Operated by ${r.operator}.` : "") +
        ` Motorcycle/heavy-vehicle and season rates are in the source.`,
      lat: c?.lat ?? null,
      lng: c?.lng ?? null,
    });
    saved++;
  }
  console.log(
    `Saved ${saved} JTC car parks` +
      (doGeocode ? `, ${geocoded} of them geocoded through OneMap.` : "."),
  );
}

if (process.argv[1] && process.argv[1].endsWith("importJtc.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
