-- Migration 005: rudder/autopilot steering system
alter table boats add column if not exists rudder_angle double precision default 0;
alter table boats add column if not exists autopilot_on boolean default true;
