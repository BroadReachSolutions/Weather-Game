-- Migration 011: navigation/deck lights, toggled from a DC-panel-style widget
alter table boats add column if not exists light_anchor boolean default false;
alter table boats add column if not exists light_nav boolean default false;
alter table boats add column if not exists light_steaming boolean default false;
alter table boats add column if not exists light_deck boolean default false;
alter table boats add column if not exists light_cockpit boolean default false;
