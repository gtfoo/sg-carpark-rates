/**
 * Reads Metro Parking's own rate tables straight from their site.
 *
 *   npx tsx scripts/metroParkingHarvest.ts            # report only
 *   npx tsx scripts/metroParkingHarvest.ts --limit 5  # fewer pages, for a look
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
 * Report-only. It prints what it found beside what the store already holds; it
 * writes nothing. Turning this into rows is a separate decision, because the
 * cap wording needs a human: Bedok's $5.00 maximum applies only to the
 * overnight session, and a saved AI row for Kallang already states that cap
 * against the daytime band too.
 */
import { haversineMetres } from "../src/lib/geo";
import { listOverridesWithCoords } from "../src/lib/store/rates";

const INDEX = "http://metroparking.com.sg/parking-locations/";
const UA = "carpark-sg/1.0 (rate lookup; +https://gtfoo.com)";
const PACE_MS = 1200;

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

interface Loc {
  title: string;
  url: string;
  address: string;
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
/** "7.00 am - 10.29 pm $0.60 per 30 mins ..." — one band per match. */
const BAND =
  /(\d{1,2}[.:]\d{2}\s*[ap]\.?m\.?)\s*[-–—]\s*(\d{1,2}[.:]\d{2}\s*[ap]\.?m\.?)\s*([^]*?)(?=\d{1,2}[.:]\d{2}\s*[ap]\.?m\.?\s*[-–—]|$)/gi;

async function main(): Promise<void> {
  console.log(`index: ${INDEX}`);
  const locs = parseIndex(await get(INDEX));
  console.log(`${locs.length} location pages listed\n`);

  const stored = listOverridesWithCoords();
  const take = locs.slice(0, Number.isFinite(LIMIT) ? LIMIT : locs.length);

  let withRates = 0;
  const noCar: string[] = [];
  const failed: string[] = [];

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
    withRates++;

    const bands: string[] = [];
    for (const b of car.matchAll(BAND)) {
      // Collapse the newlines textOf() leaves, so a band's text is one line
      // before the money is cut out of it — otherwise the capture runs on
      // into the next cell and trails a bare "$0" fragment.
      const flat = (b[3] ?? "").replace(/\s+/g, " ").trim();
      const money = flat.match(/\$\s?\d+(?:\.\d{2})?[^$]*/);
      if (money) {
        const txt = money[0].replace(/\s+/g, " ").replace(/[\s|]+$/, "").slice(0, 90);
        bands.push(`${b[1]!.trim()}-${b[2]!.trim()}: ${txt}`);
      }
    }
    if (!bands.length) console.log("   car table found but no $ band parsed");
    for (const b of bands) console.log(`   ${b}`);

    // What do we already hold near here? Distance needs coordinates we do not
    // have for this page, so match on name — enough to flag an overlap for a
    // human, not enough to act on.
    const key = loc.title.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const hit = stored.find((o) => {
      const n = (o.displayName ?? o.matchValue).toUpperCase().replace(/[^A-Z0-9]/g, "");
      return n && (n.includes(key) || key.includes(n));
    });
    if (hit) {
      console.log(
        `   STORED #${hit.id} (${hit.source}) ${hit.displayName ?? hit.matchValue}`,
      );
      console.log(`     weekday: ${hit.weekdayRate ?? "—"}`);
    }
    console.log();
  }

  console.log(`\n${withRates} of ${take.length} pages yielded a car rate table.`);
  if (noCar.length) console.log(`no car table (${noCar.length}): ${noCar.join(", ")}`);
  if (failed.length) {
    console.log(`FETCH FAILURES (${failed.length}) — not the same as "no rates":`);
    for (const f of failed) console.log(`  ${f}`);
  }
  console.log("\nReport only — nothing written.");
  void haversineMetres;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
