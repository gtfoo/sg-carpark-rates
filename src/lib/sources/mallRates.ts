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
  return repairAmounts(s.replace(/Â/g, "").trim());
}

/**
 * Repairs money written with a doubled decimal, e.g. "$3.27.00".
 *
 * LTA's data contains these, and left alone the amount pattern matches the
 * TAIL of the token — "$3.27.00 for 1st hr" was read as $27.00, so
 * 313@Somerset quoted $30.28 for two hours instead of $6.55. A plausible-
 * looking number is the dangerous kind of wrong, so the trailing group is
 * dropped rather than the string being rejected.
 */
function repairAmounts(s: string): string {
  return s.replace(/(\$\s*\d+\.\d{2})\.\d{1,2}\b/g, "$1");
}

const NUM = String.raw`\$?\s*(\d+(?:\.\d+)?)`;

// A time block: half-hour (½ / "half hr" / "half hour"), N minutes, N hours,
// or an hour. Bare "min"/"minute" is deliberately excluded — that's the
// per-minute case. The multi-hour form must come before the bare one so
// "$5.35 every 4 hrs" consumes the "4"; otherwise the block reads as one hour
// and the 4 is left looking like a price.
// "1/2 hr" is listed with the half-hour forms and must come before the
// multi-hour branch, or the "2" of "1/2" reads as a two-hour block.
// The hyphen is for Palais Renaissance's "$3.80 per 4-hourly"; without it the
// multi-hour branch can't cross it and the whole pattern falls through.
const BLOCK_UNIT = String.raw`(?:½|half|1/2)\s*(?:hr|hour)|\d+\s*min(?:ute)?s?|\d+\s*-?\s*(?:hrs?|hours?)|hrs?|hours?`;

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
/**
 * "Aft 10pm", "After 5.30pm" — LTA's evening column names only the time the
 * band opens and leaves the close implied.
 */
const openFromRe = () =>
  new RegExp(String.raw`\b(?:aft|after)\.?\s*(${CLOCK})`, "gi");

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
 * Splits a rate into time bands, cutting wherever a new clock range opens.
 *
 * Punctuation can't be trusted in either direction. A semicolon does NOT
 * reliably separate bands — LTA writes a single band's tiers with one,
 * "7.00am-5.59pm: $3.90 for 1st hr; $1.95 per sub.½ hr", and cutting there
 * strands the first tier with no subsequent-block price. And a semicolon is not
 * required BETWEEN bands either: Bras Basah Complex writes
 * "7.00am-10.00am: $1.20 per ½ hr. 10.00am-10.30pm: $1.40 per ½ hr." with a
 * full stop, and splitting on ";" alone left the second band unreachable, so
 * every afternoon arrival was priced at the morning rate. 60 stored rates had
 * at least one band that could never be selected.
 *
 * So boundaries are found by position, not by separator: a clock range starts a
 * new band only once the band before it has been priced. That "$ seen since the
 * last cut" test is what keeps a band's own second range attached to it —
 * "7am-5pm & 11pm-7am: $1.50 …" is one band with two ranges, not two bands.
 */
function splitBands(raw: string): string[] {
  const marks = [...raw.matchAll(timeRangeRe()), ...raw.matchAll(openFromRe())]
    .map((m) => m.index ?? 0)
    .sort((a, b) => a - b);

  // A cut is only allowed once the text since the last one is a COMPLETE band:
  // its own clock range and its own price. Either half alone misreads a string.
  // Without the range test, "Daily free: 7.00am-7.00pm" cuts after "free" and
  // strands the hours with no rate; without the price test, "7am-5pm &
  // 11pm-7am: $1.50 …" splits one band's two ranges apart. "Free" counts as a
  // price because "7.00am-10.00pm: Free; 10.00pm-7.00am: $2.70/hr" states no
  // amount for its first band, and merging the two charged for the free hours.
  const closesBand = (s: string) =>
    timeRangeRe().test(s) && (s.includes("$") || /\bfree\b/i.test(s));
  // A range in brackets is an aside about the band it sits in, not a new one:
  // "$0.60 per 30 mins (8:30am-12pm, 2pm-5am); Free 5am-8:30am". Cutting there
  // stranded the amount and handed the hours to the wrong rate.
  const bracketed = (upto: string) =>
    upto.split("(").length > upto.split(")").length;

  // The first band always starts at the beginning: anything before the opening
  // range ("Mon-Thu: 7.00am-5.00pm: …") belongs with it.
  const starts = [0];
  for (const at of marks) {
    const from = starts[starts.length - 1]!;
    if (at <= from) continue;
    if (!closesBand(raw.slice(from, at)) || bracketed(raw.slice(0, at))) continue;
    starts.push(at);
  }

  return starts
    .map((from, i) =>
      raw
        .slice(from, starts[i + 1] ?? raw.length)
        // Cutting by position keeps the separator the old split consumed, and
        // this text is shown to the user as "Applied rate".
        .replace(/[\s;,.]+$/, "")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Removes a daily-cap clause before the rate patterns run. "Capped at $35 per
 * 24hrs" is a ceiling, not a rate, but it looks exactly like one — Changi
 * Airport's South car park was quoting it as $35 for two hours when the real
 * charge is 3.5 cents a minute. parseLimits reads the cap separately.
 */
function withoutCaps(s: string): string {
  return s.replace(/capp?ed\s*(?:at)?\s*\$?\s*[\d.]+[^,.;]*/gi, " ").trim();
}

/**
 * Two ways operators write an amount that the patterns can't see through.
 *
 * Chinatown Point puts a note between the amount and its unit — "$1.96 (with 9%
 * GST) for every 30min" — which breaks the adjacency every pattern relies on.
 * The figure already includes the tax, so the note carries no arithmetic.
 *
 * East Coast Park writes small amounts in cents: "60¢ per 30min".
 */
function normaliseAmounts(s: string): string {
  return s
    .replace(/\([^)]*\bgst\b[^)]*\)/gi, " ")
    .replace(/(\d+)\s*¢/g, (_, cents: string) => `$${(Number(cents) / 100).toFixed(2)}`);
}

/** Drops the clock prefix so the fee patterns can't read "5pm-11pm" as money. */
function stripBandPrefix(seg: string): string {
  const stripped = seg
    .replace(timeRangeRe(), " ")
    .replace(openFromRe(), " ")
    .replace(/^[\s&,:-]+/, "")
    .trim();
  return stripped || seg;
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
      if (covers(from, to, minutesOfDay)) return stripBandPrefix(seg);
    }
  }

  // Nothing with an explicit range covered the arrival. An open-ended band
  // ("Aft 10pm: $2 per entry") runs until the next band opens, so borrow the
  // earliest start the others declare as its close.
  const starts = [...raw.matchAll(timeRangeRe())]
    .map((m) => parseClock(m[1]!))
    .filter((n): n is number => n !== null);
  const until = starts.length ? Math.min(...starts) : null;
  for (const seg of segments) {
    for (const m of seg.matchAll(openFromRe())) {
      const from = parseClock(m[1]!);
      if (from === null) continue;
      // With no other band declaring a range there is nothing to close this
      // one against, so it only covers the rest of the day — never the morning.
      // Half the dataset writes the daytime column with no clock at all
      // ("$7 per hr." / "Aft 6pm: $7 per entry"), and treating the evening band
      // as the fallback there quoted the evening price at lunchtime.
      const covered =
        until === null ? minutesOfDay >= from : covers(from, until, minutesOfDay);
      if (covered) return stripBandPrefix(seg);
    }
  }
  return raw;
}

export function parseRate(rawInput: string): ParsedRate {
  const raw = normaliseAmounts(withoutCaps(repairEncoding(rawInput ?? "")));
  if (!raw || raw === "-" || raw.toLowerCase() === "na") return { kind: "none" };
  // Republic Plaza's row reads "Same s Saturday". Missing the typo left Sunday
  // unpriced when it should simply have billed as Saturday, so the day word is
  // what's matched on rather than the exact phrase.
  if (/same as/i.test(raw) || /\bsame\b[^.;]{0,6}\b(?:sat|sun|wk|weekday)/i.test(raw)) {
    return { kind: "same-as-other" };
  }
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
  // The first period often carries a count — "for 1st 2 hrs", "1st 3 hours" —
  // and that count MUST be captured here. Miss it and the whole pattern fails,
  // then the per-block pattern below reads the bare "2" as a price and quotes
  // $2 an hour: 49 stored rates priced that way, every one of them wrong.
  // "1st hr", "the first 1 hour", "1st 2-hrs" — all the same thing.
  const FIRST_PERIOD = `(?:the\\s*)?(?:1st|first)\\s*(?:(\\d+)[\\s-]*)?(${RATE_UNIT})`;
  // Both amounts must carry a "$". Without it the follow-on half of the pattern
  // will happily read the "30" of "30min" as thirty dollars a minute — which is
  // exactly what "$1.80 for 1st hr, sub 30min at $1.20" does.
  const MONEY = String.raw`\$\s*(\d+(?:\.\d+)?)`;
  const firstThen = raw.match(
    new RegExp(
      `${MONEY}${SEPS}${FIRST_PERIOD}` +
        // "for each sub. ½ hr", "for next sub 30min", "per subsequent hour".
        // "sub" is optional: plenty of operators just write the follow-on rate
        // straight after a comma ("$3.27 for 1st 2 hrs, $1.64 per 30 mins").
        `[\\s\\S]*?${MONEY}${SEPS}(?:(?:the|each|next)\\s*)*(?:sub[a-z]*\\.?\\s*)?` +
        `(${RATE_UNIT})`,
      "i",
    ),
  );
  if (firstThen) {
    const firstUnits = firstThen[2] ? Number(firstThen[2]) : 1;
    return {
      kind: "first-then",
      firstDollars: Number(firstThen[1]),
      firstMinutes: firstUnits * unitToMinutes(firstThen[3]!),
      thenDollars: Number(firstThen[4]),
      thenBlockMinutes: unitToMinutes(firstThen[5]!),
    };
  }

  // Some operators write the period first and the amount after it: Clarke Quay
  // has "1st hour @ $1.60, $0.55 for subsequent 15 min", Jurong Point "1st hr
  // at $1.50; $0.75 every sub. 30min". Same rate, reversed clause — tried only
  // once the ordinary form has failed.
  const firstThenReversed = raw.match(
    new RegExp(
      `${FIRST_PERIOD}\\s*(?:at|@|[-–])\\s*${MONEY}` +
        `[\\s\\S]*?${MONEY}${SEPS}(?:(?:the|each|next)\\s*)*(?:sub[a-z]*\\.?\\s*)?` +
        `(${RATE_UNIT})`,
      "i",
    ),
  );
  if (firstThenReversed) {
    const units = firstThenReversed[1] ? Number(firstThenReversed[1]) : 1;
    return {
      kind: "first-then",
      firstDollars: Number(firstThenReversed[3]),
      firstMinutes: units * unitToMinutes(firstThenReversed[2]!),
      thenDollars: Number(firstThenReversed[4]),
      thenBlockMinutes: unitToMinutes(firstThenReversed[5]!),
    };
  }

  // "$1.30 / 30 Mins", "$1.20 per half hour", "$3.20 every 30 min", "$2 hourly"
  //
  // MUST be tried before the per-minute pattern: in "$1.30 / 30 Mins" the
  // block size "30 Mins" otherwise gets misread as a rate of $30 per minute,
  // which silently produces a $3,600 two-hour fee.
  // The separator ("per"/"for"/"every"/"each"/"/") is optional so adjectival
  // LTA forms parse too ("$3.03 half hourly", "$2 hourly") — which is why the
  // "$" is required: without it "Capped at $35 per 24hrs" splits into a price
  // of 24 and a unit of "hrs", quoting $24 an hour for a car park that charges
  // 3.5 cents a minute.
  const perBlock = raw.match(
    new RegExp(`${MONEY}${SEPS}(${BLOCK_UNIT})`, "i"),
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

  // Funan writes the block first: "Every 15min of part thereof at $0.65".
  //
  // The leading "every/each/per" is what makes this safe. Without it the same
  // pattern reads Tekka Place's "$1.80 for 1st hr, sub 30min at $1.20" as a
  // flat $1.20 an hour, losing the first-hour charge entirely — a plausible
  // wrong number, which is worse than the blank it gives today.
  const perBlockReversed = raw.match(
    new RegExp(`(?:every|each|per)\\s+(${BLOCK_UNIT})[^$;]{0,24}?(?:at|@)\\s*${MONEY}`, "i"),
  );
  if (perBlockReversed) {
    const blockMinutes = unitToMinutes(perBlockReversed[1]!);
    const dollars = Number(perBlockReversed[2]);
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
  if (u.includes("½") || u.includes("half") || u.includes("1/2")) return 30;
  // "4hrs" is four hours, not four minutes — the bare-number fallback below
  // would otherwise read it as the latter. It must also cover the hyphenated
  // and adjectival forms: teaching BLOCK_UNIT to match "4-hourly" without
  // teaching this priced it as $3.80 per FOUR MINUTES, i.e. $114 for two
  // hours. The implausibility check caught that; it should never have needed
  // to.
  const hrs = u.match(/^(\d+)-?(?:hrs?|hours?|hourly)$/);
  if (hrs) return Number(hrs[1]) * 60;
  if (u.startsWith("hr") || u.startsWith("hour")) return 60;
  const mins = u.match(/(\d+)min/);
  if (mins) return Number(mins[1]);
  // Bare "min"/"minute"/"minutes" (no leading number) is one minute.
  if (u.startsWith("min")) return 1;
  const n = u.match(/^(\d+)/);
  return n ? Number(n[1]) : 60;
}

/**
 * LTA splits weekdays across two columns — a daytime band and, for 301 of the
 * 357 rows, an evening one ("7am-6pm: $1.20 for 1st hr" / "6pm-3.30am: $3 per
 * entry"). About half repeat the first column word for word, so only genuinely
 * new text is appended, joined with the semicolon splitBands looks for.
 */
export function joinWeekdayBands(first: string, second: string): string {
  const a = repairEncoding(first ?? "");
  const b = repairEncoding(second ?? "");
  const absent = (s: string) => !s || s === "-" || /^na$/i.test(s);
  // Ignore spacing and full stops: the duplicate columns differ only by a
  // stray space ("sub.½ hr" against "sub. ½ hr").
  const key = (s: string) => s.toLowerCase().replace(/[\s.]/g, "");
  if (absent(b) || key(a) === key(b)) return a;
  if (absent(a)) return b;
  return `${a}; ${b}`;
}

/**
 * The rate text as published, NOT a parsed rate: which band applies depends on
 * when the driver arrives, and that isn't known until a search runs. Parsing
 * here is what made the whole evening column unreachable.
 */
export interface MallCarparkRateText {
  name: string;
  category: string;
  weekday: string;
  saturday: string;
  sundayPh: string;
}

export async function fetchMallRates(): Promise<MallCarparkRateText[]> {
  const raw = await fetchAllRecords<RawMallRate>(LTA_CARPARK_RATES);

  return raw.map((r) => ({
    name: repairEncoding(r.carpark),
    category: repairEncoding(r.category),
    weekday: joinWeekdayBands(r.weekdays_rate_1, r.weekdays_rate_2),
    saturday: repairEncoding(r.saturday_rate ?? ""),
    sundayPh: repairEncoding(r.sunday_publicholiday_rate ?? ""),
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
/**
 * The same day-to-column fallback as rateForDay, but on the published text so
 * a band can still be chosen afterwards. The LTA dataset has no Friday column,
 * so Friday always reads the weekday one.
 */
export function rateTextForDay(
  rates: MallCarparkRateText,
  dayType: DayType,
): string {
  const absent = (s: string) => {
    const v = (s ?? "").trim();
    return !v || v === "-" || /^na$/i.test(v);
  };
  const or = (s: string) => (absent(s) ? rates.weekday : s);
  if (dayType === "weekday" || dayType === "friday") return rates.weekday;
  if (dayType === "saturday") return or(rates.saturday);
  if (/same as/i.test(rates.sundayPh)) return or(rates.saturday);
  return or(rates.sundayPh);
}

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
