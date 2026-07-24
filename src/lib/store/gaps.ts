import { getDb } from "../db";

export interface RateGap {
  id: number;
  destination: string;
  postal: string | null;
  lat: number | null;
  lng: number | null;
  firstSeen: string;
  lastSeen: string;
  hitCount: number;
  resolved: boolean;
}

interface Row {
  id: number;
  destination: string;
  postal: string | null;
  lat: number | null;
  lng: number | null;
  first_seen: string;
  last_seen: string;
  hit_count: number;
  resolved: number;
}

function toGap(r: Row): RateGap {
  return {
    id: r.id,
    destination: r.destination,
    postal: r.postal,
    lat: r.lat,
    lng: r.lng,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    hitCount: r.hit_count,
    resolved: r.resolved === 1,
  };
}

/**
 * Records that a destination was searched but had no rate for its own parking.
 * Idempotent per destination — repeats bump hit_count so the places you visit
 * most float to the top of the fill-in list.
 */
export function recordGap(args: {
  destination: string;
  postal: string | null;
  lat: number | null;
  lng: number | null;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO rate_gaps (destination, postal, lat, lng, first_seen, last_seen, hit_count)
       VALUES (@destination, @postal, @lat, @lng, @now, @now, 1)
       ON CONFLICT (destination) DO UPDATE SET
         last_seen = @now,
         hit_count = hit_count + 1,
         postal    = COALESCE(rate_gaps.postal, @postal),
         lat       = COALESCE(rate_gaps.lat, @lat),
         lng       = COALESCE(rate_gaps.lng, @lng)`,
    )
    .run({ ...args, now });
}

export function listGaps(includeResolved = false): RateGap[] {
  const sql = includeResolved
    ? "SELECT * FROM rate_gaps ORDER BY hit_count DESC, last_seen DESC"
    : "SELECT * FROM rate_gaps WHERE resolved = 0 ORDER BY hit_count DESC, last_seen DESC";
  return (getDb().prepare(sql).all() as Row[]).map(toGap);
}

/** Marks a gap resolved (call this after adding a rate that covers it). */
export function resolveGap(id: number): boolean {
  return (
    getDb().prepare("UPDATE rate_gaps SET resolved = 1 WHERE id = ?").run(id)
      .changes > 0
  );
}

/**
 * Resolves any gap whose destination normalizes to the same name, so adding a
 * rate for "NTU@one-north" clears the gap logged when you searched it.
 */
export function resolveGapsByName(name: string): number {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const target = norm(name);
  const rows = getDb()
    .prepare("SELECT id, destination FROM rate_gaps WHERE resolved = 0")
    .all() as { id: number; destination: string }[];
  let count = 0;
  for (const r of rows) {
    const d = norm(r.destination);
    if (d.includes(target) || target.includes(d)) {
      resolveGap(r.id);
      count++;
    }
  }
  return count;
}
