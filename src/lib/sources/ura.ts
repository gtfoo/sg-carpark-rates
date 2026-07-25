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
      name: (pick.ppName ?? code).trim(),
      location: toLatLng(pick.geometries),
      capacity: Number(pick.parkCapacity) || null,
      parkingSystem: pick.parkingSystem?.trim() || null,
      weekdayRate: rateString(pick.weekdayRate, pick.weekdayMin),
      saturdayRate: rateString(pick.satdayRate, pick.satdayMin),
      sundayPhRate: rateString(pick.sunPHRate, pick.sunPHMin),
      band:
        pick.startTime && pick.endTime
          ? `${pick.startTime}-${pick.endTime}`
          : null,
    });
  }

  return out;
}
