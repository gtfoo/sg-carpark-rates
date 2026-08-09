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
/**
 * Is this a filing code rather than a place? "URA_P0075", "CP13_CP14_CP15",
 * "HDH203", "TP57_TP59" — operators file car parks under internal references
 * and EPS passes them through, so they reach a card as "Ura_p0075" and tell a
 * driver nothing.
 *
 * Chasing them one prefix at a time didn't work: a sweep of the inventory found
 * thirteen across eight different prefixes beyond the two already handled. So
 * the test is structural — every part is a short reference and at least one
 * carries a digit. Requiring the digit is what keeps real names out: "AMOY ST"
 * and "112 KATONG" both survive it.
 */
function isCodeName(name: string): boolean {
  const tokens = name.toUpperCase().trim().split(/[_\s-]+/).filter(Boolean);
  if (!tokens.length) return false;
  const isRef = (t: string) =>
    /^[A-Z]{1,4}\d{1,5}$/.test(t) || /^\d{1,5}[A-Z]?$/.test(t) || /^(HDB|URA|CP|MSCP|BLK)$/.test(t);
  return tokens.every(isRef) && tokens.some((t) => /\d/.test(t));
}

export function displayName(name: string, address: string): string {
  const clean = cleanName(name);
  // HDB codes are left exactly as they are: publicEpsCarparks filters on this
  // name, so renaming them would defeat isHdbCode and let 1,298 duplicates of
  // the HDB dataset back into search.
  if (/^HDB[_ ]/i.test(clean)) return clean;
  if (!isCodeName(clean)) return clean;
  // Every part of the code, so the address doesn't just repeat it back.
  const codes = new Set(clean.toUpperCase().split(/[_\s-]+/).filter(Boolean));
  const parts = address
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !codes.has(s.toUpperCase()) && !/^singapore\b/i.test(s));
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

/** "…HEAVY VEHICLE" / "LORRY PARK" — a car can't park there. */
function isHeavyVehicleOnly(name: string): boolean {
  return /\b(heavy vehicle|lorry|container)\b/i.test(name);
}

/**
 * Car parks worth surfacing as parking options.
 *
 * `publicLots` used to gate this, on the reading that 0 meant season-only. It
 * doesn't: CT Hub 2 is listed with 0 and takes hourly public parking, and so is
 * "100 Pasir Panjang", for which we already hold a rate. The flag was hiding
 * 1,241 non-HDB car parks, 712 of them nowhere near anything we can price — so
 * it was removing them from the map as well as from the price list.
 *
 * They carry no rate, so they arrive as "location only" cards. Two things stop
 * that swamping a search: the result list sorts priced cards above unpriced
 * ones, and search fills its slots with car parks it can price before it falls
 * back to this inventory.
 *
 * Still excluded: the HDB-coded duplicates above, and heavy-vehicle parks.
 */
export const publicEpsCarparks: EpsCarpark[] = all.filter(
  (c) => !isHdbCode(c.name) && !isHeavyVehicleOnly(c.name),
);
