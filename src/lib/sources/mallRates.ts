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
// "1h" (The Robertson House) needs its own branch after the spelled-out one,
// so "2 hrs" still matches the fuller form first. The lookahead stops the bare
// "h" swallowing the start of a word — and note this branch is USELESS without
// the matching case in unitToMinutes, which would otherwise read "1h" as one
// minute.
const BLOCK_UNIT = String.raw`(?:½|half|1/2)\s*(?:hr|hour)|\d+\s*min(?:ute)?s?|\d+\s*-?\s*(?:hrs?|hours?)|\d+\s*-?\s*h(?![a-z])|hrs?|hours?`;

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
  // Bare 24-hour, colon only: "19:00", "07:00", "00:00". AI-retrieved rates
  // write times this way where LTA writes "7.00am".
  //
  // The DOT form is deliberately excluded. "7.00" is indistinguishable from an
  // amount, and rate text is full of them.
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = parseInt(m[1]!, 10);
    const min = parseInt(m[2]!, 10);
    // 24:00 is a legitimate way to write midnight as a closing time.
    if (h > 24 || min > 59) return null;
    return ((h % 24) * 60 + min) % (24 * 60);
  }
  return null;
}

// The bare 24-hour form is listed LAST so "7:00am" is still captured with its
// meridiem by the first alternative rather than truncated to "7:00".
const CLOCK = String.raw`\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm)|\d{3,4}\s*hrs?|\d{1,2}:\d{2}`;
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
/**
 * Fallback for bands whose hours are written in BRACKETS after the amount.
 *
 * Waterfront Plaza & King's Centre reads "$3.50 for 1st hr, $2.00 for add'l hr
 * (07:00-17:00); $4.00 per entry (17:00-07:00)". splitBands cuts at the START
 * of a clock range and refuses to cut inside brackets, so it found no boundary
 * at all: the whole string parsed as one band, the last clause won, and every
 * arrival was charged $4.00 — undercharging a daytime stay that costs $5.50.
 *
 * The bracket refusal cannot simply be relaxed. Jurong Lake Gardens
 * ("$0.60 per 30 mins (8:30am-12pm, 2pm-5am); Free 5am-8:30am & 12pm-2pm")
 * puts a band's own several ranges in brackets, and cutting inside them
 * stranded the amount and handed the hours to the wrong rate.
 *
 * So this is a SEPARATE boundary, tried only when the primary rule found no
 * cut. Two conditions make it safe:
 *
 *  - It never runs on a string the primary rule already split, so JLG — which
 *    it does split — is untouched.
 *  - EVERY semicolon clause must carry both a price and a clock range. That is
 *    what excludes a single band written in tiers: "7.00am-5.59pm: $3.90 for
 *    1st hr; $1.95 per sub.½ hr" has a second clause with a price and no
 *    hours, so it is left whole. Cutting there would strand the first tier.
 */
function splitOnSemicolons(raw: string): string[] | null {
  const parts = raw.split(/;/);
  if (parts.length < 2) return null;
  // A band is complete once it carries both a price and its hours — the same
  // test the primary rule uses, applied at semicolons instead of range starts.
  //
  // "Free" counts as a price, exactly as it does there. Aperia Mall states
  // "…; Free (6:30 PM - 9:59 PM); $2.55 per entry (10:00 PM - 11:59 PM)", and
  // without this the free band carries no "$", fails the test, and is swallowed
  // into the 10pm band — charging $2.55 for hours the mall gives away.
  const complete = (c: string) =>
    (/\$\s*\d/.test(c) || /\bfree\b/i.test(c)) && timeRangeRe().test(c);

  // A clause that names no hours and reads as a CONTINUATION belongs to the
  // band above it, not the one below. Dairy Farm Mall writes "$1.38 for 1st hr
  // (12:00 AM-5:59 PM); $0.48 per 15 mins thereafter; $2.76 per entry (6:00
  // PM-11:59 PM)": attaching that middle tier to the evening band left the
  // daytime band as "$1.38 for 1st hr" with no follow-on rate, so it stopped
  // pricing at all — a blank where there had been a correct number.
  const continues = (c: string) =>
    !timeRangeRe().test(c) && /\b(?:thereafter|subsequent|sub\.?|onwards?)\b/i.test(c);

  // Requiring EVERY clause to be complete on its own was too strict: SAFRA
  // Mount Faber writes "$2.37 for first hour; $0.60 per 15 mins thereafter
  // (6am-5.59pm); $4.09 flat rate (6pm-5.59am)", where the hours belong to the
  // second clause. That left the string unsplit and its evening flat rate
  // unreachable, so an 8pm arrival was billed the daytime tier.
  const out: string[] = [];
  let buf = "";
  for (const part of parts) {
    if (!buf && out.length && continues(part)) {
      out[out.length - 1] = `${out[out.length - 1]};${part}`;
      continue;
    }
    buf = buf ? `${buf};${part}` : part;
    if (complete(buf)) {
      out.push(buf.trim());
      buf = "";
    }
  }
  // Trailing text that never completed a band is a continuation of the last
  // one, not a band of its own — "…; $1.95 per sub.½ hr" is a second tier, and
  // cutting it off strands the first with no subsequent-block rate.
  if (buf.trim()) {
    if (!out.length) return null;
    out[out.length - 1] = `${out[out.length - 1]}; ${buf.trim()}`;
  }
  return out.length >= 2 ? out : null;
}

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
    const before = raw.slice(from, at);
    if (!closesBand(before) || bracketed(raw.slice(0, at))) continue;
    // "5am-8:30am & 12pm-2pm" is ONE band listing two ranges, not two bands.
    // Normally the "$ seen since the last cut" test keeps them together, but
    // "free" also counts as a price, so a free band with two ranges was split
    // and the second range left with no rate — Jurong Lake Gardens priced 1pm
    // as unparseable while 8am, its first range, was fine.
    //
    // Only "&"/"and" join ranges within a band. A comma is deliberately not
    // here: operators use it both ways, and guessing wrong merges two real
    // bands into one.
    if (/(?:&|\band\b)\s*$/i.test(before)) continue;

    // Plenty of operators write the RATE BEFORE THE HOURS it applies to:
    // "…; Free 5am-8:30am" (Jurong Lake Gardens), "…; $3.50 flat rate 6pm-7am"
    // (Oxley Tower). The cut lands between the two, stranding the rate on the
    // band above and handing the hours to nothing — the card then reads
    // "Applied rate: 6pm-7am" and "not computable".
    //
    // So look at the fragment since the last separator. If it states a rate and
    // names no hours of its own, it belongs to the range that follows it, and
    // the cut moves back to take it along.
    //
    // Scoped to "Free" alone at first, which was too narrow: what matters is
    // that a rate precedes its hours, not which rate it is.
    let fragStart = 0;
    // ";" or a full stop followed by space — NOT a bare ".", which would cut
    // "$3.50" in half at its own decimal point.
    for (const m of before.matchAll(/;|\.\s/g)) fragStart = (m.index ?? 0) + m[0].length;
    const frag = before.slice(fragStart);
    const fragStatesRate = /\$\s*\d/.test(frag) || /\bfree\b/i.test(frag);
    // A fragment that already names its own hours is a complete band and stays.
    const fragHasRange = timeRangeRe().test(frag);
    // And it only moves if the band above still stands up without it —
    // otherwise the one above is left with hours and nothing to charge.
    const cut =
      fragStatesRate && !fragHasRange && closesBand(before.slice(0, fragStart))
        ? from + fragStart
        : at;
    if (cut <= from) continue;
    starts.push(cut);
  }

  // Nothing cut: the hours may be bracketed rather than leading. See
  // splitOnSemicolons for why that is a separate rule and not a relaxation.
  if (starts.length === 1) {
    const bracketed = splitOnSemicolons(raw);
    if (bracketed) return bracketed;
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
 * A ceiling clause: the cap keyword, a short gap, and an amount.
 *
 * Deliberately the same shape `parseLimits` matches, because the two must
 * agree. They did not: parseLimits read `max|maximum|cap|capped` followed by an
 * amount, while withoutCaps stripped only the literal word "capped". So
 * "$8 per entry (Max: $28 per 24 hrs)" had its ceiling read as a limit AND
 * left in the text, where the per-block pattern found "$28 per 24 hrs" and took
 * it for the rate — Resorts World Sentosa quoted $28 for every evening stay
 * against a real charge of $8. Its weekday twin, "$6 per entry" with no
 * parenthetical, was right all along, which is what hid it.
 *
 * The gap forbids DIGITS as well as "." and "$", which parseLimits does not.
 * That matters here and not there: "maximum stay 3 hours, $2 per hour" would
 * otherwise be swallowed whole and the real rate deleted. Misreading a cap is
 * recoverable; deleting the rate is not.
 */
const CAP_CLAUSE =
  String.raw`(?:max(?:imum)?|cap(?:ped)?)\.?[^.$\d]{0,16}\$\s*\d+(?:\.\d{1,2})?` +
  // "$28 per 24 hrs", "$12 per day" — the period belongs to the ceiling, and
  // leaving it behind is exactly what the per-block pattern latched onto.
  String.raw`(?:\s*(?:per|/)\s*\d*\s*(?:hrs?|hours?|days?|entry))?`;

/**
 * Removes a ceiling clause before the rate patterns run. "Capped at $35 per
 * 24hrs" is a ceiling, not a rate, but it looks exactly like one — Changi
 * Airport's South car park was quoting it as $35 for two hours when the real
 * charge is 3.5 cents a minute. parseLimits reads the cap separately.
 */
function withoutCaps(s: string): string {
  return (
    s
      // The whole parenthetical, so no empty "( )" is left behind for band
      // splitting to trip over.
      .replace(new RegExp(String.raw`\s*\([^)]*` + CAP_CLAUSE + String.raw`[^)]*\)`, "gi"), " ")
      .replace(new RegExp(CAP_CLAUSE, "gi"), " ")
      .replace(/\$\s*\d+(?:\.\d{1,2})?\s*(?:max(?:imum)?|cap)\b/gi, " ")
      // The original bare-number form, kept last so anything the shapes above
      // miss still behaves as it did: "capped at 12".
      .replace(/capp?ed\s*(?:at)?\s*\$?\s*[\d.]+[^,.;]*/gi, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
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

/**
 * The parts of a notes field that apply at `minutesOfDay`.
 *
 * Notes carry two different kinds of caveat. Some are global — "Capped at $30
 * per day", "10 mins grace period" — and some describe one band, because an
 * importer had nowhere else to put it: Coliwoo's notes read "5.00pm-7.00am:
 * $1.10 per hr (Capped at $3.03)". Feeding the whole field to parseLimits
 * applied that evening cap to a daytime stay, quoting $3.03 for eight hours
 * that cost $8.80 — the same error as reading a cap from the wrong band, one
 * field over.
 *
 * So a clause that names its own hours is kept only when those hours cover the
 * arrival; a clause that names none is always kept.
 */
export function notesForTime(notes: string, minutesOfDay: number): string {
  const raw = repairEncoding(notes ?? "");
  if (!raw) return "";
  // Sentence-ish: these fields are prose, and a clause's range governs up to
  // the next full stop or semicolon.
  // Prose writes a range in ways a rate string never does — "between 10:30pm
  // AND 7:00am" — so this accepts more separators than the band splitter,
  // which must stay strict to avoid cutting bands apart on a stray word.
  const noteRangeRe = () =>
    new RegExp(`(${CLOCK})\\s*(?:-|–|to|and|until|&)\\s*(${CLOCK})`, "gi");
  const clauses = raw.split(/(?<=[.;])\s+/);
  const kept = clauses.filter((clause) => {
    const ranges = [...clause.matchAll(noteRangeRe())];
    if (!ranges.length) return true;
    return ranges.some((m) => {
      const from = parseClock(m[1]!);
      const to = parseClock(m[2]!);
      return from !== null && to !== null && covers(from, to, minutesOfDay);
    });
  });
  return kept.join(" ").trim();
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

/**
 * A ceiling stated "per 24 hrs" or "per day" belongs to the whole schedule, not
 * to the band it happens to be written beside.
 *
 * RWS weekend states "(Max: $28 per 24 hrs)" in its EVENING band, so an
 * eight-hour daytime stay priced $36 against the operator's own stated maximum.
 *
 * Scoped tightly to caps that name a whole-day period, because a cross-band cap
 * is otherwise a known way to be badly wrong: QUEEN ST's "(capped at $5.00)"
 * belongs to its 10.30pm band, and letting it reach a morning arrival quoted $5
 * for an eight-hour weekday stay. That one states no period, so this rule
 * cannot see it — which is the whole point of requiring the period.
 *
 * Across the corpus only four strings state a whole-day cap and only one prices
 * above it, so the blast radius is as small as the defect.
 *
 * Safe only because `withoutCaps` now strips these clauses before the rate
 * patterns run. Appending one to a band before that fix would have had the band
 * priced AS the cap.
 */
const DAY_CAP_CLAUSE = new RegExp(
  String.raw`(?:max(?:imum)?|cap(?:ped)?)\.?[^.$\d]{0,16}\$\s*\d+(?:\.\d{1,2})?` +
    String.raw`\s*(?:per|/)\s*(?:24\s*(?:hrs?|hours?)|day)`,
  "i",
);

function withDayCap(seg: string, whole: string): string {
  // A band that states its own ceiling keeps it; the day cap is a floor under
  // the others, not an override.
  if (parseLimits(seg).capDollars !== null) return seg;
  const m = whole.match(DAY_CAP_CLAUSE);
  // Appended rather than merged: this text is shown to the user as the applied
  // rate, and the ceiling is part of what they are being charged under.
  return m ? `${seg} (${m[0]})` : seg;
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
      if (covers(from, to, minutesOfDay)) return withDayCap(stripBandPrefix(seg), raw);
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
      if (covered) return withDayCap(stripBandPrefix(seg), raw);
    }
  }
  return raw;
}

/**
 * Why a piece of rate text has no price, when the reason is stated rather than
 * broken.
 *
 * Several stored rows are not rates at all: "7.00am-5.59pm: No Entry (Staff
 * Parking Only)", "10.30pm-7.00am: Reserved Parking only", "Available at
 * current Parliament House, The Adelphi and the road side along Empress
 * Place". The fee engine returns null for each, and the card said "not
 * computable" — which reads as a parser failure and invites someone to
 * distrust the whole row, when the operator has in fact told us something
 * useful and specific.
 *
 * Returns null for text that genuinely failed to parse. That distinction is
 * the point: "we could not read this" and "there is no parking here" deserve
 * different words, and only one of them is a bug.
 */
export function describeNonRate(text: string): string | null {
  const t = repairEncoding(text ?? "").trim();
  if (!t) return null;
  // Anything quoting money is a rate we failed to read, not a statement.
  if (/\$\s*\d/.test(t)) return null;

  if (/\b(?:carpark|car park)?\s*closed\b/i.test(t)) return "Closed at this time.";
  if (/\bno entry\b/i.test(t) || /\b(?:staff|season|reserved|tenant)\s+parking\s+only\b/i.test(t)) {
    return "No public parking at this time.";
  }
  if (/\bcoupon parking\b/i.test(t)) {
    return "URA coupon parking — buy a coupon; there is no hourly rate to compute.";
  }
  if (/\b(?:available at|nearest car ?parks?|parking is available|street parking)\b/i.test(t)) {
    return "No parking here — the rate text names where to park instead.";
  }
  return null;
}

/**
 * Rewrites "period then amount" into "amount then period", so one set of
 * patterns can read both orders.
 *
 * Galaxis states "First hour $2.16; Subsequent 30 mins $1.62 (12:00 AM - 05:59
 * PM)". A reversed FIRST clause was already handled ("1st hour @ $1.60"), but
 * only when a separator sits between the period and the price, and only for the
 * first tier — this string reverses both and separates with a bare space.
 *
 * Rewriting is preferred to a fourth pattern: the patterns are already the
 * hardest part of this file to reason about, and every new one multiplies with
 * the others. This runs before them and leaves one shape to match.
 *
 * Whitespace-only between the two, deliberately: ";" and "," are not
 * whitespace, so "…for 1st hr; $1.95 per sub. ½ hr" — where the amount belongs
 * to the NEXT tier, not this period — cannot be rewritten by accident.
 */
function normaliseReversedAmounts(s: string): string {
  const AMOUNT = String.raw`\$\s*\d+(?:\.\d{1,2})?`;
  const UNIT = String.raw`(?:hrs?|hours?|mins?|minutes?|½\s*hrs?)`;
  // The period must START its clause. Golden Landmark writes "$2.35 for 1st hr
  // $1.07 for sub 30min or part thereof", where "1st hr" is already in the
  // normal order and the "$1.07" after it belongs to the NEXT tier. Rewriting
  // there produced "$2.35 for $1.07 for 1st hr for sub 30min" and the string
  // stopped parsing altogether — a correct price turned into a blank.
  const STARTS = String.raw`(^|[;:.]\s*)`;
  return s
    .replace(
      new RegExp(
        STARTS + String.raw`((?:the\s+)?(?:1st|first)\s+(?:\d+\s+)?${UNIT})[ \t]+(${AMOUNT})`,
        "gi",
      ),
      "$1$3 for $2",
    )
    .replace(
      new RegExp(
        STARTS +
          String.raw`((?:sub(?:sequent)?\.?|next|add(?:itional|'?l)\.?)\s+(?:\d+\s+)?${UNIT})[ \t]+(${AMOUNT})`,
        "gi",
      ),
      "$1$3 per $2",
    );
}

export function parseRate(rawInput: string): ParsedRate {
  const raw = normaliseReversedAmounts(
    normaliseAmounts(withoutCaps(repairEncoding(rawInput ?? ""))),
  );
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
        // "add'l" / "additional" is the same word as "subsequent" to an
        // operator, and Waterfront Plaza writes it that way. Without it the
        // whole first-then pattern fails and the band goes unpriced.
        `[\\s\\S]*?${MONEY}${SEPS}(?:(?:the|each|next|add(?:itional|'?l)\\.?)\\s*)*(?:sub[a-z]*\\.?\\s*)?` +
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
        // "add'l" / "additional" is the same word as "subsequent" to an
        // operator, and Waterfront Plaza writes it that way. Without it the
        // whole first-then pattern fails and the band goes unpriced.
        `[\\s\\S]*?${MONEY}${SEPS}(?:(?:the|each|next|add(?:itional|'?l)\\.?)\\s*)*(?:sub[a-z]*\\.?\\s*)?` +
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

  // A FREE opening period, then a normal block rate: "1st 15 mins free, $1.00
  // per subsequent 30 mins" (Orion @ Paya Lebar, Sundays).
  //
  // Both patterns above require a "$" on each half — deliberately, because
  // dropping it is what made "30min" read as thirty dollars. A free first
  // period has no amount to carry one, so it matched neither and the whole
  // string came back unparsed. Rather than relax those, this handles the free
  // case on its own terms: the price IS zero, so it is a first-then whose
  // first half costs nothing, not a grace period bolted onto a block rate.
  //
  // Tried after both money-bearing forms so it can never steal their matches,
  // and before per-block so the trailing "$1.00 per 30 mins" is not read alone
  // — which would charge the free quarter-hour.
  const firstFreeThen = raw.match(
    new RegExp(
      `${FIRST_PERIOD}\\s*(?:is\\s*|are\\s*)?free` +
        // "add'l" / "additional" is the same word as "subsequent" to an
        // operator, and Waterfront Plaza writes it that way. Without it the
        // whole first-then pattern fails and the band goes unpriced.
        `[\\s\\S]*?${MONEY}${SEPS}(?:(?:the|each|next|add(?:itional|'?l)\\.?)\\s*)*(?:sub[a-z]*\\.?\\s*)?` +
        `(${RATE_UNIT})`,
      "i",
    ),
  );
  if (firstFreeThen) {
    const units = firstFreeThen[1] ? Number(firstFreeThen[1]) : 1;
    return {
      kind: "first-then",
      firstDollars: 0,
      firstMinutes: units * unitToMinutes(firstFreeThen[2]!),
      thenDollars: Number(firstFreeThen[3]),
      thenBlockMinutes: unitToMinutes(firstFreeThen[4]!),
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

  // "$2.00 per entry", and "$4.09 flat rate" / "$4.09 flat fee".
  //
  // SAFRA Mount Faber showed "Applied rate: $4.09 flat rate (all day)" directly
  // above "Total: not computable" — a rate the card printed in full and could
  // not price, which reads as broken rather than unknown.
  //
  // The amount must sit immediately before the word. "$5 (additional flat fee)"
  // puts prose in between, and those strings are bands of a larger schedule
  // that the patterns above already price correctly.
  const flat = raw.match(
    new RegExp(`${NUM}\\s*(?:(?:per|/)\\s*entry|flat\\s*(?:rate|fee)?\\b)`, "i"),
  );
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
  // The bare "h" of "per 1h" belongs here, NOT in the bare-number fallback at
  // the bottom of this function — that would return 1, i.e. one minute, and
  // price The Robertson House at $3.40 a minute.
  const hrs = u.match(/^(\d+)-?(?:h|hrs?|hours?|hourly)$/);
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
    // The `\.?` is the abbreviating dot in "Max." / "Cap." — without it the
    // gap below, which forbids "." so the match cannot cross a sentence
    // boundary, ends the match on the abbreviation itself. Great World City
    // priced eight hours at $13.20 against its own stated $6.00 maximum.
    /(?:max(?:imum)?|cap(?:ped)?)\.?[^.$]{0,24}\$\s*(\d+(?:\.\d{1,2})?)/i,
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
