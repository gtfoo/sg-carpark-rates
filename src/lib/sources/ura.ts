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

/** "$1.20" + "30" -> "$1.20 per 30 mins" (a form the rate parser handles). */
function rateString(amount?: string, mins?: string): string | null {
  const a = (amount ?? "").trim();
  const m = (mins ?? "").trim();
  if (!a || a === "0" || a === "$0.00") return a === "$0.00" || a === "0" ? "Free" : null;
  if (!m) return a;
  return `${a.startsWith("$") ? a : `$${a}`} per ${m} mins`;
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

  const byCode = new Map<string, UraCarpark>();
  for (const r of body.Result) {
    // Cars only — URA also lists motorcycle and heavy-vehicle rates.
    if (r.vehCat && !/^car$/i.test(r.vehCat.trim())) continue;
    const code = (r.ppCode ?? "").trim();
    if (!code) continue;

    const band =
      r.startTime && r.endTime ? `${r.startTime}-${r.endTime}` : null;
    const record: UraCarpark = {
      code,
      name: (r.ppName ?? code).trim(),
      location: toLatLng(r.geometries),
      capacity: Number(r.parkCapacity) || null,
      parkingSystem: r.parkingSystem?.trim() || null,
      weekdayRate: rateString(r.weekdayRate, r.weekdayMin),
      saturdayRate: rateString(r.satdayRate, r.satdayMin),
      sundayPhRate: rateString(r.sunPHRate, r.sunPHMin),
      band,
    };

    // Keep the first row with a usable weekday rate; otherwise keep whatever
    // we have so the carpark still appears.
    const existing = byCode.get(code);
    if (!existing || (!existing.weekdayRate && record.weekdayRate)) {
      byCode.set(code, record);
    }
  }

  return [...byCode.values()];
}
