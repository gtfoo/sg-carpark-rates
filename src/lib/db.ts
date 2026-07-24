import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Single SQLite connection for the app.
 *
 * Persistence matters here for a specific reason: these tables hold data that
 * is NOT re-derivable from an upstream API — rates you verified yourself, and
 * the log of destinations where no rate was found. The HDB carpark list and
 * live availability are deliberately NOT stored here; they come fresh from
 * data.gov.sg on every run, and persisting them would only add staleness.
 *
 * Override the path with CARPARK_DB_PATH on the VPS to point at a volume that
 * survives deploys.
 */
const DB_PATH =
  process.env.CARPARK_DB_PATH ?? join(process.cwd(), "data", "carpark.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  const handle = new Database(DB_PATH);
  // WAL lets reads proceed while a write is in flight — the search path reads
  // while the occasional rate entry writes.
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  migrate(handle);
  db = handle;
  return db;
}

function migrate(handle: Database.Database): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS rate_overrides (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type     TEXT NOT NULL CHECK (match_type IN ('carpark_no','postal','name')),
      match_value    TEXT NOT NULL,
      display_name   TEXT,
      weekday_rate   TEXT,
      saturday_rate  TEXT,
      sunday_ph_rate TEXT,
      source         TEXT NOT NULL DEFAULT 'manual'
                       CHECK (source IN ('manual','operator-site','web-llm')),
      source_url     TEXT,
      verified_at    TEXT NOT NULL,
      notes          TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      UNIQUE (match_type, match_value)
    );

    CREATE TABLE IF NOT EXISTS rate_gaps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      destination TEXT NOT NULL UNIQUE,
      postal      TEXT,
      lat         REAL,
      lng         REAL,
      first_seen  TEXT NOT NULL,
      last_seen   TEXT NOT NULL,
      hit_count   INTEGER NOT NULL DEFAULT 1,
      resolved    INTEGER NOT NULL DEFAULT 0
    );

    -- Last-known copy of slow-changing datasets (HDB carparks, LTA mall rates),
    -- so a transient data.gov.sg outage or rate-limit doesn't fail a search.
    CREATE TABLE IF NOT EXISTS dataset_cache (
      key        TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);

  // v2: the original rate_overrides CHECK only allowed manual/operator-site.
  // Rebuild it to also permit 'web-llm' (AI-retrieved rates). SQLite can't
  // alter a CHECK in place, so copy the rows through a new table.
  const version = handle.pragma("user_version", { simple: true }) as number;
  if (version < 2) {
    handle.exec(`
      BEGIN;
      CREATE TABLE rate_overrides_v2 (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        match_type     TEXT NOT NULL CHECK (match_type IN ('carpark_no','postal','name')),
        match_value    TEXT NOT NULL,
        display_name   TEXT,
        weekday_rate   TEXT,
        saturday_rate  TEXT,
        sunday_ph_rate TEXT,
        source         TEXT NOT NULL DEFAULT 'manual'
                         CHECK (source IN ('manual','operator-site','web-llm')),
        source_url     TEXT,
        verified_at    TEXT NOT NULL,
        notes          TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        UNIQUE (match_type, match_value)
      );
      INSERT INTO rate_overrides_v2 SELECT * FROM rate_overrides;
      DROP TABLE rate_overrides;
      ALTER TABLE rate_overrides_v2 RENAME TO rate_overrides;
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }

  // v3: give overrides coordinates so a saved rate can be matched by proximity
  // (e.g. show Terminal 1's carpark when searching Terminal 2), not just by an
  // exact name/postal match on the destination.
  if (version < 3) {
    handle.exec(`
      ALTER TABLE rate_overrides ADD COLUMN lat REAL;
      ALTER TABLE rate_overrides ADD COLUMN lng REAL;
      PRAGMA user_version = 3;
    `);
  }
}
