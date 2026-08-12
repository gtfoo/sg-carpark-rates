import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRate,
  estimateMallFee,
  parseLimits,
  bandForTime,
  rateForDay,
  rateTextForDay,
  joinWeekdayBands,
  notesForTime,
  type ParsedRate,
} from "../src/lib/sources/mallRates";
import { classifyDay } from "../src/lib/fees";
import { toSgt, fromSgt } from "../src/lib/time";

/**
 * Every string here is REAL text from LTA / URA / an operator's site, and all
 * but a few were reported as a wrong or "not computable" fee in the app before
 * being fixed. They exist so a future tweak to the regexes can't quietly
 * reintroduce a bug we've already paid for once.
 *
 * When a new rate format breaks, add the exact string here first, then fix it.
 */

/** Fee for `minutes`, rounded like the UI does, so float noise can't fail a test. */
function fee(raw: string, minutes: number, atMinutesOfDay = 13 * 60): number | null {
  const parsed = parseRate(bandForTime(raw, atMinutesOfDay));
  const d = estimateMallFee(parsed, minutes);
  return d === null ? null : Math.round(d * 100) / 100;
}

test("per-block rates", () => {
  // 18 Robinson — "half hourly" with no separator word before the unit.
  assert.equal(fee("$3.03 half hourly", 60), 6.06);
  // CapitaGreen — "every 30 min" once produced $Infinity via a 0-minute block.
  assert.equal(fee("$3.20 every 30 min", 120), 12.8);
  assert.equal(fee("$1.20 per half hour", 120), 4.8);
  // URA's generated form.
  assert.equal(fee("$0.60 per 30 mins", 120), 2.4);
});

test("a block size is never mistaken for a price", () => {
  // The $3,600 bug: "30 Mins" read as $30/minute. Must stay per-block.
  const r = parseRate("$1.30 / 30 Mins");
  assert.equal(r.kind, "per-block");
  assert.equal(fee("$1.30 / 30 Mins", 120), 5.2);
});

test("first-then rates, including the published typos", () => {
  // Ritz-Carlton — "per sub." rather than "for sub.".
  assert.equal(fee("$3.90 for 1st hr; $1.95 per sub.½ hr", 120), 7.8);
  // Carlton Hotel — the dataset really does say "for for".
  assert.equal(fee("$3.50 for 1st hr; $1.50 for for sub. ½ hr", 120), 6.5);
  // Techquest, pasted from the operator's site via the AI extractor.
  assert.equal(fee("$2.18 for 1st hr; $1.64 per sub 30 mins", 120), 5.46);
  // One Shenton — the subsequent block is per-MINUTE, not a block unit.
  assert.equal(fee("$5.00 for 1st hr; $0.10 for next sub. min.", 60), 5);
  assert.equal(fee("$5.00 for 1st hr; $0.10 for next sub. min.", 90), 8);
});

test("a first period of more than one hour is charged as one period", () => {
  // 49 stored rates said "for 1st 2 hrs" and every one of them was quoting
  // $4.00 — the pattern below didn't allow a count after "1st", so it failed
  // and the per-block pattern read the bare "2" of "2 hrs" as $2 an hour. The
  // number looked ordinary on the card, which is why it went unnoticed.
  const bugis = "$3.30 for 1st 2 hrs; $0.65 for sub. 15 min or part thereof.";
  assert.deepEqual(parseRate(bugis), {
    kind: "first-then",
    firstDollars: 3.3,
    firstMinutes: 120,
    thenDollars: 0.65,
    thenBlockMinutes: 15,
  });
  assert.equal(fee(bugis, 120), 3.3);
  assert.equal(fee(bugis, 150), 3.3 + 2 * 0.65);
  // Square 2 — four hours, and "½ hr" for the block after it.
  assert.equal(fee("$2.40 for 1st 4hrs; $1.20 for sub. ½ hr", 120), 2.4);
  // A count of one, written out, must not change the meaning.
  assert.equal(fee("$2.40 for 1st 1hr or part thereof; $1.53 for sub. 30min", 120), 5.46);
});

test("a block of several hours is not read as an hourly rate", () => {
  // "$5.35 every 4 hrs" used to match a price of 4 and a unit of "hrs".
  assert.deepEqual(parseRate("$5.35 every 4 hrs"), {
    kind: "per-block",
    dollars: 5.35,
    blockMinutes: 240,
  });
  assert.equal(fee("$5.35 every 4 hrs", 120), 5.35);
  assert.equal(fee("$5.35 every 4 hrs", 300), 10.7);
  assert.equal(fee("$3.00 per 4 hr block.", 120), 3);
  assert.equal(fee("$4.60/4hr", 120), 4.6);
});

test("a daily cap is not mistaken for the rate", () => {
  // Changi's South car park: "Capped at $35 per 24hrs" parsed as $24 an hour
  // and quoted $48 for two hours. The real charge is 3.5 cents a minute.
  const changi = "$0.035 per min. Capped at $35 per 24hrs.";
  assert.deepEqual(parseRate(changi), { kind: "per-minute", dollars: 0.035 });
  assert.equal(fee(changi, 120), 4.2);
  // The cap itself still applies, read separately.
  assert.equal(parseLimits(changi).capDollars, 35);
});

test("'first' is the same word as '1st'", () => {
  // Katong V, One Holland Village, Siglap Centre and West Coast Plaza all
  // write it out, and all four quoted $2.00 — the "1 hour" read as $1 an hour.
  assert.equal(fee("$1.64 for the first 1 hour; $0.41 for sub. 15min", 120), 3.28);
  assert.equal(fee("$1.80 for the first hour; $0.50 for sub. 15min", 120), 3.8);
  // Lot One hyphenates the count.
  assert.equal(fee("$2.65 for 1st 2-hrs; $0.45 for sub. 15 min", 120), 2.65);
  // Suntec City puts "the" in front of the follow-on period.
  assert.equal(fee("$2.60 for 1st hr; $1.30 for the next 3 hrs", 120), 3.9);
});

test("an amount written after its period still reads", () => {
  // Clarke Quay and Jurong Point put the period first and the amount after it.
  assert.equal(fee("1st hour @ $1.60, $0.55 for subsequent 15 min", 120), 3.8);
  assert.equal(fee("1st hr at $1.50; $0.75 every sub. 30min", 120), 3);
  assert.equal(fee("First 1 hour - $1.20; $0.40 for sub. 15min", 120), 2.8);
  // Funan writes the block first. The leading "Every" is what makes this safe.
  assert.equal(fee("Every 15min of part thereof at $0.65", 120), 5.2);
  assert.equal(fee("$0.60 per 30 min at the barrier", 120), 2.4);
});

test("a trailing amount is not read as a whole rate on its own", () => {
  // Without the "every/each/per" guard this reads Tekka Place as a flat $1.20
  // an hour and loses the first-hour charge — a plausible wrong number, which
  // is worse than the blank it gives.
  assert.equal(fee("$1.80 for 1st hr, sub 30min at $1.20.", 120), null);
});

test("a GST note between an amount and its unit is ignored", () => {
  // Chinatown Point: the figure already includes the tax, so the note carries
  // no arithmetic — it just broke the adjacency the patterns rely on.
  assert.equal(fee("$1.96 (with 9% GST) for every 30min or part thereof.", 120), 7.84);
});

test("'1/2 hr' is a half hour, not a two-hour block", () => {
  // The Metropolis writes the fraction with a slash. Without the explicit
  // branch, the "2" of "1/2" matched the multi-hour form and a $1.25 half-hour
  // rate priced as $1.25 for two hours.
  assert.deepEqual(parseRate("$1.25 per 1/2 hr"), {
    kind: "per-block",
    dollars: 1.25,
    blockMinutes: 30,
  });
  assert.equal(fee("$2.50 for 1st hr, sub $1.25 per 1/2 hr", 120), 5);
  // 51 Cuppage Road compresses "subsequent" to "subq" on top of the slash.
  assert.equal(fee("$2.00 for 1st hr, $1.50 for next subq 1/2hr", 90), 3.5);
});

test("a caveat in the notes obeys its own hours", () => {
  // Coliwoo's evening rate was filed in the notes by an importer with nowhere
  // else to put it, cap included. Read whole, that $3.03 capped a daytime stay
  // costing $8.80. A scan found 204 rates with band-limited caps and 6 with
  // caps in the notes, so this is the same fault one field over.
  const coliwoo =
    "Weekday evening: 5.00pm-7.00am: $1.10 per hr (Capped at $3.03). " +
    "From LTA OneMotoring — verify before relying on it.";
  assert.equal(parseLimits(notesForTime(coliwoo, 13 * 60)).capDollars, null);
  assert.equal(parseLimits(notesForTime(coliwoo, 19 * 60)).capDollars, 3.03);

  // Jurong Lake Gardens states an overnight cap the same way.
  const jurong =
    "AI-retrieved — verify. Overnight parking between 10:30pm and 7:00am capped at $5.00.";
  assert.equal(parseLimits(notesForTime(jurong, 13 * 60)).capDollars, null);
  assert.equal(parseLimits(notesForTime(jurong, 23 * 60)).capDollars, 5);

  // A caveat with no hours is global and must survive at every time.
  const gardens = "Capped at $30 per day. Same rate applies at Bay East.";
  for (const h of [9, 13, 19, 23]) {
    assert.equal(parseLimits(notesForTime(gardens, h * 60)).capDollars, 30, `${h}:00`);
  }
  // As must a grace period, which is never time-scoped in practice.
  assert.equal(parseLimits(notesForTime("10 mins grace period.", 13 * 60)).graceMinutes, 10);
  assert.equal(notesForTime("", 780), "");
});

test("a cap belongs to the band that states it", () => {
  // Queen St Off St: $1.40 per half hour by day, and a $5 cap that applies
  // only between 10.30pm and 7am. Limits used to be read from the band at
  // MIDNIGHT regardless of arrival, so an eight-hour weekday stay from 8.41am
  // was quoted $5.00 instead of $22.40 — underpriced by 4x, in the app's most
  // confident voice. Harmless until URA rates carried per-band caps.
  const queen =
    "07.00 AM-05.00 PM: $1.40 per 30 mins; 05.00 PM-10.30 PM: $0.75 per 30 mins; " +
    "10.30 PM-07.00 AM: $0.60 per 30 mins (capped at $5.00)";
  const at = (mod: number, minutes: number) =>
    estimateMallFee(
      parseRate(bandForTime(queen, mod)),
      minutes,
      parseLimits(bandForTime(queen, mod)),
    );

  // Daytime: no cap in that band, so the full stay is charged.
  assert.equal(at(8 * 60 + 41, 480), 22.4);
  assert.equal(at(13 * 60, 120), 5.6);
  // Overnight: the cap is real and must still bite.
  assert.equal(at(23 * 60, 480), 5);
  // Evening band has its own price and no cap.
  assert.equal(at(18 * 60, 120), 3);
});

test("a hyphenated multi-hour block prices per block, not per minute", () => {
  // Palais Renaissance: "$3.80 per 4-hourly". Teaching BLOCK_UNIT the hyphen
  // without teaching unitToMinutes read it as four MINUTES — thirty blocks in
  // two hours, $114. The implausibility sweep caught it; this pins it.
  assert.deepEqual(parseRate("$3.80 per 4-hourly"), {
    kind: "per-block",
    dollars: 3.8,
    blockMinutes: 240,
  });
  assert.equal(fee("$3.80 per 4-hourly", 120), 3.8);
  assert.equal(fee("$3.80 per 4-hourly", 300), 7.6);
});

test("'subsequent' survives being misspelled", () => {
  // The Heeren writes "subseqent"; others use "subq" or "sub.". Matching the
  // stem rather than a list of spellings covers all of them.
  assert.equal(fee("$5 for 1st 3 hrs and $1.50 for subseqent ½ hr", 120), 5);
  assert.equal(fee("$5 for 1st 3 hrs; $1.50 for subsequent ½ hr", 240), 8);
  assert.equal(fee("$2.00 for 1st hr, $1.50 for next subq 1/2hr", 90), 3.5);
});

test("an amount in cents is read as money", () => {
  // East Coast Park writes small amounts as "60¢".
  assert.equal(fee("60¢ per 30min", 120), 2.4);
  assert.equal(fee("5¢ per min", 60), 3);
});

test("a mistyped 'same as' still defers to the other day", () => {
  // Republic Plaza's row reads "Same s Saturday"; missing it left Sunday
  // unpriced when it should simply have billed as Saturday.
  assert.equal(parseRate("Same s Saturday").kind, "same-as-other");
  assert.equal(parseRate("Same as Saturday").kind, "same-as-other");
  assert.equal(parseRate("Charges same as wkdays").kind, "same-as-other");
  // Not a deferral — an ordinary rate that happens to contain the word.
  assert.equal(parseRate("$2 per hr, same rate all week").kind, "per-block");
});

test("the follow-on rate is never read out of a duration", () => {
  // Tekka Place and Tanglin Shopping Centre both put the amount last. Allowing
  // a bare number there let "30min" become $30 a minute — a $1,800 two-hour
  // quote. Unpriceable is the honest answer for these.
  assert.equal(fee("$1.80 for 1st hr, sub 30min at $1.20.", 120), null);
  assert.equal(fee("$3.50 for 1st hr; $1.75 for next sub.sequent 30min", 120), null);
  // But an amount that trails "sub." legitimately still parses.
  assert.equal(fee("$3 for 1st hour; sub. $2/hour", 120), 5);
});

test("the follow-on rate needs no 'subsequent' to be found", () => {
  // Marina Square and Mandarin Oriental write it straight after a comma.
  assert.equal(fee("$3.27 for 1st 2hrs; $1.64 per ½ hr for sub. ½ hr", 120), 3.27);
  assert.equal(fee("$2.44 for 1st 2 hrs, $1.22/hr for next 2 hrs", 120), 2.44);
  assert.equal(fee("$1.35 for 1st hr; $0.70 every 30min or part thereof.", 120), 2.75);
});

test("per-minute rates", () => {
  // IKEA Alexandra — "minute" spelled out defeated a \bmins?\b pattern.
  assert.equal(fee("$0.06 per minute", 120), 7.2);
  assert.equal(fee("$0.018 /min", 120), 2.16);
});

test("flat, free and absent rates", () => {
  assert.equal(fee("$2.00 per entry", 120), 2);
  assert.equal(fee("Free", 120), 0);
  assert.equal(fee("Daily free: 7am-7pm", 120), 0);
  for (const empty of ["", "-", "na", "NA"]) {
    assert.equal(parseRate(empty).kind, "none", `"${empty}" should parse as none`);
  }
  assert.equal(parseRate("Same as Saturday").kind, "same-as-other");
});

test("an unusable rate is null, never Infinity or NaN", () => {
  for (const raw of ["ask the operator", "$", "rates vary"]) {
    const d = estimateMallFee(parseRate(raw), 120);
    assert.ok(
      d === null || Number.isFinite(d),
      `"${raw}" produced ${d}, which the UI would render as a bogus price`,
    );
  }
});

test("time bands pick the rate for the arrival hour", () => {
  // LASALLE College of the Arts: billed per-minute by day, flat by evening.
  // Before bandForTime() the evening band was ignored entirely.
  const LASALLE =
    "7am-5pm & 11pm-7am: $1.50 for 1st 30 mins, $0.05/min; 5pm-11pm: $3.00 per entry";
  assert.equal(fee(LASALLE, 120, 10 * 60), 6, "10am uses the daytime band");
  assert.equal(fee(LASALLE, 120, 18 * 60), 3, "6pm uses the evening band");
  assert.equal(fee(LASALLE, 120, 22 * 60), 3, "10pm still evening");
  // 11pm-7am wraps past midnight — both ends must resolve to the day band.
  assert.equal(fee(LASALLE, 120, 23 * 60 + 30), 6, "11:30pm wraps to the night band");
  assert.equal(fee(LASALLE, 120, 3 * 60), 6, "3am wraps to the night band");
});

test("a doubled decimal in the source data doesn't inflate the price", () => {
  // LTA really does publish "$3.27.00". The amount pattern used to match the
  // tail — $27.00 — and 313@Somerset quoted $30.28 for two hours.
  const raw =
    "Friday to Sunday and Public Holiday 7.00am-7.00am: $3.27.00 for 1st hr; $1.64 for sub. 30min";
  const r = parseRate(bandForTime(raw, 13 * 60));
  assert.equal(r.kind, "first-then");
  assert.equal((r as { firstDollars: number }).firstDollars, 3.27);
  const d = estimateMallFee(r, 120);
  assert.equal(d === null ? null : Math.round(d * 100) / 100, 6.55);
});

test("a semicolon inside one band does not split the rate", () => {
  // LTA writes a band's tiers with a semicolon. Treating it as a band
  // separator stranded "$3.90 for 1st hr" with no subsequent price, which
  // parses as nothing — these all read "not computable" in the app.
  for (const [raw, expected] of [
    ["7.00am-5.59pm: $3.90 for 1st hr; $1.95 per sub.½ hr", 7.8],
    ["6.00am-6.00pm: $3.80 for 1st hr; $2.50 for sub. 30min", 8.8],
    ["Monday to Thursday 7.00am-7.00am: $3.05 for 1st hr; $1.31 for sub. 30min", 5.67],
  ] as const) {
    const d = estimateMallFee(parseRate(bandForTime(raw, 13 * 60)), 120);
    assert.equal(
      d === null ? null : Math.round(d * 100) / 100,
      expected,
      `"${raw.slice(0, 46)}" should price, not fail`,
    );
  }
});

test("a genuine second band is still split off", () => {
  // The semicolon here DOES start a new band, because a clock range follows.
  const ion =
    "8.00am-5.59pm: $2.62 for 1st hr; $1.91 for sub. 30min; 6pm-11.59pm: $3.82 per entry";
  const day = estimateMallFee(parseRate(bandForTime(ion, 13 * 60)), 120);
  assert.equal(day === null ? null : Math.round(day * 100) / 100, 6.44, "1pm: first-then");
  assert.equal(estimateMallFee(parseRate(bandForTime(ion, 19 * 60)), 120), 3.82, "7pm: per entry");
});

test("rateTextForDay falls back exactly as the parsed version does", () => {
  const r = { name: "x", category: "", weekday: "WK", saturday: "", sundayPh: "" };
  assert.equal(rateTextForDay(r, "weekday"), "WK");
  // LTA publishes no Friday column, so Friday reads the weekday one.
  assert.equal(rateTextForDay(r, "friday"), "WK");
  assert.equal(rateTextForDay(r, "saturday"), "WK");
  assert.equal(rateTextForDay({ ...r, saturday: "SAT" }, "saturday"), "SAT");
  assert.equal(rateTextForDay({ ...r, saturday: "SAT" }, "sunday-ph"), "WK");
  assert.equal(
    rateTextForDay({ ...r, saturday: "SAT", sundayPh: "Same as Saturday" }, "sunday-ph"),
    "SAT",
  );
  // "-" and "NA" are how the dataset writes an empty column.
  assert.equal(rateTextForDay({ ...r, saturday: "-" }, "saturday"), "WK");
  assert.equal(rateTextForDay({ ...r, saturday: "NA" }, "saturday"), "WK");
});

test("LTA's two weekday columns become one banded string", () => {
  // 301 of 357 rows carry a second weekday column and it was never read, so
  // every one of them quoted the daytime rate at midnight.
  assert.equal(
    joinWeekdayBands("7am-6pm: $1.20 for 1st hr", "6pm-3.30am: $3 per entry."),
    "7am-6pm: $1.20 for 1st hr; 6pm-3.30am: $3 per entry.",
  );
  // About half the rows just repeat the first column; appending those would
  // invent a second band that says the same thing.
  assert.equal(joinWeekdayBands("$1.80 for 1st hr", "$1.80 for 1st hr"), "$1.80 for 1st hr");
  // Causeway Point's two columns differ only by a stray space.
  assert.equal(
    joinWeekdayBands("$1.20 for sub.½ hr", "$1.20 for sub. ½ hr"),
    "$1.20 for sub.½ hr",
  );
  assert.equal(joinWeekdayBands("$2 per hr", "-"), "$2 per hr");
  assert.equal(joinWeekdayBands("", "Aft 5pm: $2 per entry"), "Aft 5pm: $2 per entry");
});

test("an open-ended evening band runs until the next band opens", () => {
  // Balestier Point, as published: the evening column names no closing time.
  const r = "8am-10pm: $1.20 per hr; Aft 10pm: $2 per entry";
  assert.equal(bandForTime(r, 13 * 60), "$1.20 per hr");
  assert.equal(bandForTime(r, 23 * 60), "$2 per entry");
  // Wraps past midnight, and hands back to the daytime band at 8am.
  assert.equal(bandForTime(r, 2 * 60), "$2 per entry");
  assert.equal(bandForTime(r, 9 * 60), "$1.20 per hr");
  assert.equal(fee(bandForTime(r, 23 * 60), 120), 2);
  assert.equal(fee(bandForTime(r, 13 * 60), 120), 2.4);
});

test("'after' in a rate's wording is not mistaken for a band", () => {
  // "after 4 hrs" is a duration, not a clock time, so this stays one band.
  const r = "$2.44 for 1st 2 hrs, $1.43 per 30 mins after 4 hrs";
  assert.equal(bandForTime(r, 23 * 60), r);
});

test("a band boundary needs no semicolon", () => {
  // Bras Basah Complex separates its two bands with a full stop. Splitting on
  // ";" alone left the second unreachable, so every afternoon arrival was
  // priced at the morning rate — $4.80 against a real $5.60. 60 stored rates
  // had at least one band that could never be selected.
  const bras = "7.00am-10.00am: $1.20 per ½ hr. 10.00am-10.30pm: $1.40 per ½ hr.";
  assert.equal(bandForTime(bras, 9 * 60), "$1.20 per ½ hr");
  assert.equal(bandForTime(bras, 13 * 60), "$1.40 per ½ hr");
  assert.equal(fee(bandForTime(bras, 13 * 60), 120), 5.6);
  // A colon-separated pair, and a band that opens with a day label.
  assert.equal(
    bandForTime("7.00am-11.00am: $1.31 per 30 min. 11.00am-5.00pm: $1.53 per 30 min.", 13 * 60),
    "$1.53 per 30 min",
  );
  // A single-band string is handed back untouched — there's nothing to choose
  // between, and the leading clock can't be read as money now that amounts
  // require a "$".
  assert.equal(
    bandForTime("Mon-Thu: 7.00am-5.00pm: $3.27 for 1st 2hrs; $1.64 per ½ hr", 13 * 60),
    "Mon-Thu: 7.00am-5.00pm: $3.27 for 1st 2hrs; $1.64 per ½ hr",
  );
  assert.equal(fee("Mon-Thu: 7.00am-5.00pm: $3.27 for 1st 2hrs; $1.64 per ½ hr", 120), 3.27);
});

test("a band is only cut once the one before it is complete", () => {
  // Both a range AND a price are needed before a new band can start.
  // Without the price test this splits one band's two ranges apart.
  assert.equal(
    bandForTime("7am-5pm & 11pm-7am: $1.50 per 30 min; 5pm-11pm: $3.00 per entry", 13 * 60),
    "$1.50 per 30 min",
  );
  // Without the range test, "free" cuts before the hours it applies to.
  assert.equal(bandForTime("Daily free: 7.00am-7.00pm", 13 * 60), "Daily free: 7.00am-7.00pm");
  assert.equal(fee("Daily free: 7.00am-7.00pm", 120), 0);
  // "after 5.00pm" is the only clock in the string — not a second band.
  assert.equal(fee(bandForTime("$4.00 per entry after 5.00pm", 19 * 60), 120), 4);
  // A band priced only as "Free" still closes, or the free hours get charged.
  const arc = "7.00am-10.00pm: Free; 10.00pm-7.00am: $2.70/hr or part thereof";
  assert.equal(fee(bandForTime(arc, 9 * 60), 120), 0);
  assert.equal(fee(bandForTime(arc, 23 * 60), 120), 5.4);
});

test("a bracketed clock range is an aside, not a new band", () => {
  // Jurong Lake Gardens and Marina South Pier both put the hours in brackets
  // after the amount. Cutting there strands the amount with no rate.
  // The bracketed hours stay with their amount, so 9am is priced at $0.60 per
  // half hour rather than being handed to the "Free" clause that follows.
  assert.equal(fee(bandForTime("$0.60 per 30 mins (8:30am-12pm, 2pm-5am); Free 5am-8:30am", 9 * 60), 120), 2.4);
  assert.equal(fee(bandForTime("$0.60 per 30 mins (8:30am-12pm, 2pm-5am)", 9 * 60), 120), 2.4);
  // Marina South Pier's trailing bracket must not become a band of its own —
  // the string stays whole. (It still doesn't price: "per add'l hr" is a form
  // the parser doesn't know, which is a separate gap.)
  const pier = "$2.40 for 1st 2 hrs, $3.60 per add'l hr (7:00 AM-10:30 PM)";
  assert.equal(bandForTime(pier, 13 * 60), pier);
});

test("bandForTime leaves single-band strings alone", () => {
  // A semicolon alone must not trigger band selection — this string has two
  // clauses but no time ranges, and splitting it would lose the "1st hr" half.
  const techquest = "$2.18 for 1st hr; $1.64 per sub 30 mins";
  assert.equal(bandForTime(techquest, 13 * 60), techquest);
  assert.equal(bandForTime("$1.20 per half hour", 13 * 60), "$1.20 per half hour");
});

test("grace periods and daily caps are read out of the notes", () => {
  // Techquest, exactly as the AI extractor filed it.
  const techquest = "Grace period: 20 mins. Whole day max cap: $20.00. Rates inclusive of GST.";
  assert.deepEqual(parseLimits(techquest), {
    graceMinutes: 20,
    graceMode: "threshold",
    capDollars: 20,
  });

  assert.equal(parseLimits("Grace Period : 20 Minutes").graceMinutes, 20);
  assert.equal(parseLimits("10 mins grace").graceMinutes, 10);
  assert.equal(parseLimits("10-minute grace period").graceMinutes, 10);
  assert.equal(parseLimits("capped at $12 per day").capDollars, 12);
  assert.equal(parseLimits("$25 max per entry").capDollars, 25);

  // The two conventions bill differently, so they're told apart.
  assert.equal(parseLimits("Grace period: 20 mins").graceMode, "threshold");
  assert.equal(parseLimits("first 15 min free").graceMode, "deduct");
  assert.equal(parseLimits("first 15 min free").graceMinutes, 15);
});

test("limit parsing does not invent rules that aren't there", () => {
  // Each of these contains a number and a dollar sign near a suggestive word.
  for (const text of [
    "Free parking with $20 min spend",
    "Maximum stay 2 hours",
    "$1.20 per half hour",
    "AI-retrieved — verify before relying on it.",
    "",
  ]) {
    const l = parseLimits(text);
    assert.equal(l.capDollars, null, `"${text}" should not yield a cap`);
    assert.equal(l.graceMinutes, null, `"${text}" should not yield a grace`);
  }
});

test("a stay inside the grace is free under either convention", () => {
  const rate = parseRate("$0.65 per 15 mins");
  const threshold = { graceMinutes: 10, graceMode: "threshold" as const, capDollars: null };
  const deduct = { graceMinutes: 10, graceMode: "deduct" as const, capDollars: null };
  assert.equal(estimateMallFee(rate, 10, threshold), 0);
  assert.equal(estimateMallFee(rate, 10, deduct), 0);
});

test("a grace period charges the whole stay once it's passed", () => {
  // Changi: "full parking charges will apply for vehicles that stay beyond 10
  // minutes from the time of entry" — 20 minutes is two blocks, not one.
  const rate = parseRate("$0.65 per 15 mins");
  const limits = { graceMinutes: 10, graceMode: "threshold" as const, capDollars: null };
  const cents = (d: number | null) => (d === null ? null : Math.round(d * 100) / 100);
  assert.equal(cents(estimateMallFee(rate, 20, limits)), 1.3);
  assert.equal(cents(estimateMallFee(rate, 60, limits)), 2.6);
  // Deducting instead would bill 10 minutes — one block — and undercharge.
  assert.equal(
    cents(estimateMallFee(rate, 20, { ...limits, graceMode: "deduct" })),
    0.65,
  );
});

test("'first N minutes free' comes off the bill", () => {
  const rate = parseRate("$2.18 for 1st hr; $1.64 per sub 30 mins");
  const limits = { graceMinutes: 20, graceMode: "deduct" as const, capDollars: null };
  const cents = (d: number | null) => (d === null ? null : Math.round(d * 100) / 100);
  // 80 min bills as 60 — the first hour only, not first hour plus a block.
  assert.equal(cents(estimateMallFee(rate, 80, limits)), 2.18);
  // Without it the same stay tips into the next block.
  assert.equal(cents(estimateMallFee(rate, 80)), 3.82);
});

test("a daily cap stops a long stay running away", () => {
  const rate = parseRate("$2.18 for 1st hr; $1.64 per sub 30 mins");
  const limits = { graceMinutes: 20, graceMode: "deduct" as const, capDollars: 20 };
  const cents = (d: number | null) => (d === null ? null : Math.round(d * 100) / 100);
  // 12 hours uncapped is far past the cap.
  assert.ok((estimateMallFee(rate, 720) ?? 0) > 20);
  assert.equal(estimateMallFee(rate, 720, limits), 20);
  // A short stay is untouched by the cap.
  assert.equal(cents(estimateMallFee(rate, 80, limits)), 2.18);
});

test("limits never rescue a rate we couldn't parse", () => {
  // "not computable" must stay that way — a grace period doesn't make an
  // unreadable rate free.
  const junk = parseRate("rates vary, ask the operator");
  const limits = { graceMinutes: 30, graceMode: "threshold" as const, capDollars: 20 };
  assert.equal(estimateMallFee(junk, 10, limits), null);
  assert.equal(estimateMallFee(junk, 120, limits), null);
});

test("Friday uses its own rate only when the operator sets one", () => {
  const none: ParsedRate = { kind: "none" };
  const weekday = parseRate("$6.50 for 1st hr, $1.10 per sub half hr");
  const weekend = parseRate("$9.70 for 1st hr, $1.10 per sub half hr");
  const base = { name: "x", category: "", weekday, saturday: weekend, sundayPh: weekend };

  // ION Orchard, 313@Somerset, Jem, Marina Square and RWS bill Fri with the
  // weekend; most car parks don't, and those must be unaffected.
  assert.deepEqual(rateForDay({ ...base, friday: weekend }, "friday"), weekend);
  assert.deepEqual(rateForDay(base, "friday"), weekday, "no friday column -> weekday");
  assert.deepEqual(rateForDay({ ...base, friday: none }, "friday"), weekday, "empty -> weekday");

  // The other days are untouched by the new column.
  assert.deepEqual(rateForDay({ ...base, friday: weekend }, "weekday"), weekday);
  assert.deepEqual(rateForDay({ ...base, friday: weekend }, "saturday"), weekend);
});

test("classifyDay separates Friday, and a holiday still wins", () => {
  // Aug 2026: 7th Fri, 8th Sat, 9th Sun, 10th Mon, 11th Tue.
  const day = (d: number, holiday = false) =>
    classifyDay(toSgt(fromSgt(2026, 8, d, 12)), holiday);
  assert.equal(day(7), "friday");
  assert.equal(day(8), "saturday");
  assert.equal(day(9), "sunday-ph");
  assert.equal(day(10), "weekday");
  assert.equal(day(11), "weekday");
  // National Day observed on Mon 10 Aug — a holiday outranks the weekday.
  assert.equal(day(10, true), "sunday-ph");
  // A public holiday that lands on a Friday bills as Sunday/PH, not Friday.
  assert.equal(day(7, true), "sunday-ph");
});

test("rateForDay falls back the way the datasets expect", () => {
  const none: ParsedRate = { kind: "none" };
  const weekday = parseRate("$1.00 per hour");
  const saturday = parseRate("$2.00 per hour");
  const base = { name: "x", category: "", weekday, saturday, sundayPh: none };

  // A blank Saturday column means "same as weekday", not "free".
  assert.deepEqual(rateForDay({ ...base, saturday: none }, "saturday"), weekday);
  // "Same as Saturday" is a literal value in the LTA data.
  assert.deepEqual(
    rateForDay({ ...base, sundayPh: { kind: "same-as-other" } }, "sunday-ph"),
    saturday,
  );
});
