/**
 * Reads Metro Parking's own rate tables straight from their site.
 *
 *   npx tsx scripts/metroParkingHarvest.ts            # report only
 *   npx tsx scripts/metroParkingHarvest.ts --limit 5  # fewer pages, for a look
 *   npx tsx scripts/metroParkingHarvest.ts --apply    # write the rows
 *
 * Run --apply AS THE deploy USER on the droplet: SQLite recreates -wal/-shm at
 * the process umask on reopen, so a root write leaves root-owned sidecars
 * beside a 0640 deploy:deploy database and the service loses write access.
 *
 * Why this exists. The 2026-09-21 EPS batch spent a web search and an LLM call
 * per car park to reach answers this operator publishes in a table. Two of the
 * eight rows it saved came from metroparking.com.sg — so the model was reading
 * the same page this script reads, at roughly a third of a cent each, and
 * paraphrasing it. Their site lists 36 car parks. Reading them directly is
 * free, deterministic, and `operator-site` rather than `web-llm`.
 *
 * `robots.txt` (checked 2026-09-21) disallows only `/wp-admin/`. Requests are
 * paced and identify themselves.
 *
 * THE PARSE IS NARROW ON PURPOSE. Every page carries three tables — Car, Heavy
 * Vehicle, and Motorcycle — under near-identical headings, and at Bedok Stadium
 * the heavy-vehicle rate is $1.20 per 30 mins against the car's $0.60. Reading
 * the wrong table does not fail, it doubles the price. So the section is cut at
 * "Parking Rates (Car)" and terminated at the next "Parking Rates (", and a
 * page whose car section cannot be found is REPORTED, never guessed at.
 *
 * WHERE THE CAP GOES IS THE WHOLE JOB. Bedok's $5.00 maximum applies only to
 * the overnight session. A cap written into the RATE string is stripped by
 * `withoutCaps` before the rate patterns run — correctly, since a ceiling that
 * looks like a rate once priced Changi's South car park at $35 for two hours —
 * so it then applies NOWHERE. That is the live defect in the stored `web-llm`
 * row for Kallang Car Park 1: measured, it charges $9.60 for an 11pm
 * eight-hour stay the operator caps at $5.00. Note the direction — the failure
 * is overcharging, not the undercharging it looks like at a glance.
 *
 * So a cap goes in NOTES, as its own clause naming its own hours, because
 * `notesForTime` keeps a clause only when its hours cover the arrival. A cap
 * naming no hours is global, which is right for a per-day ceiling and wrong
 * for this one.
 *
 * Every row is PRICED BEFORE IT IS WRITTEN, through the same parser the app
 * uses, and a row whose own rate string will not parse is refused. Writing a
 * rate nothing can price is how "not computable" reaches a card.
 *
 * Existing rows are UPDATED in place rather than joined by a second row. The
 * store keys on (match_type, match_value), so writing a `postal` row beside an
 * existing `name` row for one car park is how duplicates are made — the thing
 * `duplicateSweep` keeps finding.
 */
import { haversineMetres } from "../src/lib/geo";
import { listOverridesWithCoords, upsertOverride, SAME_PLACE_M } from "../src/lib/store/rates";
import { getDb } from "../src/lib/db";
import { parseRate, bandForTime, estimateMallFee, parseLimits, notesForTime } from "../src/lib/sources/mallRates";

const INDEX = "http://metroparking.com.sg/parking-locations/";
const UA = "carpark-sg/1.0 (rate lookup; +https://gtfoo.com)";
const PACE_MS = 1200;

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const APPLY = process.argv.includes("--apply");

interface Loc {
  title: string;
  url: string;
  address: string;
}

interface Band {
  from: string;
  to: string;
  rate: string;
  cap: string | null;
}

function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(20_000),
  });
  // Surfaced, never swallowed: a fetch failure must not read as "this car park
  // publishes no rates".
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** The marker blobs the index embeds, each carrying a location page URL. */
function parseIndex(html: string): Loc[] {
  const out = new Map<string, Loc>();
  for (const m of html.matchAll(/\{"title":/g)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = m.index!; i < html.length; i++) {
      const c = html[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) continue;
    let obj: { title?: string; locationUrl?: string; description?: string };
    try {
      obj = JSON.parse(html.slice(m.index!, end));
    } catch {
      continue;
    }
    const url = (obj.locationUrl ?? "").replace(/\\\//g, "/");
    if (!url.includes("/parking-locations/")) continue;
    out.set(url, {
      title: textOf(obj.title ?? ""),
      url,
      address: textOf(obj.description ?? ""),
    });
  }
  return [...out.values()];
}

/** The CAR table only — see the warning at the top of this file. */
function carSection(pageText: string): string | null {
  const start = pageText.search(/Parking Rates\s*\(\s*Car\s*\)/i);
  if (start < 0) return null;
  let rest = pageText.slice(start + 1);
  const next = rest.search(/Parking Rates\s*\(/i);
  if (next >= 0) rest = rest.slice(0, next);

  // Stop at the prose that follows the table. It restates the cap as a
  // sentence — "For any parking session (daily) between 10.30 pm - 7.00 am
  // ... maximum parking charge of $5.00" — which carries a clock range and a
  // dollar figure and so reads to the band scanner as a third rate band. Left
  // in, Bedok Stadium reports an overnight band of "$5.00" that does not
  // exist: the $5.00 is a ceiling on the $0.60 band above it, not a price.
  const tail = rest.search(/\*\s*\d+\s*minutes?\s*Grace Period|For any parking session/i);
  return tail >= 0 ? rest.slice(0, tail) : rest;
}

const POSTAL = /\b(\d{6})\b/;
const BAND =
  /(\d{1,2}[.:]\d{2}\s*[ap]\.?m\.?)\s*[-–—]\s*(\d{1,2}[.:]\d{2}\s*[ap]\.?m\.?)\s*([^]*?)(?=\d{1,2}[.:]\d{2}\s*[ap]\.?m\.?\s*[-–—]|$)/gi;

function parseBands(car: string): Band[] {
  const out: Band[] = [];
  for (const b of car.matchAll(BAND)) {
    // Collapse the newlines textOf() leaves, so a band is one line before the
    // money is cut out of it — otherwise the capture runs into the next cell.
    const flat = (b[3] ?? "").replace(/\s+/g, " ").trim();
    const money = flat.match(/\$\s?\d+(?:\.\d{2})?[^$(]*/);
    if (!money) continue;
    // The cap is read from the SAME band it is written beside, which is what
    // scopes it to those hours later.
    const cap = flat.match(/max(?:imum)?[^$]{0,24}\$\s?(\d+(?:\.\d{2})?)/i);
    out.push({
      from: b[1]!.replace(/\s+/g, "").toLowerCase(),
      to: b[2]!.replace(/\s+/g, "").toLowerCase(),
      rate: money[0].replace(/\s+/g, " ").replace(/[\s(&|,-]+$/, "").trim(),
      cap: cap ? cap[1]! : null,
    });
  }
  return out;
}

function buildRate(bands: Band[]): string {
  if (bands.length === 1) return bands[0]!.rate;
  return bands.map((b) => `${b.from}-${b.to}: ${b.rate}`).join("; ");
}

function buildNotes(bands: Band[], pageText: string, url: string): string {
  const parts: string[] = [];
  for (const b of bands) {
    // Its own clause, naming its own hours — that is what notesForTime reads.
    if (b.cap) parts.push(`${b.from}-${b.to}: capped at max $${b.cap}.`);
  }
  const grace = pageText.match(/(\d{1,3})\s*minutes?\s*Grace Period/i);
  if (grace) parts.push(`${grace[1]} minutes grace period.`);
  const height = pageText.match(/Vehicle Height Limit[:\s]*([\d.]+)\s*Metres/i);
  if (height) parts.push(`Vehicle height limit ${height[1]} metres.`);
  parts.push(`From Metro Parking's own rate table (${url}) — verify before relying on it.`);
  return parts.join(" ");
}

/** The same parser the app uses, at four arrival hours. */
function priceCheck(rate: string, notes: string): { ok: boolean; line: string } {
  const out: string[] = [];
  let ok = true;
  for (const h of [9, 14, 20, 23]) {
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

async function main(): Promise<void> {
  console.log(`index: ${INDEX}${APPLY ? "   [--apply: WILL WRITE]" : "   (report only)"}`);
  const locs = parseIndex(await get(INDEX));
  console.log(`${locs.length} location pages listed\n`);

  const take = locs.slice(0, Number.isFinite(LIMIT) ? LIMIT : locs.length);
  const noCar: string[] = [];
  const failed: string[] = [];
  const refused: string[] = [];
  let created = 0;
  let updated = 0;
  let priced = 0;

  for (const [i, loc] of take.entries()) {
    if (i) await new Promise((r) => setTimeout(r, PACE_MS));
    let text: string;
    try {
      text = textOf(await get(loc.url));
    } catch (err) {
      failed.push(`${loc.title}: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    const car = carSection(text);
    const postal = POSTAL.exec(loc.address)?.[1] ?? null;
    console.log(`── ${loc.title}${postal ? `  (${postal})` : ""}`);

    if (!car) {
      noCar.push(loc.title);
      console.log("   no 'Parking Rates (Car)' table — reported, not guessed\n");
      continue;
    }

    const bands = parseBands(car);
    if (!bands.length) {
      refused.push(`${loc.title}: car table found, no band parsed`);
      console.log("   car table found but no band parsed — refused\n");
      continue;
    }

    const rate = buildRate(bands);
    const notes = buildNotes(bands, text, loc.url);
    const check = priceCheck(rate, notes);
    console.log(`   rate : ${rate}`);
    console.log(`   notes: ${notes.slice(0, 120)}${notes.length > 120 ? "…" : ""}`);
    console.log(`   2h at ${check.line}`);

    if (!check.ok) {
      refused.push(`${loc.title}: own rate string does not price`);
      console.log("   REFUSED — this row would reach a card as 'not computable'\n");
      continue;
    }
    priced++;

    if (!postal) {
      refused.push(`${loc.title}: no postal code, cannot be placed`);
      console.log("   REFUSED — no postal, so it could never be ranked by distance\n");
      continue;
    }

    if (!APPLY) {
      console.log();
      continue;
    }

    const point = await geocode(postal);
    if (!point) {
      refused.push(`${loc.title}: OneMap has no ${postal}`);
      console.log(`   REFUSED — OneMap returned nothing for ${postal}\n`);
      continue;
    }

    // Update whatever already stands here rather than adding a second row.
    const near = listOverridesWithCoords()
      .map((o) => ({ o, d: haversineMetres({ lat: o.lat!, lng: o.lng! }, point) }))
      .filter((x) => x.d <= SAME_PLACE_M)
      .sort((a, b) => a.d - b.d)[0];

    if (near) {
      getDb()
        .prepare(
          `UPDATE rate_overrides
              SET display_name = ?, weekday_rate = ?, saturday_rate = ?, sunday_ph_rate = ?,
                  friday_rate = NULL, source = 'operator-site', source_url = ?,
                  verified_at = ?, notes = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          loc.title,
          rate,
          rate,
          rate,
          loc.url,
          new Date().toISOString().slice(0, 10),
          notes,
          new Date().toISOString(),
          near.o.id,
        );
      updated++;
      console.log(`   UPDATED #${near.o.id} (was ${near.o.source}, ${Math.round(near.d)} m)\n`);
    } else {
      const row = upsertOverride({
        matchType: "postal",
        matchValue: postal,
        displayName: loc.title,
        weekdayRate: rate,
        fridayRate: null,
        saturdayRate: rate,
        sundayPhRate: rate,
        source: "operator-site",
        sourceUrl: loc.url,
        verifiedAt: new Date().toISOString().slice(0, 10),
        notes,
        lat: point.lat,
        lng: point.lng,
      });
      created++;
      console.log(`   CREATED #${row.id} at ${postal}\n`);
    }
  }

  console.log(`\n${priced} of ${take.length} pages produced a rate that prices.`);
  if (APPLY) console.log(`written: ${created} created, ${updated} updated`);
  if (noCar.length) console.log(`no car table (${noCar.length}): ${noCar.join(", ")}`);
  if (refused.length) {
    console.log(`refused (${refused.length}):`);
    for (const r of refused) console.log(`  ${r}`);
  }
  if (failed.length) {
    console.log(`FETCH FAILURES (${failed.length}) — not the same as "no rates":`);
    for (const f of failed) console.log(`  ${f}`);
  }
  if (!APPLY) console.log("\nReport only — nothing written. Re-run with --apply.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
