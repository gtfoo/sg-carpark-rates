/**
 * Bakes the URA Central Area boundary into the repo.
 *
 *   npm run import-central-area
 *
 * HDB charges its higher short-term parking rate ($1.20 vs $0.60 per half
 * hour) at car parks in the CENTRAL AREA, and no published dataset carries
 * that flag — so it has to be derived from the car park's position. The Central
 * Area is these 11 URA planning areas. Note it is NOT the same as the Central
 * REGION: Bukit Merah (Tiong Bahru) and Queenstown (Tanglin Halt) sit in the
 * region but not the area, and charging them the central rate doubled their
 * price.
 *
 * OneMap serves the boundaries, so this fetches them once and writes the outer
 * rings to src/lib/sources/central-area.json. Re-run only if URA redraws the
 * planning areas.
 */
import { readFileSync, writeFileSync } from "node:fs";
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

/** The URA Central Area: 11 planning areas. */
const CENTRAL_AREA_NAMES = new Set([
  "DOWNTOWN CORE",
  "MARINA EAST",
  "MARINA SOUTH",
  "MUSEUM",
  "NEWTON",
  "ORCHARD",
  "OUTRAM",
  "RIVER VALLEY",
  "ROCHOR",
  "SINGAPORE RIVER",
  "STRAITS VIEW",
]);

/** ~1 m precision — far finer than a car park needs, and much smaller on disk. */
const round = (n: number) => Math.round(n * 1e5) / 1e5;

async function main() {
  loadEnv();
  const { getOneMapToken } = await import("../src/lib/onemapAuth");
  const token = await getOneMapToken();
  if (!token) {
    console.error("No OneMap token — set ONEMAP_EMAIL / ONEMAP_PASSWORD in .env.local.");
    process.exit(1);
  }

  const res = await fetch(
    "https://www.onemap.gov.sg/api/public/popapi/getAllPlanningarea?year=2019",
    { headers: { Authorization: token } },
  );
  if (!res.ok) throw new Error(`OneMap planning areas failed: HTTP ${res.status}`);
  const body = (await res.json()) as
    | { SearchResults?: { pln_area_n: string; geojson: string }[] }
    | { pln_area_n: string; geojson: string }[];
  const rows = Array.isArray(body) ? body : (body.SearchResults ?? []);

  const rings: number[][][] = [];
  const found: string[] = [];
  for (const row of rows) {
    const name = (row.pln_area_n ?? "").toUpperCase().trim();
    if (!CENTRAL_AREA_NAMES.has(name)) continue;
    found.push(name);
    const geo = JSON.parse(row.geojson) as {
      type: string;
      coordinates: number[][][] | number[][][][];
    };
    // Outer ring of each polygon. Planning areas have no meaningful holes, and
    // a car park sitting in one would be a curiosity, not a rate boundary.
    const polygons =
      geo.type === "MultiPolygon"
        ? (geo.coordinates as number[][][][])
        : [geo.coordinates as number[][][]];
    for (const poly of polygons) {
      const outer = poly[0];
      if (!outer) continue;
      rings.push(outer.map(([lng, lat]) => [round(lng!), round(lat!)]));
    }
  }

  const missing = [...CENTRAL_AREA_NAMES].filter((n) => !found.includes(n));
  if (missing.length) {
    console.warn(`WARNING: planning areas not returned by OneMap: ${missing.join(", ")}`);
  }

  const out = join(process.cwd(), "src", "lib", "sources", "central-area.json");
  writeFileSync(out, JSON.stringify(rings));
  const kb = (JSON.stringify(rings).length / 1024).toFixed(0);
  console.log(
    `Wrote ${rings.length} rings from ${found.length}/${CENTRAL_AREA_NAMES.size} ` +
      `planning areas (${kb} KB) to ${out}`,
  );
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
