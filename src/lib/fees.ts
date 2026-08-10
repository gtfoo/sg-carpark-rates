import { toSgt, fromSgt, type SgtParts } from "./time";
import centralRings from "./sources/central-area.json";

/** Outer rings of the 11 URA Central Area planning areas, as [lng, lat]. */
const CENTRAL_RINGS = centralRings as number[][][];

/**
 * HDB / URA short-term parking fee calculation, time-aware.
 *
 * Published schedule (policy values, not API-sourced — verify against
 * hdb.gov.sg before relying on them):
 *   Non-Central  $0.60 per half hour   day cap $12
 *   Central      $1.20 per half hour   day cap $20
 *   Day window   07:00 - 22:30
 *   Night window 22:30 - 07:00, capped $5 where night parking applies
 *   Charged per minute at electronic (EPS) carparks; coupon carparks bill in
 *   whole half-hour blocks.
 *   Published rates are the final amount charged (GST-inclusive) — the same
 *   figures parking.sg bills — so no GST is added on top.
 */

export const HDB_RATES = {
  nonCentral: { perHalfHour: 0.6, dayCap: 12 },
  central: { perHalfHour: 1.2, dayCap: 20 },
  nightCap: 5,
} as const;

/** Minutes from local midnight. */
const DAY_START = 7 * 60; // 07:00
const DAY_END = 22 * 60 + 30; // 22:30

/**
 * "friday" exists because several operators price Friday with the weekend —
 * ION Orchard, 313@Somerset, Jem, Marina Square and Resorts World Sentosa all
 * do. HDB does not, and its schedule only ever asks whether a day is
 * Sunday/PH, so Friday behaves as an ordinary weekday there.
 */
export type DayType = "weekday" | "friday" | "saturday" | "sunday-ph";

export function classifyDay(parts: SgtParts, isHoliday: boolean): DayType {
  if (isHoliday || parts.weekday === 0) return "sunday-ph";
  if (parts.weekday === 6) return "saturday";
  if (parts.weekday === 5) return "friday";
  return "weekday";
}

export interface FeeInput {
  start: Date;
  minutes: number;
  isCentral: boolean;
  /** Coupon carparks bill in whole half-hour units, EPS bills per minute. */
  perMinuteBilling: boolean;
  /** Raw HDB `free_parking` value, e.g. "SUN & PH FR 7AM-10.30PM". */
  freeParking: string;
  /** Raw HDB `short_term_parking` value, e.g. "WHOLE DAY" or "7AM-7PM". */
  shortTermParking: string;
  /** Raw HDB `night_parking` flag. */
  nightParking: boolean;
  /** Dates (YYYY-MM-DD, SGT) that are public holidays. */
  holidays: Set<string>;
}

export interface FeeResult {
  dollarsBeforeGst: number;
  gst: number;
  total: number;
  capApplied: boolean;
  freeMinutes: number;
  chargedMinutes: number;
  /**
   * Minutes the car park doesn't sell short-term parking for at all — Blk 271
   * Punggol Walk stops at 10.30pm, so a stay running past that is billed for
   * the part before and nothing after.
   *
   * Tracked because it was previously invisible: a 120-minute session showed
   * "Charged 55 min" with no free minutes and no note, and the missing hour
   * looked like a bug rather than the car park's opening hours.
   */
  outsideMinutes: number;
  /** Minutes lost because the car park takes no overnight parking. */
  nightClosedMinutes: number;
  notes: string[];
}

interface Segment {
  isoDate: string;
  dayType: DayType;
  /** Minutes from local midnight. */
  from: number;
  to: number;
  isNight: boolean;
}

/**
 * Splits a session at every rule boundary it crosses: midnight, 07:00 and
 * 22:30. A session starting 21:00 for four hours spans the day window, the
 * night window and a date change, and each part prices and caps separately.
 */
function splitSession(start: Date, minutes: number): Omit<Segment, "dayType">[] {
  const segments: Omit<Segment, "dayType">[] = [];
  let cursor = new Date(start.getTime());
  let remaining = minutes;
  let guard = 0; // guards against pathological input looping unbounded

  while (remaining > 0 && guard++ < 200) {
    const p = toSgt(cursor);
    const mod = p.minutesOfDay;

    let boundary: number;
    if (mod < DAY_START) boundary = DAY_START;
    else if (mod < DAY_END) boundary = DAY_END;
    else boundary = 24 * 60;

    const take = Math.min(boundary - mod, remaining);

    segments.push({
      isoDate: p.isoDate,
      from: mod,
      to: mod + take,
      isNight: mod < DAY_START || mod >= DAY_END,
    });

    cursor = new Date(cursor.getTime() + take * 60_000);
    remaining -= take;
  }

  return segments;
}

/** "SUN & PH FR 7AM-10.30PM" -> free 07:00-22:30 on Sundays and PH. */
function freeWindow(freeParking: string): { from: number; to: number } | null {
  const v = (freeParking ?? "").toUpperCase();
  if (!v || v === "NO") return null;
  if (v.includes("1PM")) return { from: 13 * 60, to: DAY_END };
  if (v.includes("7AM")) return { from: DAY_START, to: DAY_END };
  return null;
}

/** "7AM-7PM" / "7AM-10.30PM" / "WHOLE DAY" / "NO". */
function chargeableWindow(
  shortTerm: string,
): { from: number; to: number } | null {
  const v = (shortTerm ?? "").toUpperCase().replace(/\s/g, "");
  if (v === "NO") return null;
  if (v.includes("WHOLEDAY")) return { from: 0, to: 24 * 60 };
  if (v.includes("7AM-7PM")) return { from: DAY_START, to: 19 * 60 };
  if (v.includes("7AM-10.30PM")) return { from: DAY_START, to: DAY_END };
  return { from: 0, to: 24 * 60 };
}

function overlap(
  a: { from: number; to: number },
  b: { from: number; to: number },
): number {
  return Math.max(0, Math.min(a.to, b.to) - Math.max(a.from, b.from));
}

export function calculateHdbFee(input: FeeInput): FeeResult {
  const notes: string[] = [];
  const band = input.isCentral ? HDB_RATES.central : HDB_RATES.nonCentral;
  const perMinute = band.perHalfHour / 30;

  const chargeable = chargeableWindow(input.shortTermParking);
  if (!chargeable) {
    return {
      dollarsBeforeGst: 0,
      gst: 0,
      total: 0,
      capApplied: false,
      freeMinutes: 0,
      chargedMinutes: 0,
      outsideMinutes: input.minutes,
      nightClosedMinutes: 0,
      notes: ["This carpark has no short-term parking."],
    };
  }

  const free = freeWindow(input.freeParking);

  const segments: Segment[] = splitSession(input.start, input.minutes).map(
    (s) => {
      const [y, m, d] = isoToParts(s.isoDate);
      const parts = toSgt(fromSgt(y, m, d, 12));
      return { ...s, dayType: classifyDay(parts, input.holidays.has(s.isoDate)) };
    },
  );

  // Caps apply per window instance, so track spend per date and per window.
  const dayCharged = new Map<string, number>();
  const nightCharged = new Map<string, number>();

  let freeMinutes = 0;
  let chargedMinutes = 0;
  let outsideMinutes = 0;
  let nightClosedMinutes = 0;
  let total = 0;
  let capApplied = false;
  let sawFree = false;
  let sawNightClosed = false;

  for (const seg of segments) {
    const span = { from: seg.from, to: seg.to };
    let billable = overlap(span, chargeable);
    // Whatever falls outside the short-term window is time this car park
    // simply doesn't sell. It must be counted, not dropped: the minutes have
    // to add up on the card or the total looks arbitrary.
    outsideMinutes += seg.to - seg.from - billable;
    if (billable <= 0) continue;

    if (free && seg.dayType === "sunday-ph") {
      const freeOverlap = overlap(span, free);
      if (freeOverlap > 0) {
        billable -= freeOverlap;
        freeMinutes += freeOverlap;
        sawFree = true;
      }
    }
    if (billable <= 0) continue;

    if (seg.isNight && !input.nightParking) {
      sawNightClosed = true;
      nightClosedMinutes += billable;
      continue;
    }

    let cost = input.perMinuteBilling
      ? perMinute * billable
      : band.perHalfHour * Math.ceil(billable / 30);

    if (seg.isNight) {
      // The night window runs 22:30 -> 07:00 and therefore straddles two
      // calendar dates, but it is ONE night and gets ONE $5 cap. Keying by
      // calendar date would charge the cap twice for a single overnight stay.
      const key = nightKey(seg.isoDate, seg.from);
      const already = nightCharged.get(key) ?? 0;
      const room = Math.max(0, HDB_RATES.nightCap - already);
      if (cost > room) {
        cost = room;
        capApplied = true;
      }
      nightCharged.set(key, already + cost);
    } else {
      const key = seg.isoDate;
      const already = dayCharged.get(key) ?? 0;
      const room = Math.max(0, band.dayCap - already);
      if (cost > room) {
        cost = room;
        capApplied = true;
      }
      dayCharged.set(key, already + cost);
    }

    chargedMinutes += billable;
    total += cost;
  }

  if (outsideMinutes > 0) {
    notes.push(
      `Short-term parking here is ${input.shortTermParking.toLowerCase()} — ` +
        `${outsideMinutes} min of this stay falls outside that and isn't charged.`,
    );
  }
  if (sawFree) notes.push("Free parking applies for part of this session.");
  if (capApplied) notes.push("A daily or night cap was reached.");
  if (sawNightClosed) notes.push("No night parking here — overnight not charged.");
  if (!input.perMinuteBilling) {
    notes.push("Coupon carpark — billed in whole half-hour blocks.");
  }

  return {
    dollarsBeforeGst: round2(total),
    gst: 0,
    total: round2(total),
    capApplied,
    freeMinutes,
    chargedMinutes,
    outsideMinutes,
    nightClosedMinutes,
    notes,
  };
}

/**
 * Identifies which overnight period a night segment belongs to: the evening it
 * started. Anything before 07:00 belongs to the previous evening's night.
 */
function nightKey(isoDate: string, minutesOfDay: number): string {
  if (minutesOfDay >= DAY_END) return isoDate;
  const [y, m, d] = isoToParts(isoDate);
  const prev = new Date(Date.UTC(y, m - 1, d));
  prev.setUTCDate(prev.getUTCDate() - 1);
  return prev.toISOString().slice(0, 10);
}

function isoToParts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y ?? 1970, m ?? 1, d ?? 1];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * HDB charges its higher rate at car parks in the URA CENTRAL AREA, and no
 * published dataset carries that flag, so it is derived from position: a
 * point-in-polygon test against the 11 Central Area planning areas, baked into
 * central-area.json by `npm run import-central-area`.
 *
 * This replaced a bounding box that swept in whole heartland estates — Tiong
 * Bahru, Queenstown, Bukit Merah, Toa Payoh — and billed them double. The trap
 * is that Central AREA is not Central REGION: Bukit Merah is in the region but
 * not the area, so Blk 77/72/71/58 Seng Poh Road is $0.60 per half hour, as
 * parking.sg shows, not $1.20.
 */
export function isProbablyCentral(lat: number, lng: number): boolean {
  // Cheap reject first: the Central Area sits well inside this box, so most
  // car parks in Singapore never touch the ring maths.
  if (lat < 1.24 || lat > 1.34 || lng < 103.79 || lng > 103.91) return false;
  return CENTRAL_RINGS.some((ring) => pointInRing(lng, lat, ring));
}

/** Ray casting: count crossings of the ring by a ray heading east from (x,y). */
function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    // Does the edge straddle the ray's latitude, and is the crossing east of x?
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
