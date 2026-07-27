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

const all: EpsCarpark[] = (raw as RawEps[]).map((c) => ({
  id: c.id,
  name: cleanName(c.name),
  address: c.address,
  postal: c.postal,
  location: { lat: c.lat, lng: c.lng },
  publicLots: c.publicLots,
}));

/** The complete inventory (all ~3,167 car parks, including season-only ones). */
export const allEpsCarparks: EpsCarpark[] = all;

/**
 * Car parks that actually offer public (short-term) parking — the subset worth
 * surfacing as parking options. Season- or heavy-vehicle-only entries (public
 * lots reported as -1/0) are kept in the full inventory but left out of search.
 */
export const publicEpsCarparks: EpsCarpark[] = all.filter(
  (c) => c.publicLots !== null && c.publicLots > 0,
);
