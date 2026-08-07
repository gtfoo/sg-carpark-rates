import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRate,
  estimateMallFee,
  parseLimits,
  bandForTime,
  rateForDay,
  type ParsedRate,
} from "../src/lib/sources/mallRates";

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
  assert.deepEqual(parseLimits(techquest), { graceMinutes: 20, capDollars: 20 });

  assert.equal(parseLimits("Grace Period : 20 Minutes").graceMinutes, 20);
  assert.equal(parseLimits("first 15 min free").graceMinutes, 15);
  assert.equal(parseLimits("10 mins grace").graceMinutes, 10);
  assert.equal(parseLimits("capped at $12 per day").capDollars, 12);
  assert.equal(parseLimits("$25 max per entry").capDollars, 25);
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

test("a grace period is deducted, and a stay inside it is free", () => {
  const rate = parseRate("$2.18 for 1st hr; $1.64 per sub 30 mins");
  const limits = { graceMinutes: 20, capDollars: null };
  const cents = (d: number | null) => (d === null ? null : Math.round(d * 100) / 100);
  // 15 min, entirely within the grace.
  assert.equal(estimateMallFee(rate, 15, limits), 0);
  // 80 min bills as 60 — the first hour only, not first hour plus a block.
  assert.equal(cents(estimateMallFee(rate, 80, limits)), 2.18);
  // Without the grace the same stay tips into the next block.
  assert.equal(cents(estimateMallFee(rate, 80)), 3.82);
});

test("a daily cap stops a long stay running away", () => {
  const rate = parseRate("$2.18 for 1st hr; $1.64 per sub 30 mins");
  const limits = { graceMinutes: 20, capDollars: 20 };
  // 12 hours uncapped is far past the cap.
  assert.ok((estimateMallFee(rate, 720) ?? 0) > 20);
  assert.equal(estimateMallFee(rate, 720, limits), 20);
  // A short stay is untouched by the cap.
  assert.equal(estimateMallFee(rate, 80, limits), 2.18);
});

test("limits never rescue a rate we couldn't parse", () => {
  // "not computable" must stay that way — a grace period doesn't make an
  // unreadable rate free.
  const junk = parseRate("rates vary, ask the operator");
  assert.equal(estimateMallFee(junk, 10, { graceMinutes: 30, capDollars: 20 }), null);
  assert.equal(estimateMallFee(junk, 120, { graceMinutes: 30, capDollars: 20 }), null);
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
