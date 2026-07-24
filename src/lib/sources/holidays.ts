import { fetchAllRecords } from "./datagov";

/** MOM's consolidated Singapore public holiday list, 2020 onwards. */
const PUBLIC_HOLIDAYS = "d_8ef23381f9417e4d4254ee8b4dcdb176";

interface RawHoliday {
  date: string; // YYYY-MM-DD
  day: string;
  holiday: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
let cache: { at: number; byDate: Map<string, string> } | null = null;

/**
 * Public holidays matter twice over: most HDB carparks are free on Sundays
 * AND public holidays, and commercial carparks bill public holidays at the
 * Sunday rate. Getting this wrong quotes a fee for parking that is free.
 */
export async function getPublicHolidays(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < DAY_MS) return cache.byDate;

  try {
    const rows = await fetchAllRecords<RawHoliday>(PUBLIC_HOLIDAYS);
    const byDate = new Map<string, string>();
    for (const r of rows) {
      if (r.date) byDate.set(r.date.trim(), r.holiday);
    }
    cache = { at: Date.now(), byDate };
    return byDate;
  } catch (err) {
    console.error("public holiday fetch failed", err);
    // Fall back to an empty set rather than failing the search. The effect is
    // that a public holiday is treated as a normal weekday — an overestimate
    // of cost, never an underestimate.
    return cache?.byDate ?? new Map();
  }
}

export async function isPublicHoliday(isoDate: string): Promise<boolean> {
  return (await getPublicHolidays()).has(isoDate);
}
