import { fetchHdbCarparks, type HdbCarpark } from "./sources/hdb";
import { fetchAvailability, type Availability } from "./sources/availability";
import { publicEpsCarparks, type EpsCarpark } from "./sources/eps";
import {
  fetchMallRates,
  estimateMallFee,
  rateForDay,
  parseRate,
  describeRate,
  type MallCarparkRates,
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
let mallCache: { at: number; data: MallCarparkRates[] } | null = null;

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

async function getMallRates(): Promise<MallCarparkRates[]> {
  if (mallCache && Date.now() - mallCache.at < DAY_MS) return mallCache.data;
  try {
    const data = await fetchMallRates();
    mallCache = { at: Date.now(), data };
    safe(() => writeCache("mall_rates", data), undefined);
    return data;
  } catch (err) {
    const cached = safe(() => readCache<MallCarparkRates[]>("mall_rates"), null);
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

export async function search(
  destination: string,
  minutes: number,
  start: Date = new Date(),
  limit = 10,
): Promise<SearchResponse | null> {
  const place = await geocode(destination);
  if (!place) return null;

  const [carparks, availability, mallRates, holidayMap] = await Promise.all([
    getCarparks(),
    getAvailabilitySafe(),
    getMallRates(),
    getPublicHolidays(),
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
  const overrideHits = safe(() => listOverridesWithCoords(), [])
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

  // Drop an EPS entry when a rated carpark (HDB/override) sits within ~35 m —
  // it's the same physical car park, and we prefer the one we can price. Only
  // the nearest handful are checked, so this stays cheap.
  const DEDUP_M = 35;
  const kept: Candidate[] = [];
  for (const cand of ranked) {
    if (kept.length >= limit) break;
    if (cand.kind === "eps") {
      const dup = kept.some(
        (k) =>
          k.kind !== "eps" &&
          haversineMetres(cand.c.location, candLocation(k)) < DEDUP_M,
      );
      if (dup) continue;
    }
    kept.push(cand);
  }
  const candidates = kept;

  const nearestHdbM = candidates.find((x) => x.kind === "hdb")?.d ?? Infinity;
  const nearestOverrideM = overrideHits[0]?.d ?? Infinity;

  const results: CarparkResult[] = [];
  for (const cand of candidates) {
    const loc = candLocation(cand);
    const walk = await walkingDistanceMetres(place.location, loc);
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
          ? epsResult(cand.c, cand.d, walk)
          : overrideResult(cand.o, cand.d, walk, minutes, dayType),
    );
  }

  // When no saved rate is nearby (spatially), fall back to matching the
  // destination by name/postal — this catches overrides that have no
  // coordinates yet (geocode failures, hand-entered rates), then the LTA mall
  // dataset. Whichever hits is shown as the destination's own rate.
  let destRate: CarparkResult | null = null;
  if (nearestOverrideM > COVERED_M) {
    const nameOv = safe(
      () => findOverrideForDestination({ postal: place.postal, name: place.name }),
      null,
    );
    // Only use the name match for coordless overrides — ones with coordinates
    // are already handled by the spatial list above (avoids double-listing).
    if (nameOv && nameOv.lat === null && nameOv.lng === null) {
      destRate = overrideResult(nameOv, 0, null, minutes, dayType);
    } else {
      destRate = mallDatasetMatch(place, mallRates, minutes, dayType);
    }
    if (destRate) results.unshift(destRate);
  }

  const destinationRateFound = nearestOverrideM <= COVERED_M || destRate !== null;

  if (
    !destinationRateFound &&
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

/** Prices a saved override through the same parser as the LTA dataset. */
function feeFromOverride(
  o: RateOverride,
  minutes: number,
  dayType: DayType,
): number | null {
  const rates: MallCarparkRates = {
    name: o.displayName ?? o.matchValue,
    category: "",
    weekday: parseRate(o.weekdayRate ?? ""),
    saturday: parseRate(o.saturdayRate ?? ""),
    sundayPh: parseRate(o.sundayPhRate ?? ""),
  };
  return estimateMallFee(rateForDay(rates, dayType), minutes);
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
  const scheduleFee = calculateHdbFee({
    start: opts.start,
    minutes: opts.minutes,
    isCentral: opts.isCentral,
    perMinuteBilling: !c.needsParkingApp,
    freeParking: c.freeParking,
    shortTermParking: c.shortTermParking,
    nightParking: c.nightParking,
    holidays: opts.holidays,
  });

  // A saved rate for this exact carpark wins over the computed schedule.
  const ov = safe(() => findOverrideForCarpark(c.carparkNo), null);
  const ovFee = ov ? feeFromOverride(ov, opts.minutes, opts.dayType) : null;

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
        rawRateForDay(ov, opts.dayType),
        opts.dayType,
        opts.minutes,
        ovFee,
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
    };
  }

  return {
    ...base,
    fee: scheduleFee.total,
    feeConfidence: "high",
    feeSource: "hdb-schedule",
    feeVerifiedAt: null,
    feeSourceUrl: null,
    feeNote: scheduleFee.notes.join(" "),
    feeBreakdown: hdbBreakdown(
      scheduleFee,
      opts.isCentral,
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
): CarparkResult {
  const dollars = feeFromOverride(o, minutes, dayType);
  return {
    id: `override:${o.id}`,
    name: o.displayName ?? o.matchValue,
    operator: "Commercial",
    carparkType: "Saved rate",
    shelter: "unknown",
    needsParkingApp: false,
    location: o.lat !== null && o.lng !== null ? { lat: o.lat, lng: o.lng } : null,
    distanceM: Math.round(walkM ?? straightM),
    distanceIsWalking: walkM !== null,
    lotsAvailable: null,
    totalLots: null,
    fee: dollars,
    feeConfidence:
      dollars === null ? "unknown" : o.source === "web-llm" ? "approximate" : "high",
    feeSource: o.source,
    feeVerifiedAt: o.verifiedAt,
    feeSourceUrl: o.sourceUrl,
    feeNote: o.notes ?? "",
    feeBreakdown: commercialBreakdown(
      rawRateForDay(o, dayType),
      dayType,
      minutes,
      dollars,
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
): CarparkResult {
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
    lotsAvailable: null,
    totalLots: null,
    fee: null,
    feeConfidence: "unknown",
    feeSource: "eps-inventory",
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
  mallRates: MallCarparkRates[],
  minutes: number,
  dayType: DayType,
): CarparkResult | null {
  const destUpper = place.name.toUpperCase();
  for (const m of mallRates) {
    if (!looseNameMatch(destUpper, m.name.toUpperCase())) continue;
    const applied = rateForDay(m, dayType);
    const dollars = estimateMallFee(applied, minutes);
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
  rows.push({ label: "Charged", value: `${fee.chargedMinutes} min` });
  rows.push({ label: "Subtotal", value: `$${fee.dollarsBeforeGst.toFixed(2)}` });
  rows.push({ label: "GST 9%", value: `$${fee.gst.toFixed(2)}` });
  if (fee.capApplied) rows.push({ label: "Cap", value: "daily/night cap applied" });
  rows.push({ label: "Total", value: formatFee(fee.total) });
  return rows;
}

function commercialBreakdown(
  rateText: string,
  dayType: DayType,
  minutes: number,
  dollars: number | null,
): { label: string; value: string }[] {
  return [
    { label: "Applied rate", value: rateText || "—" },
    { label: "When", value: `${dayLabel(dayType)}, ${minutes} min` },
    {
      label: "Total",
      value: dollars === null ? "not computable" : formatFee(dollars),
    },
  ];
}

/** The raw rate string an override uses for a given day. */
function rawRateForDay(o: RateOverride, dayType: DayType): string {
  if (dayType === "sunday-ph")
    return o.sundayPhRate ?? o.saturdayRate ?? o.weekdayRate ?? "";
  if (dayType === "saturday") return o.saturdayRate ?? o.weekdayRate ?? "";
  return o.weekdayRate ?? "";
}

function looseNameMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[^A-Z0-9]/g, "");
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
