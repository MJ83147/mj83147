-- Mystery Bounty tournament schema (Cloudflare D1 / SQLite)
-- Bound as env.MB in the Pages Function. Money is stored as INTEGER Torn dollars.
-- Apply with:
--   wrangler d1 execute mystery-bounty --local  --file=mystery-bounty/schema.sql
--   wrangler d1 execute mystery-bounty --remote --file=mystery-bounty/schema.sql

-- ---------- key/value settings (admin-editable config numbers) ----------
-- Single source of truth for every tunable number. The bounty POOL totals are
-- NOT stored here; they are computed from participant counts x the bounty
-- portions below, so admins can never hand-edit the pool.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('event_name',        'Mystery Bounty'),
  ('tournament_status', 'setup'),      -- setup | day1 | rebuy | day2 | final | money | complete
  ('roster_locked',     '0'),
  ('entry_total',       '50000000'),
  ('rebuy_total',       '75000000'),
  ('main_pct',          '60'),         -- % of each buy-in/rebuy to the main pot
  ('bounty_pct',        '40'),         -- % to the bounty envelopes
  ('day1_table_min',    '4'),
  ('day1_table_max',    '6'),
  ('rebuy_table_min',   '2'),
  ('rebuy_table_max',   '3'),
  ('day2_table_min',    '6'),
  ('day2_table_max',    '9'),
  ('day2_table_count',  '3'),
  ('day2_advance',      '3'),          -- top N per Day 2 table advance to the final
  ('day2_to_money',     '2'),          -- next N per Day 2 table drop to the money table (e.g. 2 = 4th & 5th)
  ('final_table_size',  '9'),
  ('day1_share_pct',    '10'),         -- share of the bounty pool for Day 1 envelopes
  ('day2_share_pct',    '55'),         -- share of the bounty pool for Day 2 envelopes
  ('final_share_pct',   '35'),         -- share of the bounty pool for the final table envelopes
  ('money_table_enabled','1'),
  ('payout_structure',  '[30,20,14,10,8,6,5,4,3]'),  -- % of main pool per place
  ('avail_phase',       'day1'),       -- which stage the availability poll is collecting for (day1|rebuy|day2|final|closed)
  ('pay_to',            'weedpsycho'), -- who buy-ins/rebuys are sent to
  ('day2_date',         ''),
  ('final_date',        '');

-- ---------- admins (login allowlist, Torn ids) ----------
CREATE TABLE IF NOT EXISTS admins (
  torn_id    INTEGER PRIMARY KEY,
  name       TEXT,
  created_at INTEGER
);
INSERT OR IGNORE INTO admins (torn_id, name) VALUES
  (2763892, 'Admin'),
  (3583736, 'Admin');

-- ---------- players (roster, admin-managed) ----------
CREATE TABLE IF NOT EXISTS players (
  torn_id     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | eliminated | champion
  current_loc TEXT,                              -- day1 | rebuy | day2 | final | money (denormalised "where")
  rebuy_paid  INTEGER NOT NULL DEFAULT 0,        -- admin "confirm paid" sets this
  stage_out   TEXT,                              -- deepest stage reached when eliminated
  created_at  INTEGER NOT NULL
);

-- ---------- donations (split main/bounty like a buy-in) ----------
CREATE TABLE IF NOT EXISTS donations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_name TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);

-- ---------- tables (every physical table across all stages) ----------
CREATE TABLE IF NOT EXISTS tables (
  id            TEXT PRIMARY KEY,                -- e.g. 'day1-t3', 'day2-t1', 'final', 'money', 'rebuy-t2'
  stage         TEXT NOT NULL,                   -- day1 | rebuy | day2 | final | money
  label         TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued | live | complete
  seat_size     INTEGER,
  seating_mode  TEXT NOT NULL DEFAULT 'assigned',-- assigned | claim (first-come-first-served)
  bounties_live INTEGER NOT NULL DEFAULT 0,      -- 1 for day1/day2/final, 0 for rebuy/money
  timeslot      TEXT,                            -- TCT time string
  steward_id    INTEGER,                         -- assigned steward torn_id
  envelope_total INTEGER NOT NULL DEFAULT 0,     -- max total of this table's envelope list (day2/final)
  sort_no       INTEGER,
  created_at    INTEGER NOT NULL
);

-- player <-> table seating (a join; supports both assigned and FCFS-claim modes)
CREATE TABLE IF NOT EXISTS table_seats (
  table_id  TEXT NOT NULL,
  torn_id   INTEGER NOT NULL,
  seat_no   INTEGER,
  claimed   INTEGER NOT NULL DEFAULT 0,          -- 1 if the player claimed this seat themselves
  PRIMARY KEY (table_id, torn_id)
);

-- ---------- per-table finishing order (steward result reporting) ----------
CREATE TABLE IF NOT EXISTS placings (
  table_id    TEXT NOT NULL,
  place       INTEGER NOT NULL,                  -- 1..N within the table
  torn_id     INTEGER NOT NULL,
  advanced_to TEXT,                              -- day2 | final | money | null (out)
  recorded_at INTEGER,
  PRIMARY KEY (table_id, place)
);

-- ---------- overall finishing places (final + money tables) ----------
CREATE TABLE IF NOT EXISTS final_places (
  place       INTEGER PRIMARY KEY,               -- 1..12 overall (final 1-9, money 10-12)
  torn_id     INTEGER NOT NULL,
  prize       INTEGER,                           -- main-pool payout, computed on report
  recorded_at INTEGER
);

-- ---------- envelopes: the sealed sequential bounty list per bounty table ----------
CREATE TABLE IF NOT EXISTS envelopes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id TEXT NOT NULL,
  seq      INTEGER NOT NULL,                     -- 1,2,3... draw order (no player choice)
  amount   INTEGER NOT NULL,
  opened   INTEGER NOT NULL DEFAULT 0,           -- 0 sealed, 1 claimed
  UNIQUE (table_id, seq)
);

-- ---------- knockouts: who busted whom, which envelope, how much ----------
CREATE TABLE IF NOT EXISTS knockouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id      TEXT NOT NULL,
  seq           INTEGER NOT NULL,                -- bust order within the table (drives the replay)
  eliminated_id INTEGER NOT NULL,
  eliminator_id INTEGER NOT NULL,                -- claims the envelope cash (the bounty)
  envelope_id   INTEGER,
  amount        INTEGER NOT NULL DEFAULT 0,      -- copied from envelope for fast leaderboard sums
  recorded_at   INTEGER NOT NULL,
  reported_by   INTEGER
);

-- ---------- stewards (server-side login allowlist, managed by admins) ----------
CREATE TABLE IF NOT EXISTS stewards (
  torn_id    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER
);
-- The two organisers are stewards by default (also admins via the allowlist).
INSERT OR IGNORE INTO stewards (torn_id, name, active) VALUES
  (2763892, 'weedpsycho', 1),
  (3583736, 'systoned', 1);

CREATE TABLE IF NOT EXISTS steward_availability (
  steward_id INTEGER NOT NULL,
  slot_id    TEXT NOT NULL,
  PRIMARY KEY (steward_id, slot_id)
);

-- ---------- player availability poll (public) ----------
CREATE TABLE IF NOT EXISTS availability (
  torn_id      INTEGER NOT NULL,
  phase        TEXT NOT NULL,                    -- day2 | final
  slot_id      TEXT NOT NULL,
  fingerprint  TEXT,                             -- browser id -> shared-browser detection
  submitted_at INTEGER,
  PRIMARY KEY (torn_id, phase, slot_id)
);

CREATE INDEX IF NOT EXISTS idx_seats_table    ON table_seats(table_id);
CREATE INDEX IF NOT EXISTS idx_seats_player   ON table_seats(torn_id);
CREATE INDEX IF NOT EXISTS idx_env_table      ON envelopes(table_id);
CREATE INDEX IF NOT EXISTS idx_ko_elim        ON knockouts(eliminator_id);
CREATE INDEX IF NOT EXISTS idx_ko_table       ON knockouts(table_id);
-- one knockout per draw slot per table: blocks a concurrent double-open
CREATE UNIQUE INDEX IF NOT EXISTS uq_ko_table_seq ON knockouts(table_id, seq);
CREATE INDEX IF NOT EXISTS idx_placings_player ON placings(torn_id);
CREATE INDEX IF NOT EXISTS idx_avail_phase    ON availability(phase);
