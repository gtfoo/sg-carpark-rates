# carpark-sg

Personal tool: find nearby Singapore carparks for a destination, with type,
shelter, live availability and calculated parking fees. Built as an installable
web app (PWA) so it runs on both Android and iPhone with no app stores and no
Apple Developer fee.

```bash
npm install
npm run dev            # http://localhost:3001
npm run build && npm start

npm run validate       # SVY21 -> WGS84 transform correctness
npm run rates-coverage # how much of the mall rates data is parseable
npm run demo -- "Tampines Mall" 120
```

## Data sources — all free, no keys required so far

| Capability | Status | Source |
|---|---|---|
| Carpark locations (2,268) | Works | data.gov.sg HDB carpark info |
| Basement / multi-storey / surface | Works | `car_park_type`, `car_park_basement` |
| parking.sg app required | Works | `type_of_parking_system` = COUPON |
| Live availability (~2,000) | Works | data.gov.sg, ~1 min refresh |
| **Historical availability** | Works, 2+ yrs back | same endpoint, `date_time=` |
| HDB/URA fee calculation | Works | published schedule (not an API) |
| Destination geocoding | Works, no auth | OneMap search |
| Walking distance | Needs free account | OneMap routing returns 401 |
| Mall/private rates | 87.7% parseable, **stale** | LTA dataset, last updated Jun 2024 |

### OneMap credentials

Copy `.env.example` to `.env.local` and set `ONEMAP_EMAIL` / `ONEMAP_PASSWORD`.
The server mints and refreshes access tokens itself — tokens expire after ~3
days, so a manually pasted `ONEMAP_TOKEN` is a standing breakage on a VPS.
Verify with `npm run check-onemap`, which prints pass/fail and distances but
never the credentials.

As of Jul 2026 the OneMap *search* endpoint also returns an "Authentication
token missing" error alongside results, so the token is now sent on geocoding
calls too. Unauthenticated access appears to be winding down.

Real walking distance runs far longer than straight-line — measured **+80%**
for a 162 m crow-flies hop near Tampines Mall, not the 20-40% commonly quoted.
This changes result ordering, not just the displayed number.

## The finding that shaped the design

HDB coverage is inverted relative to need:

- **Tampines Mall** — nearest HDB carpark 162 m, live lots, exact fees.
- **ION Orchard** — nearest HDB carpark **1,428 m**. Useless.

Orchard, Marina and the CBD are served by commercial carparks, which is exactly
where the data is weakest. So commercial carparks are matched by name only and
always labelled `approximate`. Heartland coverage is genuinely good.

## Web lookup (optional)

When a search has no rate for the destination's own parking **and** no HDB
carpark within a short walk, the app finds the rate on the web itself:

1. **Search** — Tavily searches for the carpark's official rate page.
2. **Extract** — an LLM turns the results into the same rate shape as
   everything else, so it flows through the time-aware fee engine unchanged.
3. Saved as a **`web-llm`** override — labelled "AI-retrieved · verify" in the
   UI with a source link, and it clears the matching gap.

The UI shows a spinner + "Searching the web for X's parking rates…", then
refreshes to show the found rate (or a clear reason if it fails).

### Why two services

Gemini's own Google Search grounding needs a **billing-enabled** project (the
no-card free tier caps it at ~20/day and 429s — verified against every current
`generateContent` model). So the two steps are split, each free and swappable:

| Step | Default | Free key (no card) | Swap via |
|---|---|---|---|
| Search | Tavily (1,000/mo) | https://tavily.com | `SEARCH_PROVIDER`, `src/lib/websearch.ts` |
| Extract | Gemini `gemini-flash-latest` | https://aistudio.google.com/apikey | `LLM_PROVIDER`/`LLM_MODEL`, `src/lib/llm.ts` |

Put `TAVILY_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local`, then:

```bash
npm run lookup "Jewel Changi Airport"
npm run lookup "Changi Airport Terminal 3" --postal 819663
```

Note: `gemini-2.5-*` models are retired for new API keys — the default is
`gemini-flash-latest`. Lookups only fire on genuine gaps, and an existing rate
short-circuits the call, so day-to-day spend stays near zero.

## LTA OneMotoring rate import

`npm run import-lta` scrapes LTA's published car-park rate tables (8 pages at
`onemotoring.lta.gov.sg/.../parking/parking_rates.N.html`; `robots.txt` allows
it, `Crawl-delay: 1` honoured) and saves ~365 carparks as `operator-site` rates
keyed to the LTA page URL, so re-running cleanly replaces them.

```bash
npm run import-lta              # rates only (match by name)
npm run import-lta -- --geocode # also geocode each (map + nearby matching)
```

Caveats, by design:
- LTA splits weekdays into **before/after 5-6 pm**; our fee model takes one
  weekday rate, so the **daytime** rate is stored and the evening rate goes in
  the notes. Evening estimates for these will differ — the note has the figure.
- ~80% of rows parse to a fee; the rest are venue pointers ("park at nearby
  malls") or unparseable formats, shown as "—".
- Geocoding hits ~75%; the rest still match by name (destination search).

## Resilience

`data.gov.sg` rate-limits at ~60 req/min and 429s in bursts. To keep a search
from dying on a transient upstream hiccup:

- Dataset fetches **retry with backoff** (`src/lib/sources/datagov.ts`).
- The HDB carpark list and mall rates are mirrored to a `dataset_cache` table
  on every successful fetch; if a later fetch fails, search serves the
  last-known copy (they change ~monthly, so slightly-stale is fine).
- Live availability is **best-effort** — if it fails, results still render with
  "no live lot data" rather than a 502.

## Persistent rate store & gap log

A SQLite database (`data/carpark.db`, gitignored; override with `CARPARK_DB_PATH`)
holds the two things that are **not** re-derivable from an upstream API:

- **Rate overrides** — rates you verified yourself, for places no dataset covers
  (NTU@one-north, condos, offices). Each carries a `source`
  (`manual` / `operator-site`), a `verified_at` date, and an optional
  `source_url`. Matched by carpark number, postal code, or normalized name.
  Manual rates **win** over dataset rates.
- **Gap log** — destinations you searched that had no rate for their own parking
  *and* no HDB carpark within ~200 m. This is your fill-in list, ranked by how
  often you've searched each one. Adding a rate auto-clears the matching gap.

Everything else (HDB carpark list, live availability, public holidays) is
deliberately **not** persisted — it comes fresh from data.gov.sg each run, and
storing it would only add staleness.

Rate text uses the same shape as the LTA dataset and runs through the same
parser, so it's time-aware (weekday / Saturday / Sunday-PH, day & night windows):

```bash
npm run rates gaps                       # what needs a rate
npm run rates add --value "NTU@one-north" \
    --weekday "\$1.20 per half hour" --sun "Free" \
    --url "https://..." --note "basement, EPS gantry"
npm run rates list
npm run rates del --id 3
```

Or in the app: every result list has a **"＋ Add a rate for …"** button that
opens a form (name, weekday/Saturday/Sunday rate, source URL, notes),
pre-located at the destination so the saved rate is spatially matchable. Under
the hood it's `GET/POST/DELETE /api/rates` (also `GET/POST /api/gaps`).

Provenance shows on every result card: "HDB rate schedule (current)",
"LTA dataset · ~2 years old", or "Your rate · verified today" with a source link.

### `better-sqlite3` notes

It's a native addon: `serverExternalPackages: ["better-sqlite3"]` in
`next.config.ts` keeps it out of the bundle, and `output: "standalone"` traces
the compiled `.node` file into `.next/standalone` for the VPS — no `npm install`
needed on the box.

## Time-aware rates

Search takes a start time (defaults to now, Singapore time) and prices the
session against the rules that actually apply at that moment.

**Everything is computed in Asia/Singapore, never the server's zone.** The VPS
may run in UTC; the 07:00 and 22:30 boundaries, Sunday free parking and public
holidays are all SGT concepts. `src/lib/time.ts` uses a fixed UTC+8 offset —
Singapore has observed no daylight saving since 1935.

What the rate breakdown covers:

| Rule | Source |
|---|---|
| Day rate 07:00-22:30, cap $12 / $20 central | published schedule |
| Night rate 22:30-07:00, cap $5 | published schedule |
| Free on Sundays + public holidays | HDB `free_parking`, per carpark |
| Short-term window (WHOLE DAY / 7AM-7PM / 7AM-10.30PM / NO) | HDB `short_term_parking` |
| Whether night parking exists at all | HDB `night_parking` |
| Weekday / Saturday / Sunday+PH columns | LTA rates dataset |
| Public holiday calendar | MOM, `d_8ef23381f9417e4d4254ee8b4dcdb176` |

Sessions are split at every boundary they cross — midnight, 07:00, 22:30 — and
each day and night window is capped independently. Durations up to 14 days are
supported for airport-style stays.

Worked examples (T54, coupon carpark, night parking available):

```
Wed 11pm,  7h  ->  $5.45   $5 night cap + 9% GST
Wed 11pm, 23h  -> $18.53   $5 night + $12 day cap + GST
Wed  8pm,  5h  ->  $6.54   $3 day + $3 night + GST
Wed 11pm, 72h  -> $56.24   3 night caps + 3 day caps + 30 min
```

Carparks with `free_parking = SUN & PH FR 7AM-10.30PM` drop to $0 on Sundays
and public holidays; carparks with `short_term_parking = NO` report that rather
than quoting a fee.

### Bug worth remembering

The night window runs 22:30 to 07:00 and therefore straddles two calendar
dates, but it is ONE night with ONE $5 cap. Keying the cap by calendar date
charged it twice, quoting $6.76 for a single overnight stay instead of $5.45.
See `nightKey()` in `fees.ts`.

## Address autocomplete

Backed by OneMap search, not Google Places. Handles building names, block
addresses and **postal codes** (`238801` resolves to ION Orchard). Free at any
volume.

Google Places Autocomplete would cost ~$2.83 per 1,000 requests without session
tokens, and autocomplete fires on nearly every keystroke — the easiest Google
SKU to run up a bill on. Google's universal $200 monthly credit ended Feb 2025.

Implementation notes:

- Goes through `/api/suggest`, never the browser directly. OneMap search now
  requires the access token, and that token must not reach the client.
- 250 ms debounce, and in-flight requests are aborted so a slow early keystroke
  cannot overwrite the results of a later, more specific one.
- Minimum 2 characters; shorter prefixes match half of Singapore.
- OneMap returns near-duplicate rows for large sites, so results are
  de-duplicated on name + postal code.
- Full keyboard support (arrows, Enter, Escape) with combobox/listbox ARIA
  roles. Options use `pointerdown` rather than `click` — the input's blur would
  otherwise dismiss the list before a click could land.
- Picking a suggestion runs the search immediately rather than requiring a
  second tap on the button.

## Map

Leaflet + **OneMap raster tiles** (`Default` in light mode, `Night` in dark).
No API key, no usage billing. Deliberately not Google Maps: Google retired its
universal monthly credit in Mar 2025 and now charges roughly $7 per 1,000 map
loads beyond a small free tier, which would be the only recurring cost in the
whole project.

- Pins are colour-coded by live availability and numbered to match the list
  badges below the map.
- Commercial carparks have no coordinates in the LTA dataset, so they appear in
  the list but never on the map, and are excluded from pin numbering.
- Panning is clamped to Singapore — OneMap has no tiles beyond it.
- Leaflet is loaded via `next/dynamic` with `ssr: false`; it touches `window`
  at import time and will crash SSR otherwise.

## Known inaccuracies (deliberate, surfaced in the UI)

1. `isProbablyCentral()` in `src/lib/fees.ts` is a bounding box. Real HDB
   central-area status is a defined carpark list; misclassifying doubles the
   quoted fee. Replace with point-in-polygon against the URA Central Area
   boundary.
2. Shelter is inferred from structure type, never published.
3. Distances are straight-line without `ONEMAP_TOKEN`; true walking distance
   runs 20–40% longer in built-up areas.
4. Commercial rates come from a dataset last updated Jun 2024.
5. Rate schedule and GST are hardcoded policy values that change by
   announcement, not API-sourced.

### A caution from building this

The first rate parser read `"Daily: $1.30 / 30 Mins"` as $30 per minute and
quoted **$3,600** for two hours. It looked entirely plausible in a table. Free
text rate parsing needs sanity bounds and eyeballed worked examples, not just a
parse-success percentage.

## Deploying to a VPS

`next.config.ts` sets `output: "standalone"`, so the build emits a
self-contained server — the VPS does not need the full dependency tree.

```bash
npm ci && npm run build

# copy to the server:
#   .next/standalone/   (server + minimal node_modules)
#   .next/static/    -> .next/standalone/.next/static/
#   public/          -> .next/standalone/public/   (if you add one)

node .next/standalone/server.js     # listens on PORT, default 3000
```

Run it under systemd or pm2, and put a reverse proxy in front.

**HTTPS is not optional.** Home-screen install and browser geolocation both
require a secure origin, so the app will not be installable over plain HTTP.
Caddy is the least effort — it obtains and renews Let's Encrypt certificates
automatically:

```
carpark.yourdomain.com {
    reverse_proxy localhost:3000
}
```

## Installing on your phones

- **Android/Chrome**: open the site, then the "Install app" prompt (or menu →
  Add to Home screen). Creates a real launcher icon.
- **iPhone/Safari**: Share → Add to Home Screen. Must be Safari; Chrome on iOS
  cannot install PWAs.

Both launch full-screen with no browser chrome (`display: standalone`).

## Not yet built

- URA carpark rates (structured, better than the LTA free text) — needs an
  AccessKey and daily token.
- LTA DataMall availability for central malls — needs an AccountKey.
- Availability prediction. The history is queryable on demand, so no data
  collection infrastructure is needed — just the model.
- Offline support (service worker). Currently the app needs a connection.
- Geolocation "carparks near me", as an alternative to typing a destination.
