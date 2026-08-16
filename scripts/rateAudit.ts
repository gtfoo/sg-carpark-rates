/**
 * Sweeps every stored rate across a GRID of arrival times and durations, and
 * reports the shapes that mean "wrong" rather than "unparseable".
 *
 *   npx tsx scripts/rateAudit.ts
 *   npx tsx scripts/rateAudit.ts --list 20
 *
 * `rateHealth.ts` already asks whether each string prices at all. It prices
 * every string ONCE — two hours from 1pm — and flags a fee only when it is
 * absurdly HIGH. Both limits are deliberate and both have now been paid for:
 *
 * - Every mispricing found in Aug 2026 made a fee too LOW, not too high.
 *   QUEEN ST OFF ST quoted $5 for an eight-hour weekday stay because a cap
 *   belonging to a night band was applied to a morning arrival. $5 is a
 *   perfectly ordinary number; nothing above a threshold could ever see it.
 * - It was wrong at 8:41am for 8 hours and right at 1pm for 2 hours, so the
 *   single probe could not have caught it in principle.
 *
 * So this asks different questions, all of them threshold-free:
 *
 *   monotonic     a longer stay must never cost LESS than a shorter one
 *   cap-early     a cap that already binds within an hour usually belongs to
 *                 a different band
 *   partial       prices at some arrival hours but not others
 *
 * A rate that fails none of these can still be out of date — that is
 * `rateStaleness.ts`, and no amount of arithmetic can answer it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRate,
  estimateMallFee,
  parseLimits,
  bandForTime,
} from "../src/lib/sources/mallRates";
import type { CorpusEntry } from "./rateHealth";

/** 8am catches the morning arrival the 1pm probe cannot; 1am catches night bands. */
const HOURS = [8, 13, 20, 1];
const DURATIONS = [60, 120, 240, 480];

export interface Finding {
  entry: CorpusEntry;
  kind: "monotonic" | "cap-early" | "partial";
  detail: string;
}

function price(e: CorpusEntry, hour: number, minutes: number): number | null {
  const band = bandForTime(e.rate, hour * 60);
  return estimateMallFee(parseRate(band), minutes, parseLimits(`${band} ${e.notes}`));
}

export function audit(corpus: CorpusEntry[]): Finding[] {
  const findings: Finding[] = [];

  for (const e of corpus) {
    const grid = HOURS.map((h) => ({ h, fees: DURATIONS.map((d) => price(e, h, d)) }));
    const anyPriced = grid.some((r) => r.fees.some((f) => f !== null));
    if (!anyPriced) continue; // uniformly unpriceable is rateHealth's business

    // Prices at some arrival hours and not others. A rate that genuinely has
    // no night band is normal, so this is reported, not treated as fatal.
    const dead = grid.filter((r) => r.fees.every((f) => f === null));
    if (dead.length && dead.length < grid.length) {
      findings.push({
        entry: e,
        kind: "partial",
        detail: `no price at ${dead.map((d) => `${d.h}:00`).join(", ")}`,
      });
    }

    for (const { h, fees } of grid) {
      const known = fees.map((f, i) => ({ f, mins: DURATIONS[i]! })).filter((x) => x.f !== null) as {
        f: number;
        mins: number;
      }[];
      if (known.length < 2) continue;

      // A longer stay costing less is impossible under every rate shape there
      // is. A cap makes fees EQUAL, never smaller.
      for (let i = 1; i < known.length; i++) {
        const prev = known[i - 1]!;
        const cur = known[i]!;
        if (cur.f < prev.f - 1e-9) {
          findings.push({
            entry: e,
            kind: "monotonic",
            detail: `${h}:00 — ${cur.mins}min costs $${cur.f.toFixed(2)} but ${prev.mins}min costs $${prev.f.toFixed(2)}`,
          });
          break;
        }
      }

      // Flat across 1h → 8h means something is capping from the very first
      // hour. Real caps bind after a long stay; one that binds immediately is
      // usually a cap lifted from a band the driver never entered — which is
      // exactly the QUEEN ST shape. Rates that are flat BY DESIGN (per entry,
      // free) are excluded, since for them flatness is the correct answer.
      const parsed = parseRate(bandForTime(e.rate, h * 60));
      const kind = parsed?.kind;
      const flat = known.every((x) => Math.abs(x.f - known[0]!.f) < 1e-9);
      let meteredKind = kind === "per-block" || kind === "per-minute" || kind === "first-then";
      // "$3 for 1st 8hrs; $1 for sub. hr" (Sentosa) is flat across every probe
      // BECAUSE the first period swallows them all — the correct answer, not a
      // cap misfiring. Only flag a first-then whose first period ends inside
      // the range we probe.
      if (
        parsed?.kind === "first-then" &&
        parsed.firstMinutes >= Math.max(...DURATIONS)
      ) {
        meteredKind = false;
      }
      if (flat && meteredKind && known[0]!.f > 0 && known.length === DURATIONS.length) {
        findings.push({
          entry: e,
          kind: "cap-early",
          detail: `${h}:00 — $${known[0]!.f.toFixed(2)} for 1h and for 8h alike (${kind})`,
        });
      }
    }
  }
  return findings;
}

/**
 * Cap-specific sweep. Every mispricing found this month involved a cap, and
 * each of these asks a question with an objectively right answer — no
 * thresholds, no judgement about what a car park "should" charge.
 *
 *   declared-not-parsed  the band says "max $X" and the parser found no cap
 *   leaked-into-band     the parser found a cap the band text does not state
 *   over-declared-cap    a fee exceeds a cap the string itself declares
 *   cap-below-entry      the cap is less than the first hour, which is absurd
 *
 * `leaked-into-band` is the QUEEN ST shape exactly: a cap written in the night
 * band reaching a morning arrival, quoting $5 for a stay that costs $22.40.
 */
const CAP_TEXT = /(?:max|cap(?:ped)?)[^$]{0,24}\$\s*(\d+(?:\.\d+)?)/gi;

function declaredCaps(text: string): number[] {
  return [...text.matchAll(CAP_TEXT)].map((m) => Number(m[1]));
}

export interface CapFinding {
  entry: CorpusEntry;
  kind: "declared-not-parsed" | "leaked-into-band" | "over-declared-cap" | "cap-below-entry";
  detail: string;
}

export function auditCaps(corpus: CorpusEntry[]): CapFinding[] {
  const out: CapFinding[] = [];
  for (const e of corpus) {
    const wholeCaps = declaredCaps(e.rate);

    for (const h of HOURS) {
      const band = bandForTime(e.rate, h * 60);
      const parsed = parseRate(band);
      if (!parsed || parsed.kind === "unparsed") continue;

      const bandCaps = declaredCaps(band);
      // parseLimits sees the notes too, and a cap stated there is legitimate.
      const capFromBand = parseLimits(band)?.capDollars ?? null;

      if (bandCaps.length && capFromBand === null) {
        out.push({
          entry: e,
          kind: "declared-not-parsed",
          detail: `${h}:00 — band states max $${bandCaps[0]} but no cap was parsed`,
        });
      }
      if (!bandCaps.length && capFromBand !== null) {
        out.push({
          entry: e,
          kind: "leaked-into-band",
          detail: `${h}:00 — cap $${capFromBand} applied, band text states none`,
        });
      }

      const fees = DURATIONS.map((d) => price(e, h, d)).filter((f): f is number => f !== null);
      if (!fees.length) continue;
      const worst = Math.max(...fees);
      // Only against a cap stated in THIS band. Comparing to every cap in the
      // string reproduces the QUEEN ST bug inside the auditor: a $5 cap in the
      // night band does not bind a morning arrival, and flagging that as a
      // violation would push someone to "fix" correct behaviour.
      const lowestDeclared = bandCaps.length ? Math.min(...bandCaps) : null;
      if (lowestDeclared !== null && worst > lowestDeclared + 1e-9) {
        out.push({
          entry: e,
          kind: "over-declared-cap",
          detail: `${h}:00 — prices up to $${worst.toFixed(2)} against a declared max of $${lowestDeclared}`,
        });
      }
      const firstHour = price(e, h, 60);
      if (capFromBand !== null && firstHour !== null && capFromBand < firstHour - 1e-9) {
        out.push({
          entry: e,
          kind: "cap-below-entry",
          detail: `${h}:00 — cap $${capFromBand} is below the first hour at $${firstHour.toFixed(2)}`,
        });
      }
    }
  }
  return out;
}

/**
 * Every stored override, read from the database rather than the fixture.
 *
 * `tests/fixtures/rate-corpus.json` is a committed snapshot refreshed by hand
 * with `npm run export-rate-corpus`. On 2026-08-16 it held 684 strings while
 * production held 838 — so roughly 150 rates, including every one retrieved by
 * the bulk lookup, were gated by nothing while the gate still reported green.
 * A check that silently stops covering new data is worse than no check.
 */
async function corpusFromDb(): Promise<CorpusEntry[]> {
  const { listOverrides } = await import("../src/lib/store/rates");
  const out: CorpusEntry[] = [];
  for (const o of listOverrides()) {
    const name = o.displayName ?? o.matchValue;
    for (const rate of [o.weekdayRate, o.fridayRate, o.saturdayRate, o.sundayPhRate]) {
      if (rate) out.push({ name, rate, notes: o.notes ?? "" });
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const listIdx = argv.indexOf("--list");
  const listN = listIdx >= 0 ? Number(argv[listIdx + 1] ?? 10) : 10;
  const fromDb = argv.includes("--from-db");
  // Exit non-zero when a finding is ALWAYS a bug, never a judgement call:
  // a longer stay costing less, or a cap reaching a band that never stated
  // one. Prose that cannot be priced is neither, so it does not fail a run.
  const ci = argv.includes("--ci");

  const corpus = fromDb
    ? await corpusFromDb()
    : (JSON.parse(
        readFileSync(join(process.cwd(), "tests", "fixtures", "rate-corpus.json"), "utf8"),
      ) as CorpusEntry[]);
  if (fromDb) console.log(`(read ${corpus.length} day-columns from the database)`);

  const findings = audit(corpus);
  const by = (k: Finding["kind"]) => findings.filter((f) => f.kind === k);

  console.log(
    `\ncorpus: ${corpus.length} strings, priced at ${HOURS.length} arrival hours ` +
      `× ${DURATIONS.length} durations = ${corpus.length * HOURS.length * DURATIONS.length} prices\n`,
  );
  console.log(`  monotonic breaks : ${by("monotonic").length}   <- a longer stay costing less`);
  console.log(`  cap binds early  : ${by("cap-early").length}   <- flat from 1h to 8h`);
  console.log(`  partial coverage : ${by("partial").length}   <- silent at some arrival hours`);

  for (const kind of ["monotonic", "cap-early", "partial"] as const) {
    const rows = by(kind);
    if (!rows.length) continue;
    console.log(`\n--- ${kind.toUpperCase()} (${rows.length}) ---`);
    for (const f of rows.slice(0, listN)) {
      console.log(`  ${f.entry.name}`);
      console.log(`    ${f.detail}`);
      console.log(`    ${f.entry.rate.slice(0, 100)}`);
    }
    if (rows.length > listN) console.log(`  … ${rows.length - listN} more`);
  }

  // --- caps ---------------------------------------------------------------
  const caps = auditCaps(corpus);
  const capBy = (k: CapFinding["kind"]) => caps.filter((c) => c.kind === k);
  const withCaps = corpus.filter((e) => declaredCaps(e.rate).length).length;
  console.log(`\ncaps: ${withCaps} of ${corpus.length} strings declare one\n`);
  console.log(`  declared, not parsed : ${capBy("declared-not-parsed").length}`);
  console.log(`  leaked into a band   : ${capBy("leaked-into-band").length}   <- the QUEEN ST shape`);
  console.log(`  fee over its own cap : ${capBy("over-declared-cap").length}`);
  console.log(`  cap below first hour : ${capBy("cap-below-entry").length}`);

  for (const kind of [
    "declared-not-parsed",
    "leaked-into-band",
    "over-declared-cap",
    "cap-below-entry",
  ] as const) {
    const rows = capBy(kind);
    if (!rows.length) continue;
    // One line per distinct rate string: the same fault repeats at every hour.
    const seen = new Set<string>();
    const uniq = rows.filter((r) => !seen.has(r.entry.rate) && seen.add(r.entry.rate));
    console.log(`\n--- ${kind.toUpperCase()} (${rows.length} across ${uniq.length} strings) ---`);
    for (const f of uniq.slice(0, listN)) {
      console.log(`  ${f.entry.name}`);
      console.log(`    ${f.detail}`);
      console.log(`    ${f.entry.rate.slice(0, 110)}`);
    }
    if (uniq.length > listN) console.log(`  … ${uniq.length - listN} more strings`);
  }
  console.log();

  if (ci) {
    const fatal = [
      ...findings.filter((f) => f.kind === "monotonic"),
      ...caps.filter((c) => c.kind === "leaked-into-band"),
    ];
    if (fatal.length) {
      console.error(`!!  ${fatal.length} finding(s) that are always a bug:`);
      for (const f of fatal.slice(0, 10)) {
        console.error(`!!    ${f.entry.name} — ${f.detail}`);
      }
      process.exit(1);
    }
    console.log("no monotonic breaks and no cap leaks.");
  }
}

if (process.argv[1]?.endsWith("rateAudit.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
