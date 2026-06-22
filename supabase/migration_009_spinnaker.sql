-- Migration 009: spinnaker sail
alter table boats add column if not exists spinnaker_sail_area_sqft double precision default 0;
alter table boats add column if not exists spinnaker_furl_pct double precision default 0;
alter table boat_presets add column if not exists spinnaker_sail_area_sqft double precision default 0;
