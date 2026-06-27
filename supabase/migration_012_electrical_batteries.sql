-- Migration 012: Electrical system Phase 1 - batteries
-- Four battery roles: start, house (bank), generator-start, bow-thruster.
-- Real watt-hour capacity + live charge state for each, with an enabled
-- flag per slot so boats can be designed with or without each one.

alter table boats add column if not exists has_start_battery boolean default true;
alter table boats add column if not exists start_battery_capacity_wh double precision default 800;
alter table boats add column if not exists start_battery_charge_wh double precision default 800;

alter table boats add column if not exists has_house_battery boolean default true;
alter table boats add column if not exists house_battery_bank_count integer default 1;
alter table boats add column if not exists house_battery_capacity_wh double precision default 1200;
alter table boats add column if not exists house_battery_charge_wh double precision default 1200;

alter table boats add column if not exists has_generator_battery boolean default false;
alter table boats add column if not exists generator_battery_capacity_wh double precision default 500;
alter table boats add column if not exists generator_battery_charge_wh double precision default 500;

alter table boats add column if not exists has_bow_thruster_battery boolean default false;
alter table boats add column if not exists bow_thruster_battery_capacity_wh double precision default 900;
alter table boats add column if not exists bow_thruster_battery_charge_wh double precision default 900;

-- Mirror the same slot toggles + default capacities onto boat_presets,
-- so new boat types created in the dev console can ship with their own
-- electrical configuration baked in.
alter table boat_presets add column if not exists has_start_battery boolean default true;
alter table boat_presets add column if not exists start_battery_capacity_wh double precision default 800;
alter table boat_presets add column if not exists has_house_battery boolean default true;
alter table boat_presets add column if not exists house_battery_bank_count integer default 1;
alter table boat_presets add column if not exists house_battery_capacity_wh double precision default 1200;
alter table boat_presets add column if not exists has_generator_battery boolean default false;
alter table boat_presets add column if not exists generator_battery_capacity_wh double precision default 500;
alter table boat_presets add column if not exists has_bow_thruster_battery boolean default false;
alter table boat_presets add column if not exists bow_thruster_battery_capacity_wh double precision default 900;
