/**
 * Correctness check for the SVY21 -> WGS84 transform.
 *
 * OneMap's search endpoint returns BOTH the SVY21 (X/Y) and WGS84
 * (LATITUDE/LONGITUDE) for the same point, which gives us free ground truth:
 * convert their X/Y ourselves and see whether we land on their lat/lng.
 */
import { svy21ToLatLng, haversineMetres } from "../src/lib/geo";

const LANDMARKS = [
  "ION Orchard",
  "Changi Airport Terminal 3",
  "Jurong Point",
  "Tampines Mall",
  "VivoCity",
  "Woodlands Civic Centre",
];

interface OneMapHit {
  SEARCHVAL: string;
  X: string;
  Y: string;
  LATITUDE: string;
  LONGITUDE: string;
}

async function main() {
  console.log("SVY21 -> WGS84 transform validation (ground truth: OneMap)\n");

  let worst = 0;
  let failures = 0;

  for (const name of LANDMARKS) {
    const url =
      `https://www.onemap.gov.sg/api/common/elastic/search` +
      `?searchVal=${encodeURIComponent(name)}&returnGeom=Y&getAddrDetails=Y`;
    const res = await fetch(url);
    const body = (await res.json()) as { results: OneMapHit[] };
    const hit = body.results?.[0];
    if (!hit) {
      console.log(`  ?  ${name}: no result`);
      continue;
    }

    const ours = svy21ToLatLng(Number(hit.X), Number(hit.Y));
    const theirs = { lat: Number(hit.LATITUDE), lng: Number(hit.LONGITUDE) };
    const errorM = haversineMetres(ours, theirs);
    worst = Math.max(worst, errorM);

    const ok = errorM < 1.0;
    if (!ok) failures++;

    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${hit.SEARCHVAL.padEnd(34)} ` +
        `error ${errorM.toFixed(3)} m`,
    );
  }

  console.log(`\nWorst error: ${worst.toFixed(3)} m`);
  if (failures > 0) {
    console.log(`${failures} landmark(s) exceeded the 1 m threshold.`);
    process.exit(1);
  }
  console.log("Transform is correct — safe to convert the full dataset.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
