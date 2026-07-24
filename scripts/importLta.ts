/**
 * Imports LTA OneMotoring published car park rates into the rate store.
 *
 *   npm run import-lta            # rates only (fast; match by name)
 *   npm run import-lta -- --geocode   # also geocode each carpark for map/nearby
 *
 * Source: https://onemotoring.lta.gov.sg/.../parking/parking_rates.{1..8}.html
 * robots.txt allows this (Crawl-delay: 1). Rows are saved as 'operator-site'
 * overrides with the LTA page as the source URL, so re-running replaces them.
 *
 * NOTE: LTA splits weekdays into before/after 5-6pm. Our fee model takes one
 * weekday rate, so we store the daytime (before 5/6pm) rate and keep the
 * evening rate in the notes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  upsertOverride,
  deleteOverridesBySourceUrlLike,
} from "../src/lib/store/rates";

const BASE =
  "https://onemotoring.lta.gov.sg/content/onemotoring/home/owning/ongoing-car-costs/parking/parking_rates";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(join(process.cwd(), file), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && m[1] && process.env[m[1]] === undefined) {
          process.env[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
        }
      }
    } catch {}
  }
}

interface Row {
  name: string;
  wdBefore: string;
  wdAfter: string;
  sat: string;
  sun: string;
}

function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&lsquo;|&apos;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePage(html: string): Row[] {
  const cellRe = /<td[^>]*data-label="([^"]*)"[^>]*>([\s\S]*?)<\/td>/gi;
  const rows: Row[] = [];
  let cur: Row | null = null;
  let m: RegExpExecArray | null;
  while ((m = cellRe.exec(html))) {
    const label = (m[1] ?? "").toLowerCase();
    const val = clean(m[2] ?? "");
    if (label.includes("car park")) {
      if (cur) rows.push(cur);
      cur = { name: val, wdBefore: "", wdAfter: "", sat: "", sun: "" };
    } else if (!cur) {
      continue;
    } else if (label.includes("before")) cur.wdBefore = val;
    else if (label.includes("after")) cur.wdAfter = val;
    else if (label.includes("saturday")) cur.sat = val;
    else if (label.includes("sunday")) cur.sun = val;
  }
  if (cur) rows.push(cur);
  return rows.filter((r) => r.name && r.name.length > 1);
}

const isEmpty = (s: string) =>
  !s || s === "-" || s.toLowerCase().replace(/[^a-z0-9]/g, "") === "na";

/** Maps LTA's 4 columns to our weekday/sat/sun, resolving "Same as …" refs. */
function resolveRates(row: Row) {
  const weekday = isEmpty(row.wdBefore) ? null : row.wdBefore;
  let sat = isEmpty(row.sat) ? null : row.sat;
  if (sat && /same as weekday/i.test(sat)) sat = weekday;
  let sun = isEmpty(row.sun) ? null : row.sun;
  if (sun && /same as saturday/i.test(sun)) sun = sat;
  else if (sun && /same as weekday/i.test(sun)) sun = weekday;

  const evening =
    isEmpty(row.wdAfter) || /same as/i.test(row.wdAfter)
      ? ""
      : `Weekday evening: ${row.wdAfter}. `;
  return { weekday, sat, sun, evening };
}

async function main() {
  loadEnv();
  const doGeocode = process.argv.includes("--geocode");
  const { geocode } = doGeocode
    ? await import("../src/lib/onemap")
    : { geocode: null };

  const removed = deleteOverridesBySourceUrlLike(`${new URL(BASE).origin}%`);
  if (removed > 0) console.log(`Cleared ${removed} rows from a previous LTA import.\n`);

  let imported = 0;
  let skipped = 0;
  let geocoded = 0;

  for (let n = 1; n <= 8; n++) {
    const url = `${BASE}.${n}.html`;
    let html = "";
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        console.log(`page ${n}: HTTP ${res.status} — skipped`);
        continue;
      }
      html = await res.text();
    } catch {
      console.log(`page ${n}: fetch failed — skipped`);
      continue;
    }

    const rows = parsePage(html);
    console.log(`page ${n}: ${rows.length} carparks`);

    for (const row of rows) {
      const { weekday, sat, sun, evening } = resolveRates(row);
      if (!weekday && !sat && !sun) {
        skipped++;
        continue;
      }

      let lat: number | null = null;
      let lng: number | null = null;
      if (geocode) {
        const place = await geocode(row.name).catch(() => null);
        if (place) {
          lat = place.location.lat;
          lng = place.location.lng;
          geocoded++;
        }
        await sleep(300); // be gentle on OneMap
      }

      upsertOverride({
        matchType: "name",
        matchValue: row.name,
        displayName: row.name,
        weekdayRate: weekday,
        saturdayRate: sat,
        sundayPhRate: sun,
        source: "operator-site",
        sourceUrl: url,
        verifiedAt: new Date().toISOString().slice(0, 10),
        notes: `${evening}From LTA OneMotoring — verify before relying on it.`.trim(),
        lat,
        lng,
      });
      imported++;
      if (imported % 50 === 0) console.log(`  …${imported} imported`);
    }

    await sleep(1000); // robots.txt Crawl-delay: 1
  }

  console.log(
    `\nDone. Imported ${imported} rates${doGeocode ? `, geocoded ${geocoded}` : " (no coordinates — run: npm run rates backfill)"}. Skipped ${skipped} with no usable rate.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
