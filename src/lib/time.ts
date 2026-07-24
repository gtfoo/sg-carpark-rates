/**
 * Singapore local time helpers.
 *
 * The VPS may well run in UTC, but every parking rule — the 07:00 and 22:30
 * boundaries, Sunday free parking, public holidays — is defined in Singapore
 * wall-clock time. Doing any of this with the server's local time would be
 * wrong for most of the day.
 *
 * Singapore is UTC+8 year round and has observed no daylight saving since
 * 1935, so a fixed offset is safe here and far less error-prone than
 * round-tripping through Intl for every boundary calculation.
 */
export const SGT_OFFSET_MIN = 8 * 60;

export interface SgtParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  /** 0 = Sunday, 6 = Saturday. */
  weekday: number;
  /** Minutes since local midnight. */
  minutesOfDay: number;
  /** YYYY-MM-DD in Singapore time. */
  isoDate: string;
}

export function toSgt(d: Date): SgtParts {
  const shifted = new Date(d.getTime() + SGT_OFFSET_MIN * 60_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();

  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: shifted.getUTCDay(),
    minutesOfDay: hour * 60 + minute,
    isoDate: `${year}-${pad(month)}-${pad(day)}`,
  };
}

/** Builds a Date from a Singapore wall-clock instant. */
export function fromSgt(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute) - SGT_OFFSET_MIN * 60_000,
  );
}

/** Current time, as Singapore wall clock. */
export function nowSgt(): SgtParts {
  return toSgt(new Date());
}

/**
 * Parses "YYYY-MM-DDTHH:mm" as Singapore local time.
 *
 * `new Date("2026-07-22T19:00")` would be interpreted in the *server's* zone,
 * which is the bug this exists to prevent.
 */
export function parseSgtLocal(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return fromSgt(Number(y), Number(mo), Number(d), Number(h), Number(mi));
}

/** Formats a Date as "YYYY-MM-DDTHH:mm" in Singapore time, for datetime-local. */
export function toSgtInputValue(d: Date): string {
  const p = toSgt(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatSgtTime(d: Date): string {
  const p = toSgt(d);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "am" : "pm";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[p.weekday]} ${h12}.${pad(p.minute)}${ampm}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
