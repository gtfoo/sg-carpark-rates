import { fetchHdbCarparks, type HdbCarpark } from "./sources/hdb";
import { fetchAvailability, type Availability } from "./sources/availability";
import { publicEpsCarparks, type EpsCarpark } from "./sources/eps";
import {
  fetchCarparkLots,
  commercialOnly,
  lotsFor,
  type CarparkLots,
} from "./sources/datamall";
import {
  fetchMallRates,
  estimateMallFee,
  parseLimits,
  bandForTime,
  rateForDay,
  rateTextForDay,
  parseRate,
  describeRate,
  NO_LIMITS,
  type MallCarparkRates,
  type MallCarparkRateText,
  type RateLimits,
} from "./sources/mallRates";
import { getPublicHolidays } from "./sources/holidays";
import { geocode, walkingDistanceMetres, type GeocodeResult } from "./onemap";
import { haversineMetres, type LatLng } from "./geo";
import {
  calculateHdbFee,
  classifyDay,
  isProbablyCentral,
  HDB_RATES,
  type DayType,
  type FeeResult,
} from "./fees";
import { toSgt, formatSgtTime } from "./time";
import { formatFee } from "./format";
import {
  findOverrideForCarpark,
  findOverrideForDestination,
  listOverridesWithCoords,
  type RateOverride,
} from "./store/rates";
import { recordGap } from "./store/gaps";
import { readCache, writeCache } from "./store/cache";
import { isLlmConfigured } from "./llm";
import { isSearchConfigured } from "./websearch";

/**
 * Where a fee number came from — shown in the UI so a confident-looking dollar
 * figure is never mistaken for gospel.
 *  - hdb-schedule: computed from the published HDB/URA rate schedule (current)
 *  - lta-dataset:  parsed from LTA's mall dataset (last updated Jun 2024)
 *  - manual / operator-site: a rate you entered yourself
 */
export type FeeSource =
  | "hdb-schedule"
  | "lta-dataset"
  | "manual"
  | "operator-site"
  | "web-llm"
  // eps-inventory: a car park from the LTA EPS list — location only, no rate yet.
  | "eps-inventory";

export interface CarparkResult {
  id: string;
  name: string;
  operator: "HDB" | "Commercial";
  carparkType: string;
  shelter: string;
  needsParkingApp: boolean;
  /**
   * null for commercial carparks — the LTA rates dataset has no coordinates,
   * only a name string, so those can be listed but never mapped.
   */
  location: LatLng | null;
  distanceM: number;
  distanceIsWalking: boolean;
  lotsAvailable: number | null;
  totalLots: number | null;
  fee: number | null;
  /** How much to trust `fee`. Commercial rates come from a stale dataset. */
  feeConfidence: "high" | "approximate" | "unknown";
  /**
   * Minutes of the requested stay this car park can't take — it stops selling
   * short-term parking partway through, or takes no overnight.
   *
   * This is not cosmetic. The fee for a partial stay is genuinely lower, so
   * ranking on price alone floats these to the top: a car park that shuts after
   * 55 of your 120 minutes was being recommended as the cheapest option, and
   * the saving it advertised was the saving from not parking.
   */
  minutesNotCovered: number;
  feeSource: FeeSource;
  /** ISO date the fee's source was last confirmed, or null for live schedules. */
  feeVerifiedAt: string | null;
  /** Where to re-verify a manual rate (operator page), if recorded. */
  feeSourceUrl: string | null;
  feeNote: string;
  /** Step-by-step "how this fee was computed", for the Details expander. */
  feeBreakdown: { label: string; value: string }[];
}

export interface SearchResponse {
  destination: GeocodeResult;
  isCentral: boolean;
  minutes: number;
  /** ISO instant of the session start. */
  startIso: string;
  /** Human-readable Singapore local start, e.g. "Wed 7.30pm". */
  startLabel: string;
  dayType: DayType;
  /** Set when the start date is a Singapore public holiday. */
  holidayName: string | null;
  /** True when a rate for the destination's OWN parking was found. */
  destinationRateFound: boolean;
  /** Whether the server can do an LLM web lookup — gates the client auto-trigger. */
  llmEnabled: boolean;
  results: CarparkResult[];
  warnings: string[];
}

/**
 * The 2,268-row HDB carpark list changes maybe monthly, so refetching it on
 * every search would be wasteful. Cached in module scope — on a single-user
 * VPS this is effectively a process-lifetime cache with a daily refresh.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

let carparkCache: { at: number; data: HdbCarpark[] } | null = null;
let mallCache: { at: number; data: MallCarparkRateText[] } | null = null;

async function getCarparks(): Promise<HdbCarpark[]> {
  if (carparkCache && Date.now() - carparkCache.at < DAY_MS) {
    return carparkCache.data;
  }
  try {
    const data = await fetchHdbCarparks();
    carparkCache = { at: Date.now(), data };
    safe(() => writeCache("hdb_carparks", data), undefined);
    return data;
  } catch (err) {
    // Live fetch failed (e.g. data.gov.sg 429). Fall back to the last-known
    // list so search still works — the carpark list changes ~monthly.
    const cached = safe(() => readCache<HdbCarpark[]>("hdb_carparks"), null);
    if (cached) {
      console.warn("HDB fetch failed, serving cached carparks from", cached.fetchedAt);
      carparkCache = { at: Date.now(), data: cached.data };
      return cached.data;
    }
    throw err;
  }
}

async function getMallRates(): Promise<MallCarparkRateText[]> {
  if (mallCache && Date.now() - mallCache.at < DAY_MS) return mallCache.data;
  try {
    const data = await fetchMallRates();
    mallCache = { at: Date.now(), data };
    // "_text" because the shape changed from parsed rates to published text; a
    // cache written by the old build would deserialise into nonsense.
    safe(() => writeCache("mall_rates_text", data), undefined);
    return data;
  } catch (err) {
    const cached = safe(() => readCache<MallCarparkRateText[]>("mall_rates_text"), null);
    if (cached) {
      mallCache = { at: Date.now(), data: cached.data };
      return cached.data;
    }
    throw err;
  }
}

/** Availability is best-effort — a failure degrades to "no live lots", not a 502. */
async function getAvailabilitySafe(): Promise<Map<string, Availability>> {
  try {
    return await fetchAvailability();
  } catch (err) {
    console.warn("availability fetch failed, degrading to no live data", err);
    return new Map<string, Availability>();
  }
}

/** The label a "near me" search carries instead of a building name. */
export const HERE = "Your location";

/**
 * Searching from coordinates asks a different question from searching an
 * address. "What does parking at Jem cost" has a destination whose own car park
 * might have a rate; "what's around me" has no such building, so the
 * destination-rate lookup and the gap log are skipped rather than run against a
 * name that means nothing.
 */
export async function search(
  destination: string | LatLng,
  minutes: number,
  start: Date = new Date(),
  limit = 10,
): Promise<SearchResponse | null> {
  const fromCoordinates = typeof destination !== "string";
  const place = fromCoordinates
    ? { name: HERE, address: HERE, postal: null, location: destination }
    : await geocode(destination);
  if (!place) return null;

  const [carparks, availability, mallRates, holidayMap, commercialLots] =
    await Promise.all([
      getCarparks(),
      getAvailabilitySafe(),
      getMallRates(),
      getPublicHolidays(),
      // Live lots for commercial/URA car parks. Returns [] when DataMall isn't
      // configured or is down, which just means the cards stay as they were.
      fetchCarparkLots().then(commercialOnly),
    ]);

  const isCentral = isProbablyCentral(place.location.lat, place.location.lng);
  const warnings: string[] = [];

  const startParts = toSgt(start);
  const holidays = new Set(holidayMap.keys());
  const holidayName = holidayMap.get(startParts.isoDate) ?? null;
  const dayType = classifyDay(startParts, holidays.has(startParts.isoDate));

  // Distance below which a saved rate is treated as covering the destination
  // (so we don't web-search or log a gap), and the radius within which saved
  // rates show up as nearby options at all.
  const COVERED_M = 400;
  const OVERRIDE_RADIUS_M = 2000;

  // Saved rates with coordinates become nearby options, ranked with the HDB
  // carparks — this is what surfaces Terminal 1's rate when searching Terminal 2.
  // Lorry/heavy-vehicle parks are dropped: a car can't park there.
  const overrideHits = safe(() => listOverridesWithCoords(), [])
    .filter((o) => !isHeavyVehicleOnly(o.displayName ?? o.matchValue))
    .map((o) => ({ o, d: haversineMetres(place.location, { lat: o.lat!, lng: o.lng! }) }))
    .filter((x) => x.d <= OVERRIDE_RADIUS_M)
    .sort((a, b) => a.d - b.d);

  type Candidate =
    | { kind: "hdb"; c: HdbCarpark; d: number }
    | { kind: "override"; o: RateOverride; d: number }
    | { kind: "eps"; c: EpsCarpark; d: number };

  const ranked: Candidate[] = [
    ...carparks.map((c) => ({
      kind: "hdb" as const,
      c,
      d: haversineMetres(place.location, c.location),
    })),
    ...overrideHits.map((x) => ({ kind: "override" as const, o: x.o, d: x.d })),
    ...publicEpsCarparks.map((c) => ({
      kind: "eps" as const,
      c,
      d: haversineMetres(place.location, c.location),
    })),
  ].sort((a, b) => a.d - b.d);

  const candLocation = (cand: Candidate): LatLng =>
    cand.kind === "hdb" || cand.kind === "eps"
      ? cand.c.location
      : { lat: cand.o.lat!, lng: cand.o.lng! };

  // The same physical car park can appear in more than one source — e.g. Jem is
  // both an EPS inventory entry and a saved LTA rate, 10 m apart. Prefer the one
  // we can price, so an EPS entry is dropped when a RATED car park (HDB or a
  // saved rate) sits within ~40 m of it.
  //
  // This must compare against every rated candidate, not just the ones already
  // kept: `ranked` is ordered by distance from the destination, so an EPS entry
  // can be visited before its rated twin and would otherwise survive.
  const DEDUP_M = 40;
  // Sources pin big developments at different corners — Ngee Ann City's EPS
  // entry and its saved rate are far enough apart to survive the 40 m test, and
  // listed twice they showed the same live lot count, plainly one car park. So
  // a matching NAME also settles it, within a radius wide enough to span a mall.
  const DEDUP_NAME_M = 300;
  const rated = ranked
    .filter((c) => c.kind !== "eps")
    .map((c) => ({
      loc: candLocation(c),
      // Both names: a saved rate is often filed against the EPS name while
      // showing a tidier one, e.g. matchValue "T3A CAR PARK" displayed as
      // "Changi Airport T3 Car Park". Comparing only the display name left the
      // EPS card sitting beside its own rate.
      names:
        c.kind === "hdb"
          ? [c.c.address]
          : [c.o.displayName ?? c.o.matchValue, c.o.matchValue],
    }));

  const kept: Candidate[] = [];

  // The EPS inventory is over 1,500 entries and carries no rates, so on
  // distance alone it could fill a ten-result list with cards that quote no
  // price. But it must not be shut out either: the car park AT the address you
  // searched is worth more than street parking 700 m away, even unpriced. So
  // it competes on distance like everything else, up to a few slots.
  const MAX_UNPRICED = 3;
  let unpriced = 0;

  for (const cand of ranked) {
    if (kept.length >= limit) break;
    if (cand.kind === "eps") {
      if (unpriced >= MAX_UNPRICED) continue;
      const loc = cand.c.location;
      // Same spot, or the same name nearby, as something we can price → skip
      // the unpriced copy.
      if (
        rated.some(({ loc: p, names }) => {
          const d = haversineMetres(loc, p);
          if (d < DEDUP_M) return true;
          return (
            d < DEDUP_NAME_M && names.some((n) => looseNameMatch(cand.c.name, n))
          );
        })
      ) {
        continue;
      }
      // Two EPS rows for one car park (duplicate feed entries) → keep the first,
      // which is the nearer of the two given the distance ordering.
      if (
        kept.some(
          (k) => k.kind === "eps" && haversineMetres(loc, k.c.location) < DEDUP_M,
        )
      ) {
        continue;
      }
      unpriced++;
    }
    kept.push(cand);
  }
  const candidates = kept;

  const nearestHdbM = candidates.find((x) => x.kind === "hdb")?.d ?? Infinity;
  const nearestOverrideM = overrideHits[0]?.d ?? Infinity;

  // Each walking distance is its own OneMap routing call, and they don't
  // depend on each other. Awaited one at a time they were the dominant cost of
  // a search — ten round trips deep, 1.1-2.2s on the wire — so they go
  // together and the search waits for the slowest rather than the sum.
  // The catch matters: a thrown route fetch previously 502'd the whole search;
  // now that route just falls back to straight-line distance like any other
  // routing miss.
  const walks = await Promise.all(
    candidates.map((cand) =>
      walkingDistanceMetres(place.location, candLocation(cand)).catch(() => null),
    ),
  );

  const results: CarparkResult[] = [];
  for (const [i, cand] of candidates.entries()) {
    const loc = candLocation(cand);
    const walk = walks[i]!;
    results.push(
      cand.kind === "hdb"
        ? hdbResult(cand.c, cand.d, walk, availability, {
            start,
            minutes,
            isCentral,
            dayType,
            holidays,
          })
        : cand.kind === "eps"
          ? epsResult(cand.c, cand.d, walk, commercialLots)
          : overrideResult(
              cand.o,
              cand.d,
              walk,
              minutes,
              dayType,
              startParts.minutesOfDay,
              commercialLots,
            ),
    );
  }

  // When no saved rate is nearby (spatially), fall back to matching the
  // destination by name/postal — this catches overrides that have no
  // coordinates yet (geocode failures, hand-entered rates), then the LTA mall
  // dataset. Whichever hits is shown as the destination's own rate.
  let destRate: CarparkResult | null = null;
  if (nearestOverrideM > COVERED_M && !fromCoordinates) {
    const nameOv = safe(
      () => findOverrideForDestination({ postal: place.postal, name: place.name }),
      null,
    );
    // Only use the name match for coordless overrides — ones with coordinates
    // are already handled by the spatial list above (avoids double-listing).
    if (nameOv && nameOv.lat === null && nameOv.lng === null) {
      destRate = overrideResult(
        nameOv,
        0,
        null,
        minutes,
        dayType,
        startParts.minutesOfDay,
      );
    } else {
      destRate = mallDatasetMatch(
        place,
        mallRates,
        minutes,
        dayType,
        startParts.minutesOfDay,
      );
    }
    if (destRate) results.unshift(destRate);
  }

  // A coordinate search has no destination whose parking could be missing a
  // rate, so nothing is "not found" and the add-a-rate prompt stays away.
  const destinationRateFound =
    fromCoordinates || nearestOverrideM <= COVERED_M || destRate !== null;

  if (
    !destinationRateFound &&
    !fromCoordinates &&
    nearestHdbM > 200 &&
    nearestOverrideM > OVERRIDE_RADIUS_M
  ) {
    // No rate for the destination's own parking, no saved rate nearby, and no
    // HDB carpark within a short walk — a genuine gap. Log it for the fill list.
    safe(() => {
      recordGap({
        destination: place.name,
        postal: place.postal,
        lat: place.location.lat,
        lng: place.location.lng,
      });
    }, undefined);
    warnings.push(
      "No rate on file for parking at this destination, and no HDB carpark " +
        "within a short walk. Add a rate to cover it.",
    );
  }

  if (!results.some((r) => r.distanceIsWalking)) {
    warnings.push(
      "Distances are straight-line. Set ONEMAP_TOKEN for real walking routes.",
    );
  }
  warnings.push(
    isCentral
      ? "Central-area rates applied (derived from coordinates, not an official list)."
      : "Non-central rates applied.",
  );
  warnings.push("Shelter is inferred from carpark structure, not published data.");

  if (holidayName) {
    warnings.push(`${holidayName} is a public holiday — Sunday rates apply.`);
  }
  if (dayType === "sunday-ph") {
    warnings.push(
      "Many HDB carparks are free 7am-10.30pm on Sundays and public holidays.",
    );
  }

  return {
    destination: place,
    isCentral,
    minutes,
    startIso: start.toISOString(),
    startLabel: formatSgtTime(start),
    dayType,
    holidayName,
    destinationRateFound,
    // Web lookup needs both the extraction model and the search provider.
    llmEnabled: isLlmConfigured() && isSearchConfigured(),
    results,
    warnings,
  };
}

/**
 * Runs store access in a way that a database problem degrades gracefully:
 * search still returns live results, it just loses persistence for that call.
 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.error("store access failed", err);
    return fallback;
  }
}

/**
 * Prices a saved override through the same parser as the LTA dataset, using the
 * rate band that covers the arrival time (many rates carry a day and an evening
 * band in one string).
 */
function feeFromOverride(
  o: RateOverride,
  minutes: number,
  dayType: DayType,
  startMod: number,
): number | null {
  const band = (s: string | null) => parseRate(bandForTime(s ?? "", startMod));
  const rates: MallCarparkRates = {
    name: o.displayName ?? o.matchValue,
    category: "",
    weekday: band(o.weekdayRate),
    friday: band(o.fridayRate),
    saturday: band(o.saturdayRate),
    sundayPh: band(o.sundayPhRate),
  };
  return estimateMallFee(
    rateForDay(rates, dayType),
    minutes,
    limitsForOverride(o, dayType, startMod),
  );
}

/**
 * Grace period and daily cap for a saved rate. They're published beside the
 * price rather than inside it, so both the rate text and the notes are read —
 * the AI extractor is told to put caveats like "Grace Period : 20 Minutes" and
 * "Whole Day Max Cap: $20.00" in the notes.
 *
 * `startMod` must be the arrival time, because a cap belongs to the BAND that
 * states it. This read the band at minute 0 — midnight — and so applied the
 * overnight cap to every stay: Queen St Off St charges $1.40 per half hour by
 * day and caps at $5.00 only between 10.30pm and 7am, and an eight-hour
 * weekday stay was quoted $5.00 instead of $22.40. Harmless until URA rates
 * carried per-band caps, at which point it started underpricing in the app's
 * most confident-looking voice.
 */
function limitsForOverride(
  o: RateOverride,
  dayType: DayType,
  startMod: number,
): RateLimits {
  return parseLimits(
    [rawRateForDay(o, dayType, startMod), o.notes ?? ""].join(" "),
  );
}

interface HdbFeeOpts {
  start: Date;
  minutes: number;
  isCentral: boolean;
  dayType: DayType;
  holidays: Set<string>;
}

/** Builds a result for an HDB carpark, applying a per-carpark saved rate if one exists. */
function hdbResult(
  c: HdbCarpark,
  straightM: number,
  walkM: number | null,
  availability: Map<string, Availability>,
  opts: HdbFeeOpts,
): CarparkResult {
  const avail = availability.get(c.carparkNo);
  // Central pricing follows the CAR PARK, not the destination. A search near
  // the Central Area edge returns car parks on both sides of it, and billing
  // them all by the destination's side doubles or halves the wrong ones.
  const carparkIsCentral = isProbablyCentral(c.location.lat, c.location.lng);
  const scheduleFee = calculateHdbFee({
    start: opts.start,
    minutes: opts.minutes,
    isCentral: carparkIsCentral,
    perMinuteBilling: !c.needsParkingApp,
    freeParking: c.freeParking,
    shortTermParking: c.shortTermParking,
    nightParking: c.nightParking,
    holidays: opts.holidays,
  });

  // A saved rate for this exact carpark wins over the computed schedule.
  const ov = safe(() => findOverrideForCarpark(c.carparkNo), null);
  const startMod = toSgt(opts.start).minutesOfDay;
  const ovFee = ov
    ? feeFromOverride(ov, opts.minutes, opts.dayType, startMod)
    : null;

  const base = {
    id: c.carparkNo,
    name: titleCase(c.address),
    operator: "HDB" as const,
    carparkType: c.carparkType,
    shelter: c.shelter,
    needsParkingApp: c.needsParkingApp,
    location: c.location,
    distanceM: Math.round(walkM ?? straightM),
    distanceIsWalking: walkM !== null,
    lotsAvailable: avail?.lotsAvailable ?? null,
    totalLots: avail?.totalLots ?? null,
    // Opening hours are only modelled for the HDB schedule; a saved or
    // commercial rate carries no hours, so nothing is known to be uncovered.
    minutesNotCovered: 0,
  };

  if (ov && ovFee !== null) {
    return {
      ...base,
      fee: ovFee,
      feeConfidence: "high",
      feeSource: ov.source,
      feeVerifiedAt: ov.verifiedAt,
      feeSourceUrl: ov.sourceUrl,
      feeNote: ov.notes ?? "Your saved rate.",
      feeBreakdown: commercialBreakdown(
        rawRateForDay(ov, opts.dayType, startMod),
        opts.dayType,
        opts.minutes,
        ovFee,
        limitsForOverride(ov, opts.dayType, startMod),
      ),
    };
  }

  // $0 here can mean two different things: genuinely free (Sunday/PH free
  // parking), or no short-term parking offered at all. Only the former should
  // read "Free" — mark the latter as unavailable (null fee → "—") so we don't
  // send someone to a carpark that has no short-term parking.
  const noShortTerm = c.shortTermParking.trim().toUpperCase() === "NO";
  if (noShortTerm) {
    return {
      ...base,
      fee: null,
      feeConfidence: "unknown",
      feeSource: "hdb-schedule",
      feeVerifiedAt: null,
      feeSourceUrl: null,
      feeNote: "No short-term parking here (season/reserved only).",
      feeBreakdown: [],
      minutesNotCovered: opts.minutes,
    };
  }

  return {
    ...base,
    fee: scheduleFee.total,
    feeConfidence: "high",
    feeSource: "hdb-schedule",
    feeVerifiedAt: null,
    feeSourceUrl: null,
    minutesNotCovered:
      scheduleFee.outsideMinutes + scheduleFee.nightClosedMinutes,
    feeNote: scheduleFee.notes.join(" "),
    feeBreakdown: hdbBreakdown(
      scheduleFee,
      carparkIsCentral,
      !c.needsParkingApp,
      opts.minutes,
      opts.dayType,
    ),
  };
}

/** Builds a result for a saved rate (override) matched by proximity. */
function overrideResult(
  o: RateOverride,
  straightM: number,
  walkM: number | null,
  minutes: number,
  dayType: DayType,
  startMod: number,
  commercialLots: CarparkLots[] = [],
): CarparkResult {
  const dollars = feeFromOverride(o, minutes, dayType, startMod);
  const live =
    o.lat !== null && o.lng !== null
      ? lotsFor({ lat: o.lat, lng: o.lng }, o.displayName ?? o.matchValue, commercialLots)
      : null;
  return {
    id: `override:${o.id}`,
    name: o.displayName ?? o.matchValue,
    operator: "Commercial",
    carparkType: "Saved rate",
    shelter: "unknown",
    needsParkingApp: false,
    // A saved rate carries no opening hours, so nothing is known to be uncovered.
    minutesNotCovered: 0,
    location: o.lat !== null && o.lng !== null ? { lat: o.lat, lng: o.lng } : null,
    distanceM: Math.round(walkM ?? straightM),
    distanceIsWalking: walkM !== null,
    // DataMall reports free lots but no capacity, so totalLots stays null and
    // the card shows a count without a fullness bar.
    lotsAvailable: live?.availableLots ?? null,
    totalLots: null,
    fee: dollars,
    feeConfidence:
      dollars === null ? "unknown" : o.source === "web-llm" ? "approximate" : "high",
    feeSource: o.source,
    feeVerifiedAt: o.verifiedAt,
    feeSourceUrl: o.sourceUrl,
    feeNote: o.notes ?? "",
    feeBreakdown: commercialBreakdown(
      rawRateForDay(o, dayType, startMod),
      dayType,
      minutes,
      dollars,
      limitsForOverride(o, dayType, startMod),
    ),
  };
}

/**
 * Builds a result for an EPS-inventory car park: we know where it is but not
 * its rate. Shown as a nearby option with an unknown fee ("—") and the
 * per-card "search the web for its rate" button to fill it in.
 */
function epsResult(
  c: EpsCarpark,
  straightM: number,
  walkM: number | null,
  commercialLots: CarparkLots[] = [],
): CarparkResult {
  const live = lotsFor(c.location, c.name, commercialLots);
  return {
    id: `eps:${c.id}`,
    name: titleCase(c.name),
    operator: "Commercial",
    carparkType: "EPS car park",
    shelter: "unknown",
    needsParkingApp: false,
    location: c.location,
    distanceM: Math.round(walkM ?? straightM),
    distanceIsWalking: walkM !== null,
    // EPS publishes a capacity, and DataMall the live free count — together
    // they make a real "N of M" reading for a commercial car park.
    lotsAvailable: live?.availableLots ?? null,
    totalLots: live ? c.publicLots : null,
    fee: null,
    feeConfidence: "unknown",
    feeSource: "eps-inventory",
    // Commercial listings carry no opening hours.
    minutesNotCovered: 0,
    feeVerifiedAt: null,
    feeSourceUrl: null,
    feeNote:
      (c.publicLots ? `${c.publicLots} public lots. ` : "") +
      "No rate on file yet.",
    feeBreakdown: [],
  };
}

/** The LTA mall dataset match by name (no coordinates), or null when none. */
function mallDatasetMatch(
  place: GeocodeResult,
  mallRates: MallCarparkRateText[],
  minutes: number,
  dayType: DayType,
  startMod: number,
): CarparkResult | null {
  const destUpper = place.name.toUpperCase();
  for (const m of mallRates) {
    if (!looseNameMatch(destUpper, m.name.toUpperCase())) continue;
    // Pick the band for the arrival time before parsing, exactly as the saved
    // overrides do. Parsing the whole string instead always priced the morning
    // and never the evening.
    const text = rateTextForDay(m, dayType);
    const band = bandForTime(text, startMod);
    const applied = parseRate(band);
    const dollars = estimateMallFee(applied, minutes, parseLimits(band));
    return {
      id: `mall:${m.name}`,
      name: m.name,
      operator: "Commercial",
      carparkType: "Commercial carpark",
      shelter: "unknown",
      needsParkingApp: false,
      location: null,
      distanceM: 0,
      distanceIsWalking: false,
      lotsAvailable: null,
      totalLots: null,
      fee: dollars,
      feeConfidence: dollars === null ? "unknown" : "approximate",
      feeSource: "lta-dataset",
    // Commercial listings carry no opening hours.
    minutesNotCovered: 0,
      // Representative "last updated" date for the dataset, so the UI can age it.
      feeVerifiedAt: "2024-06-06",
      feeSourceUrl: null,
      feeNote:
        dollars === null
          ? "Rate format could not be read automatically."
          : "From a dataset last updated Jun 2024 — verify on site.",
      feeBreakdown: commercialBreakdown(describeRate(applied), dayType, minutes, dollars),
    };
  }
  return null;
}

function dayLabel(d: DayType): string {
  return d === "sunday-ph"
    ? "Sunday / public holiday"
    : d === "saturday"
      ? "Saturday"
      : d === "friday"
        ? "Friday"
        : "weekday";
}

function hdbBreakdown(
  fee: FeeResult,
  isCentral: boolean,
  perMinuteBilling: boolean,
  minutes: number,
  dayType: DayType,
): { label: string; value: string }[] {
  const band = isCentral ? HDB_RATES.central : HDB_RATES.nonCentral;
  const rows: { label: string; value: string }[] = [
    {
      label: "Rate",
      value: `$${band.perHalfHour.toFixed(2)} per 30 min (${isCentral ? "central" : "non-central"})`,
    },
    {
      label: "Billing",
      value: perMinuteBilling ? "per minute (electronic)" : "per 30-min block (coupon)",
    },
    { label: "When", value: `${dayLabel(dayType)}, ${minutes} min` },
  ];
  if (fee.freeMinutes > 0) rows.push({ label: "Free", value: `${fee.freeMinutes} min` });
  // Without this the minutes don't add up: a stay running past a car park's
  // short-term hours showed "120 min" above and "Charged 55 min" below, with
  // the missing hour unexplained.
  if (fee.outsideMinutes > 0) {
    rows.push({
      label: "Outside hours",
      value: `${fee.outsideMinutes} min — not sold here`,
    });
  }
  rows.push({ label: "Charged", value: `${fee.chargedMinutes} min` });
  if (fee.capApplied) rows.push({ label: "Cap", value: "daily/night cap applied" });
  rows.push({ label: "Total", value: formatFee(fee.total) });
  return rows;
}

function commercialBreakdown(
  rateText: string,
  dayType: DayType,
  minutes: number,
  dollars: number | null,
  limits: RateLimits = NO_LIMITS,
): { label: string; value: string }[] {
  const rows = [
    { label: "Applied rate", value: rateText || "—" },
    { label: "When", value: `${dayLabel(dayType)}, ${minutes} min` },
  ];
  // Only mention a limit when it changed the number, so the breakdown explains
  // the price rather than listing rules that didn't apply.
  if (limits.graceMinutes) {
    rows.push({
      label: "Grace",
      value:
        minutes <= limits.graceMinutes
          ? `within the ${limits.graceMinutes} min grace — free`
          : limits.graceMode === "deduct"
            ? `first ${limits.graceMinutes} min free, ${minutes - limits.graceMinutes} min charged`
            : `${limits.graceMinutes} min grace passed — full stay charged`,
    });
  }
  if (limits.capDollars !== null && dollars !== null && dollars >= limits.capDollars) {
    rows.push({ label: "Cap", value: `capped at ${formatFee(limits.capDollars)}` });
  }
  rows.push({
    label: "Total",
    value: dollars === null ? "not computable" : formatFee(dollars),
  });
  return rows;
}

/**
 * The rate string an override uses for a given day, narrowed to the band that
 * covers the arrival time so the breakdown shows the rate actually charged.
 */
function rawRateForDay(
  o: RateOverride,
  dayType: DayType,
  startMod: number,
): string {
  const raw =
    dayType === "sunday-ph"
      ? o.sundayPhRate ?? o.saturdayRate ?? o.weekdayRate ?? ""
      : dayType === "friday"
        ? o.fridayRate ?? o.weekdayRate ?? ""
        : dayType === "saturday"
        ? o.saturdayRate ?? o.weekdayRate ?? ""
        : o.weekdayRate ?? "";
  return bandForTime(raw, startMod);
}

/**
 * Lorry / heavy-vehicle parks, which have no standard car lots — URA lists a
 * handful as "… HVP" (e.g. BENDEMEER RD HVP) and other feeds spell it out.
 * Matched on the name because no source flags the vehicle type. "HV" alone is
 * deliberately not matched: too short to be safe inside ordinary names.
 */
function isHeavyVehicleOnly(name: string): boolean {
  return /\bHVP\b|HEAVY[\s-]?VEHICLE|\bLORRY\b/i.test(name);
}

function looseNameMatch(a: string, b: string): boolean {
  // Uppercase FIRST: the strip below removes anything outside A-Z0-9, so a
  // mixed-case name would lose its lowercase letters entirely — "Ngee Ann City"
  // became "NAC" and matched nothing.
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const na = norm(a);
  const nb = norm(b);
  return na.length > 3 && nb.length > 3 && (na.includes(nb) || nb.includes(na));
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bBlk\b/g, "Blk");
}
