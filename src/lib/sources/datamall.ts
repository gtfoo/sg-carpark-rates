import { haversineMetres, type LatLng } from "../geo";

/**
 * LTA DataMall carpark availability.
 *
 * The data.gov.sg availability feed this app already uses covers HDB car parks
 * only, which is why every commercial and URA card reads "No live lot data".
 * DataMall publishes live lots for HDB, LTA and URA car parks in one feed, so
 * it fills exactly that gap.
 *
 * Two things it does NOT give, which shape how results are displayed:
 *  - no total capacity, only free lots. A card can say "42 lots free" but not
 *    "42 of 100", and no fullness bar can be drawn.
 *  - no stable key we already hold. Records carry a CarParkID that is the
 *    agency's own, so matching is done on position.
 *
 * Free AccountKey (registration required):
 * https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html
 */
const URL = "https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2";

/** DataMall pages in 500-record blocks. */
const PAGE = 500;
/** The feed refreshes about once a minute; don't hammer it per search. */
const TTL_MS = 60_000;

export interface CarparkLots {
  id: string;
  development: string;
  location: LatLng;
  availableLots: number;
  agency: string;
}

interface RawRecord {
  CarParkID?: string;
  Development?: string;
  Location?: string;
  AvailableLots?: number | string;
  LotType?: string;
  Agency?: string;
}

export function isDataMallConfigured(): boolean {
  return Boolean(process.env.LTA_DATAMALL_KEY);
}

/** "1.37429 103.897" -> LatLng. Blank for a few records, which are skipped. */
function parseLocation(raw: string | undefined): LatLng | null {
  const parts = (raw ?? "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // A few records carry 0,0 — worse than useless, they'd match nothing sanely.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

let cache: { at: number; data: CarparkLots[] } | null = null;

/**
 * All car parks with live lots, cars only. Returns [] rather than throwing:
 * availability is a nicety, and a DataMall outage must not fail a search.
 */
export async function fetchCarparkLots(): Promise<CarparkLots[]> {
  const key = process.env.LTA_DATAMALL_KEY;
  if (!key) return [];
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const out: CarparkLots[] = [];
  try {
    for (let skip = 0; skip < 10_000; skip += PAGE) {
      const res = await fetch(`${URL}?$skip=${skip}`, {
        headers: { AccountKey: key, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`DataMall HTTP ${res.status}`);
      const body = (await res.json()) as { value?: RawRecord[] };
      const rows = body.value ?? [];
      for (const r of rows) {
        // "C" is cars; the feed also carries motorcycle and heavy-vehicle lots.
        if (r.LotType && r.LotType.toUpperCase() !== "C") continue;
        const location = parseLocation(r.Location);
        if (!location) continue;
        const lots = Number(r.AvailableLots);
        if (!Number.isFinite(lots)) continue;
        out.push({
          id: String(r.CarParkID ?? ""),
          development: (r.Development ?? "").trim(),
          location,
          availableLots: lots,
          agency: (r.Agency ?? "").trim(),
        });
      }
      if (rows.length < PAGE) break;
    }
  } catch (err) {
    console.warn("DataMall availability unavailable:", err instanceof Error ? err.message : err);
    // Serve a stale page rather than nothing — a minute-old count still helps.
    return cache?.data ?? [];
  }

  cache = { at: Date.now(), data: out };
  return out;
}

/**
 * The non-HDB records: URA and LTA car parks.
 *
 * HDB lots already come from the dedicated data.gov.sg feed, matched by car
 * park NUMBER — exact, no guessing. HDB is also 94% of this feed (1,992 of
 * 2,119), so leaving those records in lets a commercial car park positionally
 * match a housing block across the road and display its lot count. Dropping
 * them is what makes the positional match trustworthy.
 */
export function commercialOnly(all: CarparkLots[]): CarparkLots[] {
  return all.filter((c) => c.agency.toUpperCase() !== "HDB");
}

const normalise = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * How confidently do these name the same place?
 *
 * "exact" once punctuation is stripped ("The Atrium @ Orchard" =
 * "The Atrium@Orchard"). "partial" when one contains the other, which catches
 * "Cathay Cineleisure Orchard" -> "Cineleisure" but also mis-fires on shared
 * prefixes: "Bugis+" normalises to BUGIS, a substring of BUGISCUBE and
 * BUGISJUNCTION, which are different malls. Partial matches therefore have to
 * earn it on distance too.
 */
function nameMatch(a: string, b: string): "exact" | "partial" | "none" {
  const x = normalise(a);
  const y = normalise(b);
  if (x.length < 5 || y.length < 5) return "none";
  if (x === y) return "exact";
  return x.includes(y) || y.includes(x) ? "partial" : "none";
}

/** A partial name match is only believable if the two are near-neighbours. */
const PARTIAL_MATCH_M = 120;

/**
 * The live-lot record for a car park, or null when nothing matches confidently.
 *
 * DataMall shares no identifier with our sources, so this pairs on NAME and
 * position together. Position alone is not enough and was actively wrong:
 * Orchard and Tampines pack several car parks within 100 m, which had Century
 * Square showing Tampines Mall's lots, Grand Hyatt showing Far East Plaza's,
 * and 22 Bideford Road showing Paragon's. A confidently wrong lot count is
 * worse than none, so a name disagreement rejects the match outright.
 *
 * With the name carrying identity, the distance bound only has to be loose
 * enough to absorb the two sources pinning different corners of one
 * development — DataMall marks the entrance, ours the building.
 */
export function lotsFor(
  location: LatLng,
  name: string,
  all: CarparkLots[],
  maxMetres = 300,
): CarparkLots | null {
  let best: CarparkLots | null = null;
  let bestD = Infinity;
  for (const c of all) {
    const match = nameMatch(name, c.development);
    if (match === "none") continue;
    const limit = match === "exact" ? maxMetres : PARTIAL_MATCH_M;
    const d = haversineMetres(location, c.location);
    if (d > limit || d >= bestD) continue;
    best = c;
    bestD = d;
  }
  return best;
}
