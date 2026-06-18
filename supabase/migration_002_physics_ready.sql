-- ============================================================
-- Oregon Sail — Migration 002: Physics-ready boat state
-- Run this in the Supabase SQL Editor (after schema.sql).
--
-- Splits the old single course_mode string into independent
-- engine and sailing state, and adds boat attributes + a flexible
-- perks column so the full physics system (wind, trim, reefing,
-- hull speed, currents, crew bonuses) can be built incrementally
-- without further schema churn.
-- ============================================================

-- Engine state — independent of sailing now
alter table boats add column if not exists engine_on boolean default false;
alter table boats add column if not exists throttle_rpm double precision default 800;  -- 800 idle .. 3200 max
alter table boats add column if not exists engine_gear text default 'neutral';          -- 'forward' | 'neutral' | 'reverse'

-- Sailing state
alter table boats add column if not exists boom_angle double precision default 25;      -- -90..90, port/starboard
alter table boats add column if not exists reef_level integer default 0;                -- 0=full sail, 1/2=reefed
alter table boats add column if not exists sailing_active boolean default false;         -- sails up/trimming, independent of engine

-- Boat attributes (static per-vessel, used in the speed formula)
alter table boats add column if not exists hull_speed_kt double precision default 6.5;   -- theoretical max hull speed
alter table boats add column if not exists boat_weight_class text default 'medium';      -- 'light' | 'medium' | 'heavy'
alter table boats add column if not exists sail_area_sqft double precision default 350;

-- Flexible perks/bonuses — crew, upgrades, etc. Example shape:
-- {"speed_boost_pct": 5, "fuel_efficiency_pct": 10, "crew": ["navigator","cook"]}
alter table boats add column if not exists perks jsonb default '{}'::jsonb;

-- Live speed readout (written by the tick function, read by the
-- speed gauge — avoids recalculating from scratch on every page load)
alter table boats add column if not exists speed_over_ground_kt double precision default 0;

-- Drop the old single-mode column's NOT NULL constraint usage in
-- favor of the new independent flags, but keep the column itself
-- for backward compatibility during the transition (idle/anchored
-- still make sense as overall states; sailing/motoring are now
-- derived from sailing_active + engine_on instead of being the
-- sole source of truth).
comment on column boats.course_mode is
  'Legacy: idle | sailing | motoring | anchored. Being superseded by sailing_active + engine_on, kept for now during transition.';
