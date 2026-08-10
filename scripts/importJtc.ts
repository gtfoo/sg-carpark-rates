/**
 * Files JTC's published car park rates into the rate store.
 *
 *   curl -sL -o /tmp/jtc-carparks.pdf "https://www.jtc.gov.sg/-/media/project/jtc-cx/corpweb/assets/get-help/season-parking/jtc_carpark-details_jan-2025.pdf"
 *   python3 scripts/jtcRates.py /tmp/jtc-carparks.pdf /tmp/jtc-rates.json
 *   npx tsx scripts/importJtc.ts -- --dry
 *   npx tsx scripts/importJtc.ts
 *
 * The PDF is JTC's own "carpark details" document (Jan 2025 edition) — one
 * block per car park with per-day, per-band rates. jtcRates.py turns it into
 * JSON; this files the Car rates, borrowing coordinates from the EPS inventory
 * where the names line up so the car park can appear as a nearby card. Rows
 * are dated to the document's edition, not the day this ran.
 *
 * Re-running replaces the previous JTC import (matched by source URL).
 */
import { readFileSync } from "node:fs";
import { publicEpsCarparks } from "../src/lib/sources/eps";

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

async function main() {
  const dry = process.argv.includes("--dry");
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
  for (const r of usable) {
    const c = epsCoords(r.name);
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
  console.log(`Saved ${saved} JTC car parks.`);
}

if (process.argv[1] && process.argv[1].endsWith("importJtc.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
