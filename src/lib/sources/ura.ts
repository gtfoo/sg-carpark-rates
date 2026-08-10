import { svy21ToLatLng, type LatLng } from "../geo";

/**
 * URA Data Service — car park details WITH rates.
 *
 * Unlike the LTA/EPS sources this one is an official API returning structured
 * rates (amount + per-minutes, split by weekday/Saturday/Sunday-PH) plus
 * SVY21 coordinates, so nothing has to be scraped or geocoded.
 *
 * Auth is two-step: a long-lived AccessKey (emailed on registration at
 * https://eservice.ura.gov.sg/maps/api/reg.html) is exchanged for a DAILY
 * token, which is then sent alongside the key on every data call.
 *
 * Set URA_ACCESS_KEY in .env.local.
 */
const TOKEN_URL = "https://eservice.ura.gov.sg/uraDataService/insertNewToken/v1";
const DATA_URL = "https://eservice.ura.gov.sg/uraDataService/invokeUraDS/v1";

// URA rejects requests without a browser-like User-Agent.
const UA =
  "Mozilla/5.0 (compatible; carpark-sg/1.0; +https://github.com/gtfoo/carpark-sg)";

export function isUraConfigured(): boolean {
  return Boolean(process.env.URA_ACCESS_KEY);
}

let cachedToken: { token: string; day: string } | null = null;

/** Fetches (and day-caches) the daily access token. */
export async function getUraToken(): Promise<string> {
  const key = process.env.URA_ACCESS_KEY;
  if (!key) throw new Error("URA_ACCESS_KEY is not set.");

  const today = new Date().toISOString().slice(0, 10);
  if (cachedToken && cachedToken.day === today) return cachedToken.token;

  const res = await fetch(TOKEN_URL, {
    headers: { AccessKey: key, "User-Agent": UA },
  });
  if (!res.ok) {
    throw new Error(`URA token request failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    Status?: string;
    Message?: string;
    Result?: string;
  };
  if (!body.Result) {
    throw new Error(
      `URA token response had no Result (Status=${body.Status}, Message=${body.Message}).`,
    );
  }
  cachedToken = { token: body.Result, day: today };
  return body.Result;
}

/** One row as URA returns it — several rows per carpark (per vehicle category / time band). */
interface RawUraCarpark {
  ppCode?: string;
  ppName?: string;
  vehCat?: string;
  startTime?: string;
  endTime?: string;
  weekdayRate?: string;
  weekdayMin?: string;
  satdayRate?: string;
  satdayMin?: string;
  sunPHRate?: string;
  sunPHMin?: string;
  parkingSystem?: string;
  parkCapacity?: string;
  geometries?: { coordinates?: string }[];
}

export interface UraCarpark {
  code: string;
  name: string;
  location: LatLng | null;
  capacity: number | null;
  parkingSystem: string | null;
  /** Rate strings in the same shape the fee parser already understands. */
  weekdayRate: string | null;
  saturdayRate: string | null;
  sundayPhRate: string | null;
  /** Time band this rate applies to, e.g. "0700-1700" — kept for the notes. */
  band: string | null;
}

/**
 * "$0.60" + "30 mins" -> "$0.60 per 30 mins" (a form the rate parser handles).
 * URA's min field already carries the word "mins", so it is NOT re-appended.
 */
function rateString(amount?: string, minField?: string): string | null {
  const a = (amount ?? "").trim();
  const m = (minField ?? "").trim();
  if (!a) return null;
  if (/^\$?0(\.0+)?$/.test(a)) return "Free";
  const mins = parseInt(m, 10);
  if (!mins) return a;
  return `${a.startsWith("$") ? a : `$${a}`} per ${m}`;
}

/** URA time like "07.00 AM" / "05.00 PM" -> minutes since midnight. */
function parseUraTime(s?: string): number | null {
  const m = (s ?? "").trim().match(/(\d{1,2})\.(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1]!, 10) % 12;
  if (/pm/i.test(m[3]!)) h += 12;
  return h * 60 + parseInt(m[2]!, 10);
}

/** Does this band cover 1pm — the representative daytime parking hour? */
function coversMidday(r: RawUraCarpark): boolean {
  const s = parseUraTime(r.startTime);
  const e = parseUraTime(r.endTime);
  if (s === null || e === null || e <= s) return false; // ignore overnight-wrap bands
  const T = 13 * 60;
  return s <= T && T < e;
}

function blockMins(r: RawUraCarpark): number {
  return parseInt((r.weekdayMin ?? "").trim(), 10) || 0;
}

/**
 * Every band URA publishes for one car park, as one string the fee engine can
 * read: "08.30 AM-05.00 PM: $1.20 per 30 mins; 05.00 PM-10.00 PM: $0.60 per 30 mins".
 *
 * URA returns a row per time band, and this import used to keep only the band
 * covering 1pm — so all 660 car parks were priced at their midday rate at every
 * hour of the day, evenings and overnight included. bandForTime selects the
 * right band at query time instead, and URA's own clock format ("08.30 AM")
 * already matches the pattern it reads, so nothing needs reformatting.
 *
 * Bands are emitted in clock order, and identical text is emitted once: URA
 * repeats a band per vehicle category, and a duplicate would otherwise be read
 * as a second band saying the same thing.
 */
function bandedRate(
  rows: RawUraCarpark[],
  amount: (r: RawUraCarpark) => string | undefined,
  minField: (r: RawUraCarpark) => string | undefined,
): string | null {
  const ordered = [...rows].sort(
    (a, b) => (parseUraTime(a.startTime) ?? 0) - (parseUraTime(b.startTime) ?? 0),
  );
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const r of ordered) {
    const value = rateString(amount(r), minField(r));
    if (!value) continue;
    const from = (r.startTime ?? "").trim();
    const to = (r.endTime ?? "").trim();
    const range = from && to ? `${from}-${to}` : "";

    // URA publishes the overnight flat charge as a second row over the SAME
    // hours, with a block of 510 minutes — Angullia Park reads "$0.70 per 30
    // mins" and "$5.60 per 510 mins" for 10.30pm-7am. That second row is a cap
    // on the first, not a rate of its own: emitted as a band it would be dead
    // text, and a whole night would bill seventeen half-hours instead of
    // stopping at $5.60. parseLimits reads "capped at" and applies it.
    const block = parseInt((minField(r) ?? "").trim(), 10) || 0;
    if (block > 120 && range) {
      const at = parts.findIndex((p) => p.startsWith(`${range}:`));
      if (at >= 0) {
        const flat = (amount(r) ?? "").trim();
        parts[at] += ` (capped at ${flat.startsWith("$") ? flat : `$${flat}`})`;
        continue;
      }
    }

    // Without a clock range there is nothing to select on, so such a row can
    // only stand as the whole rate.
    const text = range ? `${range}: ${value}` : value;
    if (seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
  }
  return parts.length ? parts.join("; ") : null;
}

/**
 * Undoes the line-wrap URA ships inside ppName.
 *
 * Long names arrive with a space inserted at column ~22: mid-word it splits
 * the word ("ADAM RD FOOD CENTRE OF F ST", "JLN KEMBANG AN"), and on a word
 * gap it doubles the space ("QUEEN ST OFF  ST"). 112 of 660 names carried one,
 * and they've been visible on cards as-is ("HAMILTON R D - CAVAN RD").
 *
 * Because the corruption is positional it's mechanically reversible — no
 * dictionary needed. NOT idempotent: it must only run on raw feed names, never
 * on text that has already been repaired, or "PARK A OFF ST" loses a space.
 * Three shapes in the wrap zone (indices 21-23):
 *   double space        → the wrap fell on a real word gap; collapse it
 *   space-letter-space  → "…HAMILTON R D…": the first space was real, the
 *                         wrap inserted the second, after the letter
 *   lone space          → mid-word split; remove it
 */
export function dewrapName(raw: string): string {
  const s = raw.trim();
  if (s.length < 24) return s;
  const zone = [21, 22, 23].filter((i) => s[i] === " ");
  if (!zone.length) return s;
  const drop =
    zone.length >= 2 && zone[1]! - zone[0]! === 2 ? zone[1]! : zone[0]!;
  return (s.slice(0, drop) + s.slice(drop + 1)).trim();
}

/** URA returns SVY21 "x,y"; convert with the verified transform. */
function toLatLng(geometries?: { coordinates?: string }[]): LatLng | null {
  const raw = geometries?.[0]?.coordinates;
  if (!raw) return null;
  const [x, y] = raw.split(",").map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return svy21ToLatLng(x!, y!);
}

/**
 * Fetches car park details. URA returns one row per vehicle category and time
 * band; we keep Car rows and collapse to one record per car park (preferring
 * the band that covers the daytime, matching how the fee engine prices).
 */
export async function fetchUraCarparks(): Promise<UraCarpark[]> {
  const key = process.env.URA_ACCESS_KEY;
  if (!key) throw new Error("URA_ACCESS_KEY is not set.");
  const token = await getUraToken();

  const res = await fetch(`${DATA_URL}?service=Car_Park_Details`, {
    headers: { AccessKey: key, Token: token, "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`URA car park request failed: HTTP ${res.status}`);

  const body = (await res.json()) as {
    Status?: string;
    Message?: string;
    Result?: RawUraCarpark[];
  };
  if (!Array.isArray(body.Result)) {
    throw new Error(
      `URA response had no Result array (Status=${body.Status}, Message=${body.Message}).`,
    );
  }

  // URA returns one row per (vehicle category × time band). Group the Car rows
  // per carpark, then pick the band that covers 1pm — the representative
  // daytime rate — skipping free early/overnight bands and the 510-min
  // overnight-cap rows, which our single-weekday-rate model can't hold.
  const groups = new Map<string, RawUraCarpark[]>();
  for (const r of body.Result) {
    if (r.vehCat && !/^car$/i.test(r.vehCat.trim())) continue;
    const code = (r.ppCode ?? "").trim();
    if (!code) continue;
    let arr = groups.get(code);
    if (!arr) {
      arr = [];
      groups.set(code, arr);
    }
    arr.push(r);
  }

  const out: UraCarpark[] = [];
  for (const [code, rows] of groups) {
    const normal = (r: RawUraCarpark) => blockMins(r) > 0 && blockMins(r) <= 120;
    const pick =
      rows.find((r) => coversMidday(r) && normal(r)) ??
      rows.find((r) => normal(r)) ??
      rows[0]!;

    out.push({
      code,
      name: dewrapName(pick.ppName ?? code),
      location: toLatLng(pick.geometries),
      capacity: Number(pick.parkCapacity) || null,
      parkingSystem: pick.parkingSystem?.trim() || null,
      weekdayRate: bandedRate(rows, (r) => r.weekdayRate, (r) => r.weekdayMin),
      saturdayRate: bandedRate(rows, (r) => r.satdayRate, (r) => r.satdayMin),
      sundayPhRate: bandedRate(rows, (r) => r.sunPHRate, (r) => r.sunPHMin),
      band:
        pick.startTime && pick.endTime
          ? `${pick.startTime}-${pick.endTime}`
          : null,
    });
  }

  return out;
}
