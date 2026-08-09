import { getDb } from "../db";

export type RateSource = "manual" | "operator-site" | "web-llm";
export type MatchType = "carpark_no" | "postal" | "name";

export interface RateOverride {
  id: number;
  matchType: MatchType;
  matchValue: string;
  displayName: string | null;
  /** Free text in the same shape as the LTA dataset, e.g. "$1.20 per half hour". */
  weekdayRate: string | null;
  /**
   * Friday, for the operators that price it with the weekend rather than the
   * working week. NULL means Friday bills as a weekday, which is the norm.
   */
  fridayRate: string | null;
  saturdayRate: string | null;
  sundayPhRate: string | null;
  source: RateSource;
  sourceUrl: string | null;
  /**
   * ISO date (YYYY-MM-DD) the rate was last true AT ITS SOURCE — not the day
   * this row was written. An importer that stamps its own run date makes every
   * rate look freshly checked, which is worse than no date at all: the age on
   * a card is part of how a driver judges the number. Null when the source
   * states no date of its own.
   */
  verifiedAt: string | null;
  notes: string | null;
  /** Coordinates, when known — enables proximity matching. */
  lat: number | null;
  lng: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RateOverrideInput {
  matchType: MatchType;
  matchValue: string;
  displayName?: string | null;
  weekdayRate?: string | null;
  fridayRate?: string | null;
  saturdayRate?: string | null;
  sundayPhRate?: string | null;
  source?: RateSource;
  sourceUrl?: string | null;
  verifiedAt: string | null;
  notes?: string | null;
  lat?: number | null;
  lng?: number | null;
}

interface Row {
  id: number;
  match_type: MatchType;
  match_value: string;
  display_name: string | null;
  weekday_rate: string | null;
  friday_rate: string | null;
  saturday_rate: string | null;
  sunday_ph_rate: string | null;
  source: RateSource;
  source_url: string | null;
  verified_at: string;
  notes: string | null;
  lat: number | null;
  lng: number | null;
  created_at: string;
  updated_at: string;
}

function toOverride(r: Row): RateOverride {
  return {
    id: r.id,
    matchType: r.match_type,
    matchValue: r.match_value,
    displayName: r.display_name,
    weekdayRate: r.weekday_rate,
    fridayRate: r.friday_rate,
    saturdayRate: r.saturday_rate,
    sundayPhRate: r.sunday_ph_rate,
    source: r.source,
    sourceUrl: r.source_url,
    verifiedAt: r.verified_at,
    notes: r.notes,
    lat: r.lat,
    lng: r.lng,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Normalizes a name for fuzzy matching — same rule as the search name matcher. */
function normalizeName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function listOverrides(): RateOverride[] {
  const rows = getDb()
    .prepare("SELECT * FROM rate_overrides ORDER BY updated_at DESC")
    .all() as Row[];
  return rows.map(toOverride);
}

export function upsertOverride(input: RateOverrideInput): RateOverride {
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO rate_overrides
       (match_type, match_value, display_name, weekday_rate, friday_rate,
        saturday_rate, sunday_ph_rate, source, source_url, verified_at, notes,
        lat, lng, created_at, updated_at)
     VALUES
       (@match_type, @match_value, @display_name, @weekday_rate, @friday_rate,
        @saturday_rate, @sunday_ph_rate, @source, @source_url, @verified_at,
        @notes, @lat, @lng, @now, @now)
     ON CONFLICT (match_type, match_value) DO UPDATE SET
       display_name   = @display_name,
       weekday_rate   = @weekday_rate,
       friday_rate    = @friday_rate,
       saturday_rate  = @saturday_rate,
       sunday_ph_rate = @sunday_ph_rate,
       source         = @source,
       source_url     = @source_url,
       verified_at    = @verified_at,
       notes          = @notes,
       -- Keep an existing coordinate if this update doesn't supply one.
       lat            = COALESCE(@lat, lat),
       lng            = COALESCE(@lng, lng),
       updated_at     = @now`,
  ).run({
    match_type: input.matchType,
    match_value:
      input.matchType === "name"
        ? normalizeName(input.matchValue)
        : input.matchValue.trim(),
    display_name: input.displayName ?? input.matchValue,
    weekday_rate: input.weekdayRate ?? null,
    friday_rate: input.fridayRate ?? null,
    saturday_rate: input.saturdayRate ?? null,
    sunday_ph_rate: input.sundayPhRate ?? null,
    source: input.source ?? "manual",
    source_url: input.sourceUrl ?? null,
    verified_at: input.verifiedAt,
    notes: input.notes ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    now,
  });

  const row = db
    .prepare(
      "SELECT * FROM rate_overrides WHERE match_type = ? AND match_value = ?",
    )
    .get(
      input.matchType,
      input.matchType === "name"
        ? normalizeName(input.matchValue)
        : input.matchValue.trim(),
    ) as Row;
  return toOverride(row);
}

export function deleteOverride(id: number): boolean {
  return getDb().prepare("DELETE FROM rate_overrides WHERE id = ?").run(id)
    .changes > 0;
}

/** Deletes overrides whose source URL matches a SQL LIKE pattern (for clean bulk re-imports). */
export function deleteOverridesBySourceUrlLike(pattern: string): number {
  return getDb()
    .prepare("DELETE FROM rate_overrides WHERE source_url LIKE ?")
    .run(pattern).changes;
}

/** Sets coordinates on an existing override (used by the backfill). */
export function setOverrideCoords(id: number, lat: number, lng: number): void {
  getDb()
    .prepare(
      "UPDATE rate_overrides SET lat = @lat, lng = @lng, updated_at = @now WHERE id = @id",
    )
    .run({ id, lat, lng, now: new Date().toISOString() });
}

/** All overrides that have coordinates — the candidates for proximity matching. */
export function listOverridesWithCoords(): RateOverride[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM rate_overrides WHERE lat IS NOT NULL AND lng IS NOT NULL",
    )
    .all() as Row[];
  return rows.map(toOverride);
}

/**
 * Best override for a specific HDB carpark, matched by its carpark number.
 * Manual data always wins over the published schedule.
 */
export function findOverrideForCarpark(carparkNo: string): RateOverride | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM rate_overrides WHERE match_type = 'carpark_no' AND match_value = ?",
    )
    .get(carparkNo) as Row | undefined;
  return row ? toOverride(row) : null;
}

/**
 * Best override for a destination (a building with its own parking that no
 * dataset covers — NTU@one-north, a condo, an office). Tries postal code first
 * (exact and unambiguous), then a normalized-name match.
 */
export function findOverrideForDestination(args: {
  postal: string | null;
  name: string;
}): RateOverride | null {
  const db = getDb();

  if (args.postal) {
    const byPostal = db
      .prepare(
        "SELECT * FROM rate_overrides WHERE match_type = 'postal' AND match_value = ?",
      )
      .get(args.postal) as Row | undefined;
    if (byPostal) return toOverride(byPostal);
  }

  const target = normalizeName(args.name);
  if (target.length > 3) {
    const names = db
      .prepare("SELECT * FROM rate_overrides WHERE match_type = 'name'")
      .all() as Row[];
    // match_value is already normalized at write time.
    const hit = names.find(
      (r) => r.match_value.includes(target) || target.includes(r.match_value),
    );
    if (hit) return toOverride(hit);
  }

  return null;
}
