-- Migration 013: Electrical system Phase 2 - generation sources
-- Solar (bell-curve day model), wind generator (scales with rated
-- watts and real wind speed), generator (rated output + fuel
-- consumption), and the engine alternator. All feed the house
-- battery bank per the original design spec.

alter table boats add column if not exists has_solar boolean default false;
alter table boats add column if not exists solar_rated_watts double precision default 150;

alter table boats add column if not exists has_wind_generator boolean default false;
alter table boats add column if not exists wind_generator_rated_watts double precision default 300;

alter table boats add column if not exists has_generator boolean default false;
alter table boats add column if not exists generator_rated_watts double precision default 2000;
alter table boats add column if not exists generator_running boolean default false;
alter table boats add column if not exists generator_fuel_consumption_gph double precision default 0.14;

alter table boats add column if not exists has_alternator boolean default true;
alter table boats add column if not exists alternator_rated_watts double precision default 1200;

-- Mirror onto boat_presets so new boat types can ship with their own
-- generation configuration baked in.
alter table boat_presets add column if not exists has_solar boolean default false;
alter table boat_presets add column if not exists solar_rated_watts double precision default 150;
alter table boat_presets add column if not exists has_wind_generator boolean default false;
alter table boat_presets add column if not exists wind_generator_rated_watts double precision default 300;
alter table boat_presets add column if not exists has_generator boolean default false;
alter table boat_presets add column if not exists generator_rated_watts double precision default 2000;
alter table boat_presets add column if not exists generator_fuel_consumption_gph double precision default 0.14;
alter table boat_presets add column if not exists has_alternator boolean default true;
alter table boat_presets add column if not exists alternator_rated_watts double precision default 1200;
