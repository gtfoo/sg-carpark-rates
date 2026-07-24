/**
 * Verifies your OneMap credentials work, without printing them.
 *
 *   npm run check-onemap
 *
 * Prints only whether each step succeeded and the resulting distances — never
 * the token, the email, or the password.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Minimal .env.local loader so this script works outside the Next runtime.
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
      /* file absent — fine */
    }
  }
}

function mask(present: boolean): string {
  return present ? "set" : "not set";
}

async function main() {
  // Env must be loaded before the modules that read it are imported, so these
  // are dynamic imports inside main rather than static imports at the top.
  loadEnv();
  const { getOneMapToken } = await import("../src/lib/onemapAuth");
  const { walkingDistanceMetres, geocode } = await import("../src/lib/onemap");
  const { haversineMetres } = await import("../src/lib/geo");

  console.log("OneMap credential check\n");
  console.log(`  ONEMAP_TOKEN     ${mask(!!process.env.ONEMAP_TOKEN)}`);
  console.log(`  ONEMAP_EMAIL     ${mask(!!process.env.ONEMAP_EMAIL)}`);
  console.log(`  ONEMAP_PASSWORD  ${mask(!!process.env.ONEMAP_PASSWORD)}\n`);

  const token = await getOneMapToken();
  if (!token) {
    console.log("FAIL  Could not obtain a token.");
    console.log("      Add ONEMAP_EMAIL and ONEMAP_PASSWORD to .env.local");
    console.log("      (copy .env.example), then run this again.");
    process.exit(1);
  }
  console.log(`PASS  Token obtained (${token.length} chars, not shown).\n`);

  const from = await geocode("Tampines Mall");
  if (!from) {
    console.log("FAIL  Geocoding failed.");
    process.exit(1);
  }
  console.log(`PASS  Geocoded "${from.name}".\n`);

  // Route to a real carpark from the dataset rather than a second geocode —
  // this mirrors exactly what the app does, and avoids depending on OneMap
  // being able to parse an HDB block address (it often cannot).
  const { fetchHdbCarparks } = await import("../src/lib/sources/hdb");
  const carparks = await fetchHdbCarparks();
  const nearest = carparks
    .map((c) => ({ c, d: haversineMetres(from.location, c.location) }))
    .sort((a, b) => a.d - b.d)[0];

  if (!nearest) {
    console.log("FAIL  No carparks loaded.");
    process.exit(1);
  }

  const straight = nearest.d;
  const walk = await walkingDistanceMetres(from.location, nearest.c.location);

  if (walk === null) {
    console.log("FAIL  Routing call did not return a distance.");
    console.log("      The token was obtained but rejected by the routing API.");
    process.exit(1);
  }

  const uplift = ((walk / straight - 1) * 100).toFixed(0);
  console.log(`PASS  Routing works — ${from.name} to ${nearest.c.carparkNo}`);
  console.log(`        straight-line  ${Math.round(straight)} m`);
  console.log(`        walking route  ${Math.round(walk)} m  (+${uplift}%)`);
  console.log("\nWalking distances are now live in the app.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
