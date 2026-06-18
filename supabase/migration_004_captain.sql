-- Migration 004: captain and vessel naming
alter table boats add column if not exists captain_name text default '';
alter table boats add column if not exists vessel_name text default '';
