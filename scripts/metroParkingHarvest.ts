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

/**
 * The CAR table only — see the warning at the top of this file — split into the
 * band rows and the prose that follows them.
 *
 * The split is not tidiness, it is the difference between two defects. The
 * prose restates the ceiling as a sentence — "For any parking session (daily)
 * between 10.30 pm - 7.00 am (next day) ... subject to a maximum parking charge
 * of $5.00" — carrying both a clock range and a dollar figure, so the band
 * scanner reads it as a third rate band and invents an overnight price of $5.00
 * that does not exist.
 *
 * But it is also the ONLY place some pages state the cap at all. Choa Chu Kang
 * and every page using the "10.30 pm - 7.00 am" wording put it here, while
 * Bedok and Kallang put it inline in the band. Cutting the prose outright — the
 * first version of this — silently dropped the real cap from those rows, which
 * is the same overcharging this script exists to fix, reintroduced by the fix.
 *
 * So: `bands` for the rate scan, `prose` for the cap scan, never the reverse.
 */
function carSection(pageText: string): { bands: string; prose: string } | null {
  const start = pageText.search(/Parking Rates\s*\(\s*Car\s*\)/i);
  if (start < 0) return null;
  let rest = pageText.slice(start + 1);
  const next = rest.search(/Parking Rates\s*\(/i);
  if (next >= 0) rest = rest.slice(0, next);

  const tail = rest.search(/\*\s*\d+\s*minutes?\s*Grace Period|For any parking session/i);
  return tail >= 0
    ? { bands: rest.slice(0, tail), prose: rest.slice(tail) }
    : { bands: rest, prose: "" };
}

/**
 * A ceiling stated in prose, with the hours it applies to.
 *
 * Returned as its own clause naming its own hours so `notesForTime` scopes it —
 * a cap naming no hours is global, which would cap the daytime band too.
 */
function proseCap(prose: string): string | null {
  const m = prose.match(
    /between\s*(\d{1,2}[.:]\d{2}\s*[ap]\.?m\.?)\s*[-–—]\s*(\d{1,2}[.:]\d{2}\s*[ap]\.?m\.?)[^$]{0,120}\$\s?(\d+(?:\.\d{2})?)/i,
  );
  if (!m) return null;
  const from = m[1]!.replace(/\s+/g, "").toLowerCase();
  const to = m[2]!.replace(/\s+/g, "").toLowerCase();
  return `${from}-${to}: capped at max $${m[3]}.`;
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

function buildNotes(bands: Band[], prose: string, pageText: string, url: string): string {
  const parts: string[] = [];
  for (const b of bands) {
    // Its own clause, naming its own hours — that is what notesForTime reads.
    if (b.cap) parts.push(`${b.from}-${b.to}: capped at max $${b.cap}.`);
  }
  // Pages split into two families: Bedok and Kallang state the ceiling inline
  // in the band, Choa Chu Kang and the "10.30pm-7.00am" pages state it only in
  // the prose. Take the prose one only when no band already carried it, so a
  // page in the first family does not emit the cap twice.
  if (!bands.some((b) => b.cap)) {
    const cap = proseCap(prose);
    if (cap) parts.push(cap);
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

    const bands = parseBands(car.bands);
    if (!bands.length) {
      refused.push(`${loc.title}: car table found, no band parsed`);
      console.log("   car table found but no band parsed — refused\n");
      continue;
    }

    const rate = buildRate(bands);
    const notes = buildNotes(bands, car.prose, text, loc.url);
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

    // OneMap does not know every postal — 397726 (Kallang Car Park 1) and
    // 088268 (Yan Kit Playfield) both return nothing. That is not fatal when a
    // row for this car park already exists, because it already has a point.
    const point = await geocode(postal);

    // Match on PROXIMITY OR NAME, not proximity alone. Proximity alone is what
    // created a second Choa Chu Kang Sports Centre on the first run: the
    // existing row sat further than SAME_PLACE_M from the geocoded postal, so
    // the 25 m test saw nothing and a duplicate was written. `duplicateSweep`
    // has always clustered on both keys for exactly this reason.
    //
    // Name equality is EXACT after normalising, never substring: a substring
    // test is how a row stored as "MOE" captured every MOE-prefixed place.
    const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const titleKey = key(loc.title);
    const all = listOverridesWithCoords();
    const byName = all.filter((o) => key(o.displayName ?? o.matchValue) === titleKey);
    const byPoint = point
      ? all
          .map((o) => ({ o, d: haversineMetres({ lat: o.lat!, lng: o.lng! }, point) }))
          .filter((x) => x.d <= SAME_PLACE_M)
          .sort((a, b) => a.d - b.d)
      : [];

    const candidates = new Map<number, { o: (typeof all)[number]; d: number }>();
    for (const x of byPoint) candidates.set(x.o.id, x);
    for (const o of byName) if (!candidates.has(o.id)) candidates.set(o.id, { o, d: -1 });

    if (candidates.size > 1) {
      const ids = [...candidates.values()].map((c) => `#${c.o.id}`).join(", ");
      refused.push(`${loc.title}: ${candidates.size} existing rows match (${ids})`);
      console.log(`   REFUSED — ${candidates.size} rows already match (${ids}); not guessing\n`);
      continue;
    }

    const near = [...candidates.values()][0];

    if (!near && !point) {
      refused.push(`${loc.title}: OneMap has no ${postal} and no existing row to update`);
      console.log(`   REFUSED — OneMap has no ${postal}, and nothing here to update\n`);
      continue;
    }

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
      const how = near.d < 0 ? "matched by name" : `${Math.round(near.d)} m away`;
      console.log(`   UPDATED #${near.o.id} (was ${near.o.source}, ${how})\n`);
    } else if (point) {
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
