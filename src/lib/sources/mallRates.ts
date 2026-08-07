import { fetchAllRecords } from "./datagov";
import type { DayType } from "../fees";

const LTA_CARPARK_RATES = "d_9f6056bdb6b1dfba57f063593e4f34ae";

/**
 * LTA's carpark rates dataset (malls, hotels, attractions).
 *
 * KNOWN LIMITATIONS — surface these in the UI, do not hide them:
 *  - 357 rows only; a fraction of Singapore's commercial carparks.
 *  - Created Nov 2018, last updated Jun 2024. Rates have moved since.
 *  - Rates are free text written for humans, not machines.
 *  - No coordinates at all — only a name string, so joining to a map
 *    position requires fuzzy geocoding.
 *  - Says nothing about grace periods, per-entry caps, or complimentary
 *    parking with minimum spend, which often dominate the real cost.
 */
interface RawMallRate {
  carpark: string;
  category: string;
  weekdays_rate_1: string;
  weekdays_rate_2: string;
  saturday_rate: string;
  sunday_publicholiday_rate: string;
}

export type ParsedRate =
  | { kind: "per-minute"; dollars: number }
  | { kind: "per-block"; dollars: number; blockMinutes: number }
  | {
      kind: "first-then";
      firstDollars: number;
      firstMinutes: number;
      thenDollars: number;
      thenBlockMinutes: number;
    }
  | { kind: "flat-per-entry"; dollars: number }
  | { kind: "same-as-other" }
  | { kind: "none" }
  | { kind: "unparsed"; raw: string };

export interface MallCarparkRates {
  name: string;
  category: string;
  weekday: ParsedRate;
  /** Only set by saved rates; the LTA dataset has no Friday column. */
  friday?: ParsedRate;
  saturday: ParsedRate;
  sundayPh: ParsedRate;
}

/**
 * The API returns UTF-8 that has been double-encoded upstream, so "½"
 * arrives as "Â½". Repair before matching or the fraction patterns miss.
 */
function repairEncoding(s: string): string {
  return s.replace(/Â/g, "").trim();
}

const NUM = String.raw`\$?\s*(\d+(?:\.\d+)?)`;

// A time block: half-hour (½ / "half hr" / "half hour"), N minutes, or an hour.
// Bare "min"/"minute" is deliberately excluded — that's the per-minute case.
const BLOCK_UNIT = String.raw`(?:½|half)\s*(?:hr|hour)|\d+\s*min(?:ute)?s?|hrs?|hours?`;

// Words operators put between an amount and its unit. These sources are
// hand-written prose, so the same rate appears as "per", "for", "every",
// "each" or just "/" — and sometimes nothing at all ("$2 hourly").
const SEP = String.raw`/|per|for|every|each`;

// Zero or more separator words, then optional space. Repeatable because the
// published text contains typos like "$1.50 for for sub. ½ hr".
const SEPS = `(?:\\s*(?:${SEP}))*\\s*`;

/** "7am", "5.30pm", "12.01am", "1759hrs" -> minutes since midnight. */
function parseClock(s: string): number | null {
  const t = s.trim();
  let m = t.match(/^(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)$/i);
  if (m) {
    let h = parseInt(m[1]!, 10) % 12;
    if (/pm/i.test(m[3]!)) h += 12;
    return h * 60 + (m[2] ? parseInt(m[2], 10) : 0);
  }
  m = t.match(/^(\d{3,4})\s*hrs?$/i);
  if (m) {
    const v = m[1]!.padStart(4, "0");
    return parseInt(v.slice(0, 2), 10) * 60 + parseInt(v.slice(2), 10);
  }
  return null;
}

const CLOCK = String.raw`\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm)|\d{3,4}\s*hrs?`;
/** Fresh each call — a global regex carries lastIndex between uses. */
const timeRangeRe = () =>
  new RegExp(`(${CLOCK})\\s*(?:-|–|to)\\s*(${CLOCK})`, "gi");

/** Does [from,to) cover t? Ranges may wrap past midnight (e.g. 11pm-7am). */
function covers(from: number, to: number, t: number): boolean {
  return to > from ? t >= from && t < to : t >= from || t < to;
}

/**
 * Operators often put several time bands in one rate string, e.g.
 *   "7am-5pm & 11pm-7am: $1.50 for 1st 30 mins, $0.05/min; 5pm-11pm: $3.00 per entry"
 * Returns just the band covering `minutesOfDay`, with the clock prefix stripped
 * so the fee patterns don't read "5pm-11pm" as an amount. Strings without
 * multiple bands are returned untouched.
 */
/**
 * Splits a rate into time bands.
 *
 * A semicolon does NOT reliably separate bands: LTA writes a single band's
 * tiers with one — "7.00am-5.59pm: $3.90 for 1st hr; $1.95 per sub.½ hr" — and
 * cutting there strands "$3.90 for 1st hr" with no subsequent-block price,
 * which parses as nothing at all. So a segment only starts a NEW band when it
 * introduces its own clock range before any dollar amount; otherwise it
 * belongs to the band before it.
 */
function splitBands(raw: string): string[] {
  const bands: string[] = [];
  for (const part of raw.split(";")) {
    const beforeMoney = part.split("$")[0] ?? part;
    const startsBand = timeRangeRe().test(beforeMoney);
    if (startsBand || bands.length === 0) bands.push(part);
    else bands[bands.length - 1] += `;${part}`;
  }
  return bands.map((s) => s.trim()).filter(Boolean);
}

export function bandForTime(rawInput: string, minutesOfDay: number): string {
  const raw = repairEncoding(rawInput ?? "");
  const segments = splitBands(raw);
  if (segments.length < 2) return raw;

  for (const seg of segments) {
    for (const m of seg.matchAll(timeRangeRe())) {
      const from = parseClock(m[1]!);
      const to = parseClock(m[2]!);
      if (from === null || to === null) continue;
      if (covers(from, to, minutesOfDay)) {
        const stripped = seg
          .replace(timeRangeRe(), " ")
          .replace(/^[\s&,:-]+/, "")
          .trim();
        return stripped || seg;
      }
    }
  }
  return raw;
}

export function parseRate(rawInput: string): ParsedRate {
  const raw = repairEncoding(rawInput ?? "");
  if (!raw || raw === "-" || raw.toLowerCase() === "na") return { kind: "none" };
  if (/same as/i.test(raw)) return { kind: "same-as-other" };
  // "Free", "Daily free: 7am-7pm", etc. — free whenever "free" appears and no
  // dollar amount does. (Mixed free/paid text falls through to normal parsing.)
  if (/\bfree\b/i.test(raw) && !/\$\s*\d/.test(raw)) {
    return { kind: "per-block", dollars: 0, blockMinutes: 60 };
  }

  // "$1.20 for 1st hr; $0.60 for sub. ½ hr or part thereof."
  // "$3.90 for 1st hr; $1.95 per sub.½ hr"  <- "per" before "sub" is common too.
  // "$5.00 for 1st hr; $0.10 for next sub. min." <- the subsequent block can be
  // per-minute, so the unit here also accepts a bare "min"/"minute" (excluded
  // from BLOCK_UNIT, which is why unitToMinutes maps it to 1 minute).
  const RATE_UNIT = `(?:${BLOCK_UNIT})|min(?:ute)?s?`;
  const firstThen = raw.match(
    new RegExp(
      `${NUM}${SEPS}(?:the\\s*)?1st\\s*(${RATE_UNIT})` +
        // "for each sub. ½ hr", "for next sub 30min", "per subsequent hour"
        `[\\s\\S]*?${NUM}${SEPS}(?:(?:each|next)\\s*)?(?:sub\\.?|subsequent)\\s*` +
        `(${RATE_UNIT})`,
      "i",
    ),
  );
  if (firstThen) {
    return {
      kind: "first-then",
      firstDollars: Number(firstThen[1]),
      firstMinutes: unitToMinutes(firstThen[2]!),
      thenDollars: Number(firstThen[3]),
      thenBlockMinutes: unitToMinutes(firstThen[4]!),
    };
  }

  // "$1.30 / 30 Mins", "$1.20 per half hour", "$3.20 every 30 min", "$2 hourly"
  //
  // MUST be tried before the per-minute pattern: in "$1.30 / 30 Mins" the
  // block size "30 Mins" otherwise gets misread as a rate of $30 per minute,
  // which silently produces a $3,600 two-hour fee.
  // The separator ("per"/"for"/"every"/"each"/"/") is optional so adjectival
  // LTA forms parse too ("$3.03 half hourly", "$2 hourly").
  const perBlock = raw.match(
    new RegExp(`${NUM}${SEPS}(${BLOCK_UNIT})`, "i"),
  );
  if (perBlock) {
    const dollars = Number(perBlock[1]);
    const blockMinutes = unitToMinutes(perBlock[2]!);
    // Guard against a 0-minute block (would divide by zero → Infinity). If the
    // match is degenerate, fall through to the remaining patterns.
    if (dollars > 0 && blockMinutes > 0) {
      return { kind: "per-block", dollars, blockMinutes };
    }
  }

  // "$0.018 /min", "$0.06 per minute". The dollar sign is required — without it
  // any bare number sitting next to the word "min" gets treated as a rate.
  const perMin = raw.match(
    new RegExp(`\\$\\s*(\\d+(?:\\.\\d+)?)${SEPS}min(?:ute)?s?\\b`, "i"),
  );
  if (perMin) {
    const dollars = Number(perMin[1]);
    // No real Singapore carpark charges a dollar a minute; anything that high
    // means we matched a quantity, not a price.
    if (dollars > 0 && dollars < 1) return { kind: "per-minute", dollars };
    return { kind: "unparsed", raw };
  }

  // "$2.00 per entry"
  const flat = raw.match(new RegExp(`${NUM}\\s*(?:per|/)\\s*entry`, "i"));
  if (flat) return { kind: "flat-per-entry", dollars: Number(flat[1]) };

  return { kind: "unparsed", raw };
}

function unitToMinutes(unit: string): number {
  const u = unit.toLowerCase().replace(/\s+/g, "");
  if (u.includes("½") || u.includes("half")) return 30;
  if (u.startsWith("hr") || u.startsWith("hour")) return 60;
  const mins = u.match(/(\d+)min/);
  if (mins) return Number(mins[1]);
  // Bare "min"/"minute"/"minutes" (no leading number) is one minute.
  if (u.startsWith("min")) return 1;
  const n = u.match(/^(\d+)/);
  return n ? Number(n[1]) : 60;
}

export async function fetchMallRates(): Promise<MallCarparkRates[]> {
  const raw = await fetchAllRecords<RawMallRate>(LTA_CARPARK_RATES);

  return raw.map((r) => ({
    name: repairEncoding(r.carpark),
    category: repairEncoding(r.category),
    weekday: parseRate(r.weekdays_rate_1),
    saturday: parseRate(r.saturday_rate),
    sundayPh: parseRate(r.sunday_publicholiday_rate),
  }));
}

/** Human-readable description of a parsed rate, for the fee breakdown UI. */
export function describeRate(rate: ParsedRate): string {
  const block = (m: number) =>
    m === 60 ? "hour" : m === 1 ? "min" : m === 30 ? "30 min" : `${m} min`;
  switch (rate.kind) {
    case "per-minute":
      return `$${rate.dollars.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}/min`;
    case "per-block":
      return rate.dollars === 0
        ? "free"
        : `$${rate.dollars.toFixed(2)} per ${block(rate.blockMinutes)}`;
    case "first-then":
      return `$${rate.firstDollars.toFixed(2)} first ${block(rate.firstMinutes)}, then $${rate.thenDollars.toFixed(2)} per ${block(rate.thenBlockMinutes)}`;
    case "flat-per-entry":
      return `$${rate.dollars.toFixed(2)} per entry`;
    case "same-as-other":
      return "same as Saturday";
    case "none":
      return "no charge";
    case "unparsed":
      return rate.raw.slice(0, 60);
  }
}

/**
 * The two rules that sit outside the per-block price and change what's actually
 * charged: free minutes at the start, and a ceiling on the day.
 */
export interface RateLimits {
  /** Free minutes from entry, e.g. Techquest's 20-minute grace period. */
  graceMinutes: number | null;
  /**
   * What those free minutes mean — the two conventions charge differently:
   *
   *  "threshold" — the usual "grace period". Leave inside it and pay nothing;
   *    stay a minute longer and the FULL duration is charged from entry. Changi
   *    spells it out: "full parking charges will apply for vehicles that stay
   *    beyond 10 minutes from the time of entry".
   *  "deduct" — the free minutes come off the bill, as in "first 15 min free".
   *
   * Treating a threshold as a deduction undercharges: 20 minutes at Changi is
   * two 15-minute blocks ($1.30), not one ($0.65).
   */
  graceMode: "threshold" | "deduct";
  /** Most the session can cost, e.g. a "whole day max cap: $20.00". */
  capDollars: number | null;
}

export const NO_LIMITS: RateLimits = {
  graceMinutes: null,
  graceMode: "threshold",
  capDollars: null,
};

/**
 * Reads a grace period and a daily cap out of free text.
 *
 * These are published alongside the rate rather than inside it — the AI
 * extractor is told to put them in the notes, and operators write them as
 * "Grace Period : 20 Minutes" or "Whole Day Max Cap: $20.00". Ignoring them
 * overcharges long stays and charges at all for stays inside the grace.
 *
 * Deliberately conservative: a number must be tied to a grace/cap word, so
 * "min spend $20" or "maximum stay 2 hours" don't become a $20 cap.
 */
export function parseLimits(text: string): RateLimits {
  const t = repairEncoding(text ?? "");
  if (!t) return NO_LIMITS;

  let graceMinutes: number | null = null;
  let graceMode: "threshold" | "deduct" = "threshold";
  for (const [re, mode] of [
    [/grace(?:\s*period)?[^0-9]{0,14}(\d{1,3})\s*(?:min|minute)/i, "threshold"],
    [/(\d{1,3})\s*[-\s]*(?:min|minute)s?\s*(?:'s)?\s*grace/i, "threshold"],
    // "first 15 min free" takes the minutes off the bill instead.
    [/first\s*(\d{1,3})\s*(?:min|minute)s?\s*(?:is\s*|are\s*)?free/i, "deduct"],
  ] as const) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      // A "grace period" longer than a couple of hours is a misread.
      if (Number.isFinite(n) && n > 0 && n <= 180) {
        graceMinutes = n;
        graceMode = mode;
      }
      break;
    }
  }

  let capDollars: number | null = null;
  for (const re of [
    /(?:max(?:imum)?|cap(?:ped)?)[^.$]{0,24}\$\s*(\d+(?:\.\d{1,2})?)/i,
    /\$\s*(\d+(?:\.\d{1,2})?)\s*(?:max(?:imum)?|cap)/i,
  ]) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      // Below a dollar it's a per-block price that happened to sit near the
      // word; above a few hundred it isn't a day cap either.
      if (Number.isFinite(n) && n >= 1 && n <= 300) capDollars = n;
      break;
    }
  }

  return { graceMinutes, graceMode, capDollars };
}

/** Cost in dollars for `minutes` of parking, or null if the rate is unusable. */
export function estimateMallFee(
  rate: ParsedRate,
  minutes: number,
  limits: RateLimits = NO_LIMITS,
): number | null {
  // Leave inside the grace and pay nothing, either way. Past it, only a
  // "first N free" deduction reduces the billed time — a plain grace period
  // charges the whole stay from entry.
  let billable = minutes;
  if (limits.graceMinutes) {
    if (minutes <= limits.graceMinutes) billable = 0;
    else if (limits.graceMode === "deduct") billable = minutes - limits.graceMinutes;
  }

  const gross = grossFee(rate, billable);
  if (gross === null) return null;
  if (limits.capDollars === null) return gross;
  return Math.min(gross, limits.capDollars);
}

function grossFee(rate: ParsedRate, minutes: number): number | null {
  // A session entirely inside the grace period is free — but only for rates we
  // could actually price, so an unparseable rate still reads "not computable".
  const priceable =
    rate.kind === "per-minute" ||
    rate.kind === "per-block" ||
    rate.kind === "first-then" ||
    rate.kind === "flat-per-entry";
  if (minutes <= 0) return priceable ? 0 : null;

  switch (rate.kind) {
    case "per-minute":
      return rate.dollars * minutes;
    case "per-block":
      // Guard against a bad 0-minute block yielding Infinity.
      if (rate.blockMinutes <= 0) return null;
      return rate.dollars * Math.ceil(minutes / rate.blockMinutes);
    case "first-then": {
      if (rate.thenBlockMinutes <= 0) return null;
      if (minutes <= rate.firstMinutes) return rate.firstDollars;
      const rest = minutes - rate.firstMinutes;
      return (
        rate.firstDollars +
        rate.thenDollars * Math.ceil(rest / rate.thenBlockMinutes)
      );
    }
    case "flat-per-entry":
      return rate.dollars;
    default:
      return null;
  }
}

/**
 * Picks the rate column matching the day. Public holidays bill at the Sunday
 * rate. "Same as Saturday" is a literal value in this dataset, so sunday-ph
 * falls back to the Saturday column when it says that.
 *
 * Friday only has its own column where an operator prices it with the weekend;
 * otherwise it falls back to the weekday rate, which is the common case and
 * what the LTA dataset assumes (it has no Friday column at all).
 */
export function rateForDay(
  rates: MallCarparkRates,
  dayType: DayType,
): ParsedRate {
  if (dayType === "weekday") return rates.weekday;
  if (dayType === "friday") {
    return !rates.friday || rates.friday.kind === "none"
      ? rates.weekday
      : rates.friday;
  }
  if (dayType === "saturday") {
    return rates.saturday.kind === "none" ? rates.weekday : rates.saturday;
  }
  if (rates.sundayPh.kind === "same-as-other") {
    return rates.saturday.kind === "none" ? rates.weekday : rates.saturday;
  }
  return rates.sundayPh.kind === "none" ? rates.weekday : rates.sundayPh;
}
