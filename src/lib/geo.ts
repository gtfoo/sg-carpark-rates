import proj4 from "proj4";

/**
 * SVY21 (EPSG:3414) is Singapore's national projected CRS. The HDB carpark
 * dataset publishes x_coord/y_coord in SVY21 metres, NOT lat/lng — feeding
 * those straight into a map silently puts every carpark off the coast of
 * Africa. Convert once, at ingest.
 */
const SVY21 =
  "+proj=tmerc +lat_0=1.366666666666667 +lon_0=103.8333333333333 " +
  "+k=1 +x_0=28001.642 +y_0=38744.572 +ellps=WGS84 +units=m +no_defs";

const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

export interface LatLng {
  lat: number;
  lng: number;
}

export function svy21ToLatLng(x: number, y: number): LatLng {
  const [lng, lat] = proj4(SVY21, WGS84, [x, y]);
  return { lat: lat as number, lng: lng as number };
}

const EARTH_RADIUS_M = 6_371_000;

/**
 * Straight-line distance. Used for the initial nearest-N shortlist only —
 * real walking distance needs OneMap routing (requires an account), and will
 * always be longer than this because of roads, rivers and building footprints.
 */
export function haversineMetres(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * The furthest a rate's own address may sit from the place that was searched
 * for before we treat them as different carparks.
 *
 * Measured, not chosen. Across the 46 AI-retrieved rows whose name OneMap can
 * geocode, the distance between the stored point and the geocode of the row's
 * own name runs: median 0 m, p95 153 m, max 390 m — nothing above 500 m. The
 * two known wrong-building saves sit at 3.5 km (MOE Evans Road given MOE
 * Building's rates at Buona Vista) and 13 km (Midview Building given Midview
 * City's). So 1 km is 2.5x above the worst honest disagreement and 3.5x below
 * the nearest real error, and the gap between those populations is 9x wide.
 */
export const MAX_LOCATION_MISMATCH_M = 1000;

export type LocationVerdict =
  | { ok: true; reason: "verified"; metres: number }
  | { ok: true; reason: "unverifiable" }
  | { ok: false; metres: number };

/**
 * Does a rate belong to the place that was asked for?
 *
 * Name similarity is the intuitive check and is provably useless here: both
 * wrong saves SHARE their distinctive token with the building they were
 * confused with ("Midview City"/"Midview Building", "MOE (Evans Road)"/
 * "Ministry of Education Building (MOE)"). Names caused the error, so names
 * cannot detect it. Geography is an independent signal.
 *
 * It answers "unverifiable" — never "no" — when either point is missing. A
 * guard that fired on absent data would reject good rates and burn a lookup
 * for each, which is how the first citation audit came to flag 330 rows and be
 * wrong about 328 of them. Only two coordinates that genuinely disagree are
 * evidence of anything.
 */
export function checkLocation(
  queried: LatLng | null | undefined,
  found: LatLng | null | undefined,
  maxMetres: number = MAX_LOCATION_MISMATCH_M,
): LocationVerdict {
  if (!queried || !found) return { ok: true, reason: "unverifiable" };
  const metres = Math.round(haversineMetres(queried, found));
  return metres > maxMetres ? { ok: false, metres } : { ok: true, reason: "verified", metres };
}
