import { getDb } from "../db";

/**
 * A durable last-known copy of a slow-changing dataset. This is a resilience
 * fallback, NOT the primary cache — live data is still fetched every run; this
 * only kicks in when the upstream fetch fails, so a data.gov.sg rate-limit or
 * outage degrades to slightly-stale data instead of a failed search.
 */
export function writeCache<T>(key: string, data: T): void {
  getDb()
    .prepare(
      `INSERT INTO dataset_cache (key, json, fetched_at)
       VALUES (@key, @json, @now)
       ON CONFLICT (key) DO UPDATE SET json = @json, fetched_at = @now`,
    )
    .run({ key, json: JSON.stringify(data), now: new Date().toISOString() });
}

export function readCache<T>(key: string): { data: T; fetchedAt: string } | null {
  const row = getDb()
    .prepare("SELECT json, fetched_at FROM dataset_cache WHERE key = ?")
    .get(key) as { json: string; fetched_at: string } | undefined;
  if (!row) return null;
  try {
    return { data: JSON.parse(row.json) as T, fetchedAt: row.fetched_at };
  } catch {
    return null;
  }
}
