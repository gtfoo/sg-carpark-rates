/**
 * Files rates that were researched by hand (or by an assistant reading the
 * operator's own page) into a running instance.
 *
 *   npm run import-researched -- --dry
 *   npm run import-researched -- --host https://carpark.gtfoo.com
 *
 * This exists so filling the ~250 rate-less EPS car parks doesn't have to burn
 * the app's own Tavily/Gemini quota: the figures below were read off each
 * operator's official page and are quoted in `notes` with the URL, so anyone
 * can re-verify. Rates use the same text form the parser already understands.
 *
 * Add entries as they're researched; re-running is safe (upsert by name).
 */
interface Researched {
  /** Must match the EPS car park name so the two dedupe to one card. */
  match: string;
  display: string;
  lat: number;
  lng: number;
  weekday: string;
  saturday?: string;
  sundayPh?: string;
  notes: string;
  url: string;
}

const RATES: Researched[] = [
  {
    match: "GARDENS BY THE BAY (BAY SOUTH)",
    display: "Gardens by the Bay (Bay South)",
    lat: 1.28148,
    lng: 103.8636,
    weekday: "$0.035 per minute",
    notes:
      "Capped at $30 per day. Same rate applies at Bay South (Main Entrance, " +
      "The Meadow, Bayfront Plaza, Satay by the Bay) and Bay East.",
    url: "https://www.gardensbythebay.com.sg/en/plan-your-visit/getting-here.html",
  },
  {
    match: "CHANGI AIRPORT T2 CARPARK",
    display: "Changi Airport T2 Car Park",
    lat: 1.35585,
    lng: 103.98826,
    weekday: "$0.65 per 15 mins",
    notes: "Grace period: 10 mins for pick-up/drop-off.",
    url: "https://www.changiairport.com/en/at-changi/facilities-and-services-directory/airport-parking.html",
  },
  {
    match: "T3A CAR PARK",
    display: "Changi Airport T3 Car Park",
    lat: 1.35563,
    lng: 103.98617,
    weekday: "$0.65 per 15 mins",
    notes: "Grace period: 10 mins for pick-up/drop-off.",
    url: "https://www.changiairport.com/en/at-changi/facilities-and-services-directory/airport-parking.html",
  },
  {
    // RWS bills Fri/Sat/Sun/PH at the weekend rate, but this app's day model is
    // weekday / Saturday / Sunday-PH — there's nowhere to put "Friday counts as
    // the weekend", so Friday shows the cheaper weekday rate. Flagged in notes.
    match: "RESORT WORLD AT SENTOSA",
    display: "Resorts World Sentosa",
    lat: 1.25523,
    lng: 103.82038,
    weekday: "$6.50 for 1st hr, $1.10 per sub half hr (max cap $13.10)",
    saturday: "$9.70 for 1st hr, $1.10 per sub half hr (max cap $16.30)",
    sundayPh: "$9.70 for 1st hr, $1.10 per sub half hr (max cap $16.30)",
    notes:
      "Grace period: 10 mins. RWS charges the weekend rate from FRIDAY; this " +
      "app prices Friday as a weekday, so a Friday estimate is lower than you " +
      "will actually pay. Free parking with a minimum spend at some outlets.",
    url: "https://www.rwsentosa.com/en/about/getting-here",
  },
  {
    // The hospital's own EPS entries report no public lots, so this won't merge
    // with a card — it stands on its own as a saved rate near the campus.
    match: "SINGAPORE GENERAL HOSPITAL",
    display: "Singapore General Hospital (OCH / Emergency)",
    lat: 1.27858,
    lng: 103.83612,
    // Mon-Sat share a rate at SGH; only Sunday/PH is cheaper.
    weekday: "7am-10pm: $0.037 per minute; 10pm-7am: $2.16 per entry",
    saturday: "7am-10pm: $0.037 per minute; 10pm-7am: $2.16 per entry",
    sundayPh: "7am-10pm: $0.019 per minute; 10pm-7am: $2.16 per entry",
    notes:
      "OCH and Emergency/NNI car parks. Car Park H (Macalister Road) is cheaper " +
      "at $0.019 per minute 7am-10pm. No grace period published.",
    url: "https://www.sgh.com.sg/patient-services/visiting-information/getting-to-sgh/carpark-and-fee",
  },
  {
    match: "UNITED SQUARE",
    display: "United Square",
    lat: 1.31718,
    lng: 103.84377,
    // Semicolons separate TIME BANDS, so the first-then pair is joined with a
    // comma — a semicolon there would split the rate and lose the 15-min block.
    weekday: "6am-6pm: $2.40 for 1st hr, $0.60 per sub 15 mins; 6pm-6am: $2.60 per entry",
    notes: "Grace period: 15 mins. Season parking $350/month.",
    url: "https://www.unitedsquare.com.sg/getting-here/",
  },
  {
    match: "CHANGI AIRPORT T1 CARPARK",
    display: "Changi Airport T1 / Jewel Car Park",
    lat: 1.35585,
    lng: 103.98826,
    weekday: "$0.65 per 15 mins",
    notes:
      "Grace period: 10 mins for pick-up/drop-off. NOTE: short-term bays (B2M/B2) " +
      "charge this for the first 90 mins only, then $5 per 30 mins — a long stay " +
      "costs more than shown here. General parking (B3-B5) is $0.65/15 mins throughout.",
    url: "https://www.changiairport.com/en/at-changi/facilities-and-services-directory/airport-parking.html",
  },
];

async function main() {
  const dry = process.argv.includes("--dry");
  const hostArg = process.argv.indexOf("--host");
  const host = hostArg > -1 ? process.argv[hostArg + 1]! : "http://127.0.0.1:3001";

  console.log(`${dry ? "DRY RUN" : "WRITING"} -> ${host}\n`);
  let ok = 0;
  for (const r of RATES) {
    const body = {
      matchType: "name" as const,
      matchValue: r.match,
      displayName: r.display,
      weekdayRate: r.weekday,
      saturdayRate: r.saturday ?? null,
      sundayPhRate: r.sundayPh ?? null,
      // Read off the operator's own page, so it carries that provenance and a
      // link to re-verify — not an AI guess from search snippets.
      source: "operator-site" as const,
      sourceUrl: r.url,
      notes: r.notes,
      lat: r.lat,
      lng: r.lng,
    };
    if (dry) {
      console.log(`  ${r.display}\n     ${r.weekday}\n     ${r.notes.slice(0, 96)}`);
      ok++;
      continue;
    }
    const res = await fetch(`${host}/api/rates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      console.log(`  saved: ${r.display}`);
      ok++;
    } else {
      console.error(`  FAILED: ${r.display} — HTTP ${res.status} ${await res.text()}`);
    }
  }
  console.log(`\n${dry ? "would save" : "saved"} ${ok}/${RATES.length}`);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
