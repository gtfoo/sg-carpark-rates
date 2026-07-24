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
