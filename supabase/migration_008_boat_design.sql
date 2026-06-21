-- Migration 008: parametric 3D boat design ("DNA")
alter table boats add column if not exists hull_design jsonb default null;
alter table boat_presets add column if not exists hull_design jsonb default null;
