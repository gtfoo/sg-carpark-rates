/**
 * Measures how much of LTA's free-text mall rates dataset can actually be
 * turned into a number. This is the evidence for whether showing mall fees
 * is worth doing at all.
 *
 * Rates are priced for an arrival at 1pm and again at 11pm, because the
 * dataset's two weekday columns are usually a daytime band and an evening one.
 */
import {
  fetchMallRates,
  estimateMallFee,
  parseLimits,
  parseRate,
  bandForTime,
  type ParsedRate,
} from "../src/lib/sources/mallRates";

const PROBES = [
  { label: "1pm", mod: 13 * 60 },
  { label: "11pm", mod: 23 * 60 },
];

function priceAt(text: string, mod: number): { rate: ParsedRate; fee: number | null } {
  const band = bandForTime(text, mod);
  const rate = parseRate(band);
  return { rate, fee: estimateMallFee(rate, 120, parseLimits(band)) };
}

async function main() {
  const rates = await fetchMallRates();
  console.log(`LTA carpark rates dataset: ${rates.length} carparks\n`);

  for (const probe of PROBES) {
    const tally = new Map<string, number>();
    let usable = 0;
    for (const r of rates) {
      const { rate, fee } = priceAt(r.weekday, probe.mod);
      tally.set(rate.kind, (tally.get(rate.kind) ?? 0) + 1);
      if (fee !== null) usable++;
    }
    const pct = ((usable / rates.length) * 100).toFixed(1);
    console.log(`Weekday parse outcomes, arriving ${probe.label}:`);
    for (const [kind, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(
        `  ${kind.padEnd(16)} ${String(count).padStart(4)}  ${((count / rates.length) * 100).toFixed(1)}%`,
      );
    }
    console.log(`  computable: ${usable}/${rates.length} (${pct}%)\n`);
  }

  console.log("Sample of what could NOT be parsed at 1pm:");
  const unparsed = rates
    .filter((r) => priceAt(r.weekday, PROBES[0]!.mod).rate.kind === "unparsed")
    .slice(0, 8);
  for (const r of unparsed) {
    console.log(`  ${r.name.padEnd(30)} "${r.weekday.slice(0, 70)}"`);
  }

  // The point of reading both columns: these carparks charge differently after
  // dark, and until the second column was read they all quoted the day rate.
  console.log("\nCarparks whose evening rate differs from their daytime one:");
  const differs = rates
    .map((r) => ({
      name: r.name,
      day: priceAt(r.weekday, PROBES[0]!.mod).fee,
      night: priceAt(r.weekday, PROBES[1]!.mod).fee,
    }))
    .filter((x) => x.day !== null && x.night !== null && Math.abs(x.day - x.night) > 0.005);
  for (const x of differs.slice(0, 10)) {
    console.log(
      `  ${x.name.padEnd(30)} 1pm $${x.day!.toFixed(2)}   11pm $${x.night!.toFixed(2)}`,
    );
  }
  console.log(`  ... ${differs.length} of ${rates.length} in total\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
