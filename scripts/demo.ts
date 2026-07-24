/**
 * End-to-end demo of the data layer.
 *
 *   npm run demo -- "Ion Orchard" 120
 *
 * Proves the full path: destination -> nearest carparks -> type/shelter/app
 * -> live availability -> calculated fee.
 */
import { fetchHdbCarparks, type HdbCarpark } from "../src/lib/sources/hdb";
import { fetchAvailability, type Availability } from "../src/lib/sources/availability";
import { geocode, walkingDistanceMetres } from "../src/lib/onemap";
import { haversineMetres } from "../src/lib/geo";
import { calculateHdbFee, isProbablyCentral } from "../src/lib/fees";
import { getPublicHolidays } from "../src/lib/sources/holidays";
import { parseSgtLocal, formatSgtTime } from "../src/lib/time";

interface Row {
  carpark: HdbCarpark;
  straightLineM: number;
  walkM: number | null;
  availability: Availability | undefined;
}

async function main() {
  const destination = process.argv[2] ?? "Ion Orchard";
  const minutes = Number(process.argv[3] ?? 120);
  // Optional 3rd arg: "YYYY-MM-DDTHH:mm" in Singapore time.
  const start = process.argv[4]
    ? (parseSgtLocal(process.argv[4]) ?? new Date())
    : new Date();
  const holidays = new Set((await getPublicHolidays()).keys());

  console.log(
    `Destination: "${destination}"   Duration: ${minutes} min   Start: ${formatSgtTime(start)} SGT\n`,
  );

  const place = await geocode(destination);
  if (!place) {
    console.error("Could not geocode that destination.");
    process.exit(1);
  }
  console.log(`Resolved -> ${place.name}`);
  console.log(`           ${place.address}`);
  console.log(
    `           ${place.location.lat.toFixed(6)}, ${place.location.lng.toFixed(6)}\n`,
  );

  const [carparks, availability] = await Promise.all([
    fetchHdbCarparks(),
    fetchAvailability(),
  ]);
  console.log(
    `Loaded ${carparks.length} HDB carparks, ${availability.size} with live availability.\n`,
  );

  const nearest: Row[] = carparks
    .map((c) => ({
      carpark: c,
      straightLineM: haversineMetres(place.location, c.location),
      walkM: null,
      availability: availability.get(c.carparkNo),
    }))
    .sort((a, b) => a.straightLineM - b.straightLineM)
    .slice(0, 8);

  // Real walking distance only if OneMap credentials are present.
  for (const row of nearest) {
    row.walkM = await walkingDistanceMetres(place.location, row.carpark.location);
  }
  const usingRealWalk = nearest.some((r) => r.walkM !== null);

  const central = isProbablyCentral(place.location.lat, place.location.lng);
  console.log(
    `Fee band: ${central ? "CENTRAL" : "NON-CENTRAL"} ` +
      `(derived from coordinates — see isProbablyCentral caveat)\n`,
  );

  const header = [
    "Carpark".padEnd(10),
    "Type".padEnd(12),
    "Shelter".padEnd(10),
    "App".padEnd(5),
    (usingRealWalk ? "Walk" : "Dist").padEnd(8),
    "Lots".padEnd(12),
    "Fee",
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length + 6));

  for (const row of nearest) {
    const c = row.carpark;
    const fee = calculateHdbFee({
      start,
      minutes,
      isCentral: central,
      perMinuteBilling: !c.needsParkingApp,
      freeParking: c.freeParking,
      shortTermParking: c.shortTermParking,
      nightParking: c.nightParking,
      holidays,
    });

    const lots = row.availability
      ? `${row.availability.lotsAvailable}/${row.availability.totalLots}`
      : "no feed";

    const dist = row.walkM ?? row.straightLineM;

    console.log(
      [
        c.carparkNo.padEnd(10),
        shortType(c.carparkType).padEnd(12),
        c.shelter.padEnd(10),
        (c.needsParkingApp ? "yes" : "no").padEnd(5),
        `${Math.round(dist)}m`.padEnd(8),
        lots.padEnd(12),
        `$${fee.total.toFixed(2)}`,
      ].join(" "),
    );
    console.log(`           ${c.address}`);
  }

  console.log("\nCaveats on the above:");
  console.log("  - Shelter is INFERRED from carpark structure, not published.");
  if (!usingRealWalk) {
    console.log(
      "  - Distance is straight-line. Set ONEMAP_TOKEN for real walking routes",
    );
    console.log("    (true walk is typically 20-40% longer in built-up areas).");
  }
  console.log("  - Central/non-central band is derived from a placeholder box.");
  console.log("  - Fees include 9% GST; verify the rate schedule before shipping.");
  console.log("  - HDB carparks only. Malls are a separate, less reliable source.");
}

function shortType(t: string): string {
  if (t.includes("MULTI-STOREY")) return "multi-storey";
  if (t.includes("BASEMENT")) return "basement";
  if (t.includes("SURFACE")) return "surface";
  return t.toLowerCase().slice(0, 12);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
