-- Migration 014: Electrical system Phase 3 - loads
-- New load toggles not already covered by existing boat columns
-- (lights, autopilot, engine itself are reused as-is). Each load
-- that draws from the house battery gets an enabled flag (boat
-- design choice), an on/off runtime state, and a rated watts value.
-- Bow thruster draws from its own dedicated battery per the original
-- design spec, not the house bank.

alter table boats add column if not exists has_radar boolean default false;
alter table boats add column if not exists load_radar_on boolean default false;
alter table boats add column if not exists radar_watts double precision default 35;

alter table boats add column if not exists has_fridge boolean default false;
alter table boats add column if not exists load_fridge_on boolean default false;
alter table boats add column if not exists fridge_watts double precision default 50;

alter table boats add column if not exists has_ac boolean default false;
alter table boats add column if not exists load_ac_on boolean default false;
alter table boats add column if not exists ac_watts double precision default 1200;

alter table boats add column if not exists has_watermaker boolean default false;
alter table boats add column if not exists load_watermaker_on boolean default false;
alter table boats add column if not exists watermaker_watts double precision default 550;
alter table boats add column if not exists watermaker_gph double precision default 8; -- gallons of fresh water produced per hour while running

alter table boats add column if not exists has_inverter boolean default false;
alter table boats add column if not exists load_inverter_on boolean default false;
alter table boats add column if not exists inverter_watts double precision default 20;

alter table boats add column if not exists has_electric_head boolean default false;
alter table boats add column if not exists load_electric_head_on boolean default false;
alter table boats add column if not exists electric_head_watts double precision default 20;

alter table boats add column if not exists has_instruments boolean default true;
alter table boats add column if not exists load_instruments_on boolean default true;
alter table boats add column if not exists instruments_watts_each double precision default 8;

alter table boats add column if not exists has_microwave boolean default false;
alter table boats add column if not exists load_microwave_on boolean default false;
alter table boats add column if not exists microwave_watts double precision default 1100;

alter table boats add column if not exists has_cooktop boolean default false;
alter table boats add column if not exists load_cooktop_on boolean default false;
alter table boats add column if not exists cooktop_watts double precision default 1800;

alter table boats add column if not exists has_vhf boolean default true;
alter table boats add column if not exists load_vhf_on boolean default true;
alter table boats add column if not exists vhf_watts double precision default 5;

alter table boats add column if not exists has_ais boolean default false;
alter table boats add column if not exists load_ais_on boolean default false;
alter table boats add column if not exists ais_watts double precision default 4;

alter table boats add column if not exists has_bilge_pump boolean default true;
alter table boats add column if not exists load_bilge_pump_on boolean default false;
alter table boats add column if not exists bilge_pump_watts double precision default 45;

alter table boats add column if not exists has_fans boolean default false;
alter table boats add column if not exists load_fans_on boolean default false;
alter table boats add column if not exists fans_watts double precision default 15;

alter table boats add column if not exists has_cabin_lights boolean default true;
alter table boats add column if not exists load_cabin_lights_on boolean default false;
alter table boats add column if not exists cabin_lights_watts double precision default 15;

alter table boats add column if not exists has_bow_thruster boolean default false;
alter table boats add column if not exists load_bow_thruster_on boolean default false;
alter table boats add column if not exists bow_thruster_watts double precision default 2500;
