import type { LatLng } from "./geo";
import { getOneMapToken } from "./onemapAuth";

/**
 * OneMap search is the one endpoint that needs no authentication, and it
 * conveniently returns both SVY21 (X/Y) and WGS84 (LATITUDE/LONGITUDE).
 *
 * Routing (walking distance) and coordinate conversion both return 401 —
 * they need a free OneMap account and a 3-day JWT. See walkingDistance().
 */
const SEARCH = "https://www.onemap.gov.sg/api/common/elastic/search";

export interface GeocodeResult {
  name: string;
  address: string;
  /** Postal code, or null when OneMap returns "NIL". Used to match saved rates. */
  postal: string | null;
  location: LatLng;
}

/**
 * A second spelling of a query worth retrying, or null if there isn't one.
 *
 * OneMap's search cannot find a building by its own name when that name
 * contains "&". "ABC BRICKWORKS MARKET & FOOD CENTRE" is indexed under exactly
 * that string and returns nothing; drop the ampersand and it is found at once.
 * The same holds for "TEKKA MARKET & FOOD CENTRE" and, in our own store,
 * "Waterfront Plaza & King's Centre".
 *
 * That matters more here than the one hawker centre suggests: "Market & Food
 * Centre" is a naming convention across Singapore, so every one of them was
 * unsearchable.
 *
 * Substituting "and" does NOT work — that returns nothing too. The ampersand
 * has to go entirely.
 *
 * Tried only after the verbatim query, so a future fix on their side simply
 * makes this branch stop firing.
 */
export function retrySpelling(query: string): string | null {
  if (!query.includes("&")) return null;
  const stripped = query.replace(/&/g, " ").replace(/\s{2,}/g, " ").trim();
  return stripped && stripped !== query.trim() ? stripped : null;
}

export async function geocode(query: string): Promise<GeocodeResult | null> {
  const url = `${SEARCH}?searchVal=${encodeURIComponent(query)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;

  // Search used to be fully open. As of Jul 2026 it returns an
  // "Authentication token missing" error alongside results, so send the token
  // when we have one — unauthenticated access is clearly being wound down.
  const token = await getOneMapToken();
  const res = await fetch(
    url,
    token ? { headers: { Authorization: token } } : undefined,
  );
  if (!res.ok) throw new Error(`OneMap search failed: HTTP ${res.status}`);

  const body = (await res.json()) as {
    found: number;
    results: {
      SEARCHVAL: string;
      ADDRESS: string;
      POSTAL: string;
      LATITUDE: string;
      LONGITUDE: string;
    }[];
  };

  const hit = body.results?.[0];
  if (!hit) {
    // Only ever one retry deep: retrySpelling returns null for its own output,
    // so this cannot recurse.
    const again = retrySpelling(query);
    return again ? geocode(again) : null;
  }

  return {
    name: hit.SEARCHVAL,
    address: hit.ADDRESS,
    postal: hit.POSTAL && hit.POSTAL !== "NIL" ? hit.POSTAL : null,
    location: { lat: Number(hit.LATITUDE), lng: Number(hit.LONGITUDE) },
  };
}

export interface Suggestion {
  /** Stable key for React lists and for de-duplication. */
  id: string;
  name: string;
  address: string;
  postal: string | null;
  location: LatLng;
}

/**
 * Address autocomplete, backed by the same OneMap search endpoint.
 *
 * Must be called server-side: the endpoint now requires the OneMap token, and
 * that token must never reach the browser. See /api/suggest.
 *
 * OneMap returns near-duplicate rows for large sites (e.g. "CHANGI AIR BASE
 * (EAST)" three times), so results are de-duplicated before returning.
 */
export async function suggest(query: string, limit = 6): Promise<Suggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const url = `${SEARCH}?searchVal=${encodeURIComponent(trimmed)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const token = await getOneMapToken();

  const res = await fetch(
    url,
    token ? { headers: { Authorization: token } } : undefined,
  );
  if (!res.ok) return [];

  const body = (await res.json()) as {
    results?: {
      SEARCHVAL: string;
      ADDRESS: string;
      POSTAL: string;
      LATITUDE: string;
      LONGITUDE: string;
    }[];
  };

  if (!(body.results ?? []).length) {
    const again = retrySpelling(trimmed);
    if (again) return suggest(again, limit);
  }

  const seen = new Set<string>();
  const out: Suggestion[] = [];

  for (const r of body.results ?? []) {
    const lat = Number(r.LATITUDE);
    const lng = Number(r.LONGITUDE);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    // Same building and postal code is the same place to a user, even when
    // OneMap lists several entrances separately.
    const key = `${r.SEARCHVAL}|${r.POSTAL}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: key,
      name: r.SEARCHVAL,
      address: r.ADDRESS,
      postal: r.POSTAL && r.POSTAL !== "NIL" ? r.POSTAL : null,
      location: { lat, lng },
    });

    if (out.length >= limit) break;
  }

  return out;
}

/**
 * Real walking distance, once you have OneMap credentials.
 *
 * Credentials come from the environment — see onemapAuth.ts. Without them we
 * fall back to straight-line distance, which understates the true walk by
 * typically 20-40% in built-up areas.
 */
export async function walkingDistanceMetres(
  from: LatLng,
  to: LatLng,
): Promise<number | null> {
  const token = await getOneMapToken();
  if (!token) return null;

  const url =
    `https://www.onemap.gov.sg/api/public/routingsvc/route` +
    `?start=${from.lat},${from.lng}&end=${to.lat},${to.lng}&routeType=walk`;

  const res = await fetch(url, { headers: { Authorization: token } });
  if (!res.ok) return null;

  const body = (await res.json()) as {
    route_summary?: { total_distance?: number };
  };
  return body.route_summary?.total_distance ?? null;
}
