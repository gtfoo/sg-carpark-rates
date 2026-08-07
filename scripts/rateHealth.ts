/**
 * Prices every rate string in the corpus and reports what looks wrong.
 *
 *   npm run rates-health
 *
 * The same checks run in tests/corpus.test.ts on every push; this is the
 * human-readable version for when that fails, or for a look after importing
 * rates. Three mispricing bugs this month were silent — a rate that parses to
 * a plausible-looking number is far more dangerous than one that fails loudly,
 * which is why "implausible" is checked as well as "not computable".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRate,
  estimateMallFee,
  parseLimits,
  bandForTime,
} from "../src/lib/sources/mallRates";

export interface CorpusEntry {
  name: string;
  rate: string;
  notes: string;
}

/** Two hours from 1pm — an ordinary stay, priced against every string. */
export const PROBE_MINUTES = 120;
export const PROBE_MINUTE_OF_DAY = 13 * 60;
/** No Singapore car park charges this for two hours; above it means a misparse. */
export const IMPLAUSIBLE_2H = 50;

export function loadCorpus(): CorpusEntry[] {
  const p = join(process.cwd(), "tests", "fixtures", "rate-corpus.json");
  return JSON.parse(readFileSync(p, "utf8")) as CorpusEntry[];
}

export function priceEntry(e: CorpusEntry): number | null {
  const band = bandForTime(e.rate, PROBE_MINUTE_OF_DAY);
  return estimateMallFee(parseRate(band), PROBE_MINUTES, parseLimits(`${band} ${e.notes}`));
}

export interface Health {
  total: number;
  unpriceable: CorpusEntry[];
  implausible: { entry: CorpusEntry; fee: number }[];
  /** Free without saying so — usually a rate that half-parsed. */
  suspiciousFree: CorpusEntry[];
}

export function checkCorpus(corpus: CorpusEntry[]): Health {
  const health: Health = { total: corpus.length, unpriceable: [], implausible: [], suspiciousFree: [] };
  for (const e of corpus) {
    const fee = priceEntry(e);
    if (fee === null) {
      health.unpriceable.push(e);
    } else if (fee > IMPLAUSIBLE_2H) {
      health.implausible.push({ entry: e, fee });
    } else if (fee === 0 && !/\bfree\b/i.test(e.rate)) {
      health.suspiciousFree.push(e);
    }
  }
  return health;
}

function main() {
  const h = checkCorpus(loadCorpus());
  console.log(`corpus: ${h.total} distinct rate strings, priced for 2h from 1pm\n`);
  console.log(`  unpriceable    : ${h.unpriceable.length}`);
  console.log(`  implausible    : ${h.implausible.length}  (over $${IMPLAUSIBLE_2H} for 2h)`);
  console.log(`  free, unstated : ${h.suspiciousFree.length}\n`);

  for (const [label, list] of [
    ["UNPRICEABLE", h.unpriceable.map((e) => `${e.name} :: ${e.rate}`)],
    ["IMPLAUSIBLE", h.implausible.map((x) => `$${x.fee.toFixed(2)}  ${x.entry.name} :: ${x.entry.rate}`)],
    ["FREE BUT NOT STATED", h.suspiciousFree.map((e) => `${e.name} :: ${e.rate}`)],
  ] as const) {
    if (!list.length) continue;
    console.log(`--- ${label} (${list.length}) ---`);
    list.slice(0, 25).forEach((l) => console.log(`  ${l.slice(0, 118)}`));
    if (list.length > 25) console.log(`  … ${list.length - 25} more`);
    console.log();
  }
}

if (process.argv[1] && process.argv[1].endsWith("rateHealth.ts")) main();
