/**
 * Writes rates researched by hand, from a JSON file, with the same guards the
 * automated paths use.
 *
 *   npx tsx scripts/applyFindings.ts data/findings.json
 *   npx tsx scripts/applyFindings.ts data/findings.json --apply
 *
 * Run --apply as the deploy user on the droplet: SQLite recreates -wal/-shm at
 * the process umask on reopen, so a root write leaves root-owned sidecars
 * beside a 0640 deploy:deploy database and the service loses write access.
 *
 * Why this exists. `bulkEpsLookup` buys each answer — one Tavily search plus
 * one to three LLM calls, about half a cent a car park, and roughly half of
 * them come back "no reliable rate found". An operator that publishes a rate
 * table can be read directly instead, at no API cost, and the result is
 * `operator-site` rather than `web-llm`. This is the write end of that: the
 * research happens outside, the file records what was found and where, and this
 * applies it under the same checks as anything else.
 *
 * It keeps the three guards that were learned the expensive way:
 *
 *   PRICE BEFORE WRITING. Every rate goes through the parser the app uses, at
 *   four arrival hours, and a row whose own rate will not price is refused.
 *   Writing a rate nothing can price is how "not computable" reaches a card.
 *
 *   MATCH ON NAME **OR** PROXIMITY. Proximity alone wrote a second Choa Chu
 *   Kang row on 2026-09-22 because the existing row sat past the 25 m test.
 *   Where more than one row matches, it refuses and names them rather than
 *   choosing — `duplicateSweep` refuses for the same reason.
 *
 *   POSTAL, NEVER A NAME, for the coordinates. OneMap answers a postal exactly
 *   and a name only fuzzily, and the fuzzy path is what put Changi General
 *   Hospital 13 km away at a building sharing its acronym.
 *
 * The `source` field is the author's claim about provenance and is written as
 * given: `operator-site` when the figure came off the operator's own page,
 * `web-llm` when it came off an aggregator. Do not promote an aggregator.
 */
import { readFileSync } from "node:fs";
import { haversineMetres } from "../src/lib/geo";
import {
  listOverrides,
  listOverridesWithCoords,
  upsertOverride,
  SAME_PLACE_M,
} from "../src/lib/store/rates";
import { getDb } from "../src/lib/db";
import {
  parseRate,
  bandForTime,
  estimateMallFee,
  parseLimits,
  notesForTime,
} from "../src/lib/sources/mallRates";

interface Finding {
  postal: string;
  name: string;
  weekday: string;
  friday?: string | null;
  saturday?: string | null;
  sundayPh?: string | null;
  notes: string;
  sourceUrl: string;
  source: "operator-site" | "web-llm" | "manual";
}

const file = process.argv[2];
const APPLY = process.argv.includes("--apply");
if (!file || file.startsWith("--")) {
  console.error("usage: applyFindings.ts <file.json> [--apply]");
  process.exit(1);
}

const findings = JSON.parse(readFileSync(file, "utf8")) as Finding[];
console.log(`${findings.length} finding(s) from ${file}${APPLY ? "   [--apply: WILL WRITE]" : "   (report only)"}\n`);

function priceCheck(rate: string, notes: string): { ok: boolean; line: string } {
  const out: string[] = [];
  let ok = true;
  for (const h of [8, 13, 19, 23]) {
    const parsed = parseRate(bandForTime(rate, h * 60));
    if (!parsed || parsed.kind === "unparsed") {
      ok = false;
      out.push(`${h}h:NOPARSE`);
      continue;
    }
    const fee = estimateMallFee(parsed, 120, parseLimits(notesForTime(notes, h * 60)));
    if (fee === null) {
      ok = false;
      out.push(`${h}h:—`);
    } else out.push(`${h}h:$${fee.toFixed(2)}`);
  }
  return { ok, line: out.join("  ") };
}

async function geocode(postal: string): Promise<{ lat: number; lng: number } | null> {
  const res = await fetch(
    `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${postal}&returnGeom=Y&getAddrDetails=Y`,
    { signal: AbortSignal.timeout(20_000) },
  );
  // Surfaced, never swallowed — a network failure must not read as "no such postal".
  if (!res.ok) throw new Error(`OneMap HTTP ${res.status} for ${postal}`);
  const body = (await res.json()) as {
    results?: { POSTAL?: string; LATITUDE?: string; LONGITUDE?: string }[];
  };
  const hit = (body.results ?? []).find((r) => r.POSTAL === postal);
  if (!hit) return null;
  const lat = Number(hit.LATITUDE);
  const lng = Number(hit.LONGITUDE);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function main(): Promise<void> {
  let created = 0;
  let updated = 0;
  const refused: string[] = [];

  for (const f of findings) {
    console.log(`── ${f.name}  (${f.postal})  [${f.source}]`);
    const check = priceCheck(f.weekday, f.notes);
    console.log(`   2h at ${check.line}`);
    if (!check.ok) {
      refused.push(`${f.name}: weekday rate does not price`);
      console.log("   REFUSED — would reach a card as 'not computable'\n");
      continue;
    }
    // Every other day's rate must price too, or the card is wrong on that day
    // rather than on every day, which is harder to notice.
    let bad = false;
    for (const [label, text] of [
      ["friday", f.friday],
      ["saturday", f.saturday],
      ["sundayPh", f.sundayPh],
    ] as const) {
      if (!text) continue;
      const c = priceCheck(text, f.notes);
      if (!c.ok) {
        refused.push(`${f.name}: ${label} rate does not price`);
        console.log(`   REFUSED — ${label} rate does not price (${c.line})\n`);
        bad = true;
        break;
      }
    }
    if (bad) continue;

    if (!APPLY) {
      console.log();
      continue;
    }

    // OneMap throttles, and it throttled this batch at the third postal. The
    // failure was surfaced rather than swallowed, which was right — but it
    // propagated out of main() and killed the run after two writes, so six
    // findings that had already passed every check were lost to one 429.
    //
    // A failure here is about THIS finding, so it is caught here: refuse this
    // one, name the reason, and carry on. Aborting the batch is a third
    // behaviour, and it is never the one wanted.
    let point: { lat: number; lng: number } | null = null;
    try {
      point = await geocode(f.postal);
    } catch (err) {
      refused.push(`${f.name}: ${err instanceof Error ? err.message : err}`);
      console.log(`   REFUSED — ${err instanceof Error ? err.message : err}\n`);
      continue;
    }
    // Paced for the same reason. Cheaper than being throttled into a retry.
    await new Promise((r) => setTimeout(r, 1200));

    const all = listOverridesWithCoords();
    const titleKey = key(f.name);

    // The NAME test runs over EVERY row, not only the located ones. A row with
    // no coordinates is invisible to `listOverridesWithCoords`, so the guard
    // could not see it at all — and 109 rows are in that state. It cost a
    // duplicate immediately: #650 "Keppel Bay Tower / Harbourfront Tower One",
    // LTA open data from 2024 and unlocated, sat beside a new HarbourFront
    // Tower One row without either test firing. Proximity could not see it for
    // want of a point, and the prefix could not see it because the stored name
    // leads with the OTHER building it conflates.
    //
    // Matching a slash-joined name is deliberately not attempted here. Splitting
    // on "/" would make "Keppel Bay Tower" and "Harbourfront Tower One" two
    // candidates from one row, and #856 shows where that ends — three
    // attractions 6 km apart under one heading. Report the collision; let a
    // person decide what the row is.
    const named = listOverrides().filter((o) => {
      const k = key(o.displayName ?? o.matchValue);
      return k === titleKey || (titleKey.length >= 12 && k.startsWith(titleKey));
    });
    const byName = named;
    const byPoint = point
      ? all
          .map((o) => ({ o, d: haversineMetres({ lat: o.lat!, lng: o.lng! }, point) }))
          .filter((x) => x.d <= SAME_PLACE_M)
          .sort((a, b) => a.d - b.d)
      : [];

    const candidates = new Map<number, { o: (typeof named)[number]; d: number }>();
    for (const x of byPoint) candidates.set(x.o.id, x);
    for (const o of byName) if (!candidates.has(o.id)) candidates.set(o.id, { o, d: -1 });

    if (candidates.size > 1) {
      const ids = [...candidates.values()].map((c) => `#${c.o.id}`).join(", ");
      refused.push(`${f.name}: ${candidates.size} existing rows match (${ids})`);
      console.log(`   REFUSED — ${candidates.size} rows already match (${ids}); not guessing\n`);
      continue;
    }
    const near = [...candidates.values()][0];

    if (!near && !point) {
      refused.push(`${f.name}: OneMap has no ${f.postal} and no existing row`);
      console.log(`   REFUSED — OneMap has no ${f.postal}, and nothing here to update\n`);
      continue;
    }

    const today = new Date().toISOString().slice(0, 10);
    if (near) {
      getDb()
        .prepare(
          `UPDATE rate_overrides
              SET display_name = ?, weekday_rate = ?, friday_rate = ?, saturday_rate = ?,
                  sunday_ph_rate = ?, source = ?, source_url = ?, verified_at = ?,
                  notes = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          f.name,
          f.weekday,
          f.friday ?? null,
          f.saturday ?? null,
          f.sundayPh ?? null,
          f.source,
          f.sourceUrl,
          today,
          f.notes,
          new Date().toISOString(),
          near.o.id,
        );
      updated++;
      console.log(
        `   UPDATED #${near.o.id} (was ${near.o.source}, ${near.d < 0 ? "matched by name" : Math.round(near.d) + " m away"})\n`,
      );
    } else {
      const row = upsertOverride({
        matchType: "postal",
        matchValue: f.postal,
        displayName: f.name,
        weekdayRate: f.weekday,
        fridayRate: f.friday ?? null,
        saturdayRate: f.saturday ?? null,
        sundayPhRate: f.sundayPh ?? null,
        source: f.source,
        sourceUrl: f.sourceUrl,
        verifiedAt: today,
        notes: f.notes,
        lat: point!.lat,
        lng: point!.lng,
      });
      created++;
      console.log(`   CREATED #${row.id} at ${f.postal}\n`);
    }
  }

  if (APPLY) console.log(`written: ${created} created, ${updated} updated`);
  if (refused.length) {
    console.log(`refused (${refused.length}):`);
    for (const r of refused) console.log(`  ${r}`);
  }
  if (!APPLY) console.log("Report only — nothing written. Re-run with --apply.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
