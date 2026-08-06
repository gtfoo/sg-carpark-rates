/**
 * Imports URA car park details (with rates) from the URA Data Service API.
 *
 *   npm run import-ura -- --dry    # fetch + show what would be saved
 *   npm run import-ura             # fetch and save
 *
 * Needs URA_ACCESS_KEY in .env.local (free, from
 * https://eservice.ura.gov.sg/maps/api/reg.html).
 *
 * Unlike the LTA/EPS sources this is an official API: structured rates and
 * SVY21 coordinates, so nothing is scraped, parsed from prose, or geocoded.
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

const SOURCE_URL =
  "https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1?service=Car_Park_Details";

async function main() {
  loadEnv();
  const dry = process.argv.includes("--dry");

  const { isUraConfigured, fetchUraCarparks } = await import("../src/lib/sources/ura");
  if (!isUraConfigured()) {
    console.log("URA_ACCESS_KEY is not set in .env.local.");
    console.log("Register (free): https://eservice.ura.gov.sg/maps/api/reg.html");
    process.exit(1);
  }

  console.log("Fetching URA car park details…\n");
  const carparks = await fetchUraCarparks();
  console.log(`Received ${carparks.length} car parks (cars only).`);

  const withRate = carparks.filter((c) => c.weekdayRate);
  const withCoords = carparks.filter((c) => c.location);
  console.log(`  with a weekday rate: ${withRate.length}`);
  console.log(`  with coordinates:    ${withCoords.length}\n`);

  console.log("Sample:");
  for (const c of carparks.slice(0, 8)) {
    console.log(
      `  ${c.code.padEnd(8)} ${c.name.slice(0, 30).padEnd(31)} ` +
        `wd=${(c.weekdayRate ?? "-").padEnd(20)} ` +
        `${c.location ? `${c.location.lat.toFixed(4)},${c.location.lng.toFixed(4)}` : "no coords"}`,
    );
  }

  if (dry) {
    console.log("\n--dry: nothing written.");
    return;
  }

  const { upsertOverride, deleteOverridesBySourceUrlLike } = await import(
    "../src/lib/store/rates"
  );
  const removed = deleteOverridesBySourceUrlLike("%uraDataService%");
  if (removed > 0) console.log(`\nCleared ${removed} rows from a previous URA import.`);

  // Lorry / heavy-vehicle parks ("… HVP") have no standard car lots, so they
  // aren't parking options for a car — don't store them as rates at all.
  const isHeavyVehicle = (n: string) =>
    /\bHVP\b|HEAVY[\s-]?VEHICLE|\bLORRY\b/i.test(n);

  let saved = 0;
  let skippedHv = 0;
  for (const c of carparks) {
    if (!c.weekdayRate && !c.saturdayRate && !c.sundayPhRate) continue;
    if (isHeavyVehicle(c.name)) {
      skippedHv++;
      continue;
    }
    upsertOverride({
      matchType: "name",
      matchValue: c.name,
      displayName: c.name,
      weekdayRate: c.weekdayRate,
      saturdayRate: c.saturdayRate,
      sundayPhRate: c.sundayPhRate,
      source: "operator-site",
      sourceUrl: SOURCE_URL,
      verifiedAt: new Date().toISOString().slice(0, 10),
      notes:
        `URA official rates${c.band ? ` (${c.band})` : ""}` +
        `${c.capacity ? `, ${c.capacity} lots` : ""}.`,
      lat: c.location?.lat ?? null,
      lng: c.location?.lng ?? null,
    });
    saved++;
  }
  console.log(
    `\nDone. Saved ${saved} URA car parks with rates` +
      `${skippedHv ? ` (skipped ${skippedHv} heavy-vehicle parks)` : ""}.`,
  );
}

main().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  console.error(
    "\nIf this is an auth/shape error, the token endpoint or field names may differ —\n" +
      "paste the error and I'll adjust src/lib/sources/ura.ts.",
  );
  process.exit(1);
});
