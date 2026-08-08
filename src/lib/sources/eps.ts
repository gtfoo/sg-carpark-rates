import raw from "./eps-carparks.json";
import type { LatLng } from "../geo";

/**
 * LTA EPS car park inventory — the full national list of car parks in the EPS
 * (Electronic Parking System) programme, scraped once from
 * https://eps.lta.gov.sg/EPS_ESERVICES/CarPark (the OutSystems SPA's
 * DataActionGetDetails response).
 *
 * This is an INVENTORY, not rates: it gives name, address, postal code and
 * coordinates so these car parks can be found near a destination, but carries
 * no pricing. A rate can be filled in later per car park via the in-app web
 * lookup or a manual entry. Refresh by re-scraping and regenerating
 * eps-carparks.json.
 */
export interface EpsCarpark {
  id: string;
  name: string;
  address: string;
  postal: string | null;
  location: LatLng;
  /** Public (short-term) parking capacity; null when the feed reports -1/NA. */
  publicLots: number | null;
}

interface RawEps {
  id: string;
  name: string;
  address: string;
  postal: string | null;
  lat: number;
  lng: number;
  publicLots: number | null;
}

/**
 * A handful of CapitaLand-managed sites are listed with a trailing " - C"
 * (the car-park tier, vs the motorcycle/lorry tiers on the operator's own
 * site). There's no matching " - M"/" - L" in this feed, so it's just noise on
 * the display name — drop it.
 */
function cleanName(name: string): string {
  return name.replace(/\s*-\s*C$/i, "").trim();
}

/**
 * Nine URA short-term car parks are listed under URA's internal code —
 * "URA_P0075" — which reaches a card as "Ura_p0075" and tells a driver
 * nothing. The address carries the real identity ("51, LAVENDER STREET,
 * P0075"), so use that, dropping the trailing repeat of the code and joining a
 * bare house number onto its street.
 */
export function displayName(name: string, address: string): string {
  const clean = cleanName(name);
  if (!/^URA[_ ]/i.test(clean)) return clean;
  const code = clean.replace(/^URA[_ ]/i, "").trim().toUpperCase();
  const parts = address
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.toUpperCase() !== code && !/^singapore\b/i.test(s));
  // "0, TIONG BAHRU ROAD" — a placeholder house number, not an address.
  if (parts[0] === "0") parts.shift();
  if (!parts.length) return clean;
  if (parts.length > 1 && /^\d+[A-Z]?$/i.test(parts[0]!)) {
    return [`${parts[0]} ${parts[1]}`, ...parts.slice(2)].join(", ");
  }
  return parts.join(", ");
}

const all: EpsCarpark[] = (raw as RawEps[]).map((c) => ({
  id: c.id,
  name: displayName(c.name, c.address),
  address: c.address,
  postal: c.postal,
  location: { lat: c.lat, lng: c.lng },
  publicLots: c.publicLots,
}));

/** The complete inventory (all ~3,167 car parks, including season-only ones). */
export const allEpsCarparks: EpsCarpark[] = all;

/**
 * EPS lists HDB car parks under their internal code instead of a name, e.g.
 * "HDB_J4_J5" (which is really Blk 201 Jurong East Street 21). Half this feed
 * is such entries, and ~88% of them sit within 100 m of a car park the HDB
 * dataset already covers properly — with a readable name, live lot counts and
 * a computed rate. Surfacing them again would show an unreadable code with no
 * rate, so they're excluded from search; the HDB source owns those car parks.
 */
function isHdbCode(name: string): boolean {
  return /^HDB[_ ]/i.test(name);
}

/**
 * Car parks that actually offer public (short-term) parking — the subset worth
 * surfacing as parking options. Season- or heavy-vehicle-only entries (public
 * lots reported as -1/0) are kept in the full inventory but left out of search,
 * as are the HDB-coded duplicates above.
 */
export const publicEpsCarparks: EpsCarpark[] = all.filter(
  (c) => c.publicLots !== null && c.publicLots > 0 && !isHdbCode(c.name),
);
