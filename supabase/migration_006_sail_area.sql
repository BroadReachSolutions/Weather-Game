-- Migration 006: split sail area into main/jib, add jib furl control
alter table boats add column if not exists main_sail_area_sqft double precision default 245;
alter table boats add column if not exists jib_sail_area_sqft double precision default 105;
alter table boats add column if not exists jib_furl_pct double precision default 100;
