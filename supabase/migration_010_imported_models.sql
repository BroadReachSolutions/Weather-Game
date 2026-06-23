-- Migration 010: imported 3D model support alongside procedural boats
alter table boats add column if not exists model_url text default null;
alter table boat_presets add column if not exists model_url text default null;
