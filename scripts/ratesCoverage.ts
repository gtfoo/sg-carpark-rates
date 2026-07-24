/**
 * Measures how much of LTA's free-text mall rates dataset can actually be
 * turned into a number. This is the evidence for whether showing mall fees
 * is worth doing at all.
 */
import { fetchMallRates, estimateMallFee, type ParsedRate } from "../src/lib/sources/mallRates";

function kindOf(r: ParsedRate): string {
  return r.kind;
}

async function main() {
  const rates = await fetchMallRates();
  console.log(`LTA carpark rates dataset: ${rates.length} carparks\n`);

  const tally = new Map<string, number>();
  let usableWeekday = 0;

  for (const r of rates) {
    const k = kindOf(r.weekday);
    tally.set(k, (tally.get(k) ?? 0) + 1);
    if (estimateMallFee(r.weekday, 120) !== null) usableWeekday++;
  }

  console.log("Weekday rate parse outcomes:");
  for (const [kind, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / rates.length) * 100).toFixed(1);
    console.log(`  ${kind.padEnd(16)} ${String(count).padStart(4)}  ${pct}%`);
  }

  const pct = ((usableWeekday / rates.length) * 100).toFixed(1);
  console.log(
    `\nCarparks where a weekday fee can be computed: ${usableWeekday}/${rates.length} (${pct}%)\n`,
  );

  console.log("Sample of what could NOT be parsed:");
  const unparsed = rates.filter((r) => r.weekday.kind === "unparsed").slice(0, 8);
  for (const r of unparsed) {
    const raw = (r.weekday as { kind: "unparsed"; raw: string }).raw;
    console.log(`  ${r.name.padEnd(30)} "${raw.slice(0, 70)}"`);
  }

  console.log("\nWorked examples (2 hours parking):");
  for (const r of rates.filter((x) => estimateMallFee(x.weekday, 120) !== null).slice(0, 8)) {
    const fee = estimateMallFee(r.weekday, 120)!;
    console.log(
      `  ${r.name.padEnd(30)} $${fee.toFixed(2)}   [${r.weekday.kind}]`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
