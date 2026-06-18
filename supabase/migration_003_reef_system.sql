-- ============================================================
-- Oregon Sail — Migration 003: Reef thresholds + rated sailing conditions
-- Run after migration_002_physics_ready.sql.
--
-- Adds the per-boat-type attributes needed for the sail speed
-- formula: the wind speed (and point-of-sail) a boat is "rated"
-- to hit its hull speed at, plus safe wind ceilings for each reef
-- level. Going over your current reef level's ceiling risks damage;
-- reefing below the wind speed it's rated for costs some speed but
-- reduces that risk.
-- ============================================================

-- Wind speed (mph) at which this boat achieves hull_speed_kt under
-- full sail, assuming a perfect point of sail / perfect trim.
alter table boats add column if not exists rated_wind_mph double precision default 15;

-- Safe wind ceiling (mph) for each reef level. Index 0 = full sail,
-- 1 = first reef, 2 = second reef. Stored as an array so boats can
-- have more or fewer reef points without another migration.
alter table boats add column if not exists reef_wind_limits_mph double precision[] default array[25, 30, 35];

-- Speed penalty multiplier applied per reef level when wind is
-- BELOW that level's ceiling (i.e. you reefed more than needed —
-- safer, but slower). 1.0 = no penalty, 0.85 = 15% slower, etc.
alter table boats add column if not exists reef_speed_penalty double precision[] default array[1.0, 0.85, 0.65];

comment on column boats.rated_wind_mph is
  'Wind speed (mph) at which this boat hits hull_speed_kt under full sail with perfect trim/point-of-sail.';
comment on column boats.reef_wind_limits_mph is
  'Safe wind ceiling per reef level [full_sail, reef1, reef2, ...]. Exceeding the current level''s limit risks damage.';
comment on column boats.reef_speed_penalty is
  'Speed multiplier per reef level when wind is below that level''s ceiling (reefing more than needed costs speed).';
