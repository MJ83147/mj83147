-- Poker HoF schema (Cloudflare D1 / SQLite)
-- One row per player, one row per paired sitting, plus each player's hidden tables.

CREATE TABLE IF NOT EXISTS players (
  torn_id      INTEGER PRIMARY KEY,          -- authoritative, from /v2/user/profile
  name         TEXT    NOT NULL,
  image        TEXT,                          -- profile image url, null -> initials avatar
  visibility   TEXT    NOT NULL DEFAULT 'public',  -- public | hide$ | hidename | hidden
  start_mode   TEXT    NOT NULL DEFAULT 'all',      -- 'all' | 'date'
  start_date   INTEGER,                       -- epoch seconds when start_mode = 'date'
  last_sync    INTEGER,                       -- epoch seconds of last successful submit
  created_at   INTEGER NOT NULL
);

-- A sitting is one join paired with its leave. The primary key is the Torn
-- join log entry id, so re-syncing the same history can never double-count.
CREATE TABLE IF NOT EXISTS sittings (
  id           TEXT    PRIMARY KEY,           -- Torn join log entry id
  player_id    INTEGER NOT NULL,
  table_id     INTEGER NOT NULL,              -- raw Torn table id
  table_group  TEXT    NOT NULL,              -- merged variant name shown on boards
  buy_in       INTEGER NOT NULL,
  cash_out     INTEGER NOT NULL,
  net          INTEGER NOT NULL,              -- cash_out - buy_in
  join_time    INTEGER NOT NULL,              -- epoch seconds
  leave_time   INTEGER NOT NULL,              -- epoch seconds
  FOREIGN KEY (player_id) REFERENCES players(torn_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sittings_player ON sittings(player_id);
CREATE INDEX IF NOT EXISTS idx_sittings_group  ON sittings(table_group);

CREATE TABLE IF NOT EXISTS hidden_tables (
  player_id    INTEGER NOT NULL,
  table_group  TEXT    NOT NULL,
  PRIMARY KEY (player_id, table_group)
);
