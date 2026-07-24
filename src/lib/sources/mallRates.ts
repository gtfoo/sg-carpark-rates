import { fetchAllRecords } from "./datagov";

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
  const firstThen = raw.match(
    new RegExp(
      `${NUM}${SEPS}(?:the\\s*)?1st\\s*(${BLOCK_UNIT})` +
        // "for each sub. ½ hr", "for next sub 30min", "per subsequent hour"
        `[\\s\\S]*?${NUM}${SEPS}(?:(?:each|next)\\s*)?(?:sub\\.?|subsequent)\\s*` +
        `(${BLOCK_UNIT})`,
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

  // "$0.018 /min". The dollar sign is required — without it any bare number
  // sitting next to the word "min" gets treated as a rate.
  const perMin = raw.match(
    new RegExp(`\\$\\s*(\\d+(?:\\.\\d+)?)\\s*/?\\s*(?:per\\s*)?mins?\\b`, "i"),
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
    m === 60 ? "hour" : m === 30 ? "30 min" : `${m} min`;
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

/** Cost in dollars for `minutes` of parking, or null if the rate is unusable. */
export function estimateMallFee(
  rate: ParsedRate,
  minutes: number,
): number | null {
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
 */
export function rateForDay(
  rates: MallCarparkRates,
  dayType: "weekday" | "saturday" | "sunday-ph",
): ParsedRate {
  if (dayType === "weekday") return rates.weekday;
  if (dayType === "saturday") {
    return rates.saturday.kind === "none" ? rates.weekday : rates.saturday;
  }
  if (rates.sundayPh.kind === "same-as-other") {
    return rates.saturday.kind === "none" ? rates.weekday : rates.saturday;
  }
  return rates.sundayPh.kind === "none" ? rates.weekday : rates.sundayPh;
}
