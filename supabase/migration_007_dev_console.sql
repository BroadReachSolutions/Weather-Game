-- Migration 007: developer mode flag + boat presets + global app config

-- Marks a boat's owner as having developer access. Set automatically
-- when captain_name and vessel_name are both "Sonic" (case-insensitive),
-- checked client-side at login -- this column just persists the flag
-- so it survives reloads without re-checking the name every time.
alter table boats add column if not exists is_developer boolean default false;

-- Reusable vessel presets the dev console can create/edit, separate
-- from any individual player's boat row. New players pick from these
-- at the main menu (currently only one hardcoded "cruiser" preset
-- exists in the client; this table lets the dev add/edit more
-- without a code deploy).
create table if not exists boat_presets (
  id uuid primary key default gen_random_uuid(),
  preset_key text unique not null,         -- short slug, e.g. "cruiser", "daysailer"
  display_name text not null,
  icon text default '🛥',
  description text default '',
  hull_speed_kt double precision default 6.5,
  rated_wind_mph double precision default 15,
  reef_wind_limits_mph double precision[] default array[25, 30, 35],
  reef_speed_penalty double precision[] default array[1.0, 0.85, 0.65],
  boat_weight_class text default 'medium',
  main_sail_area_sqft double precision default 245,
  jib_sail_area_sqft double precision default 105,
  sort_order integer default 0,
  is_active boolean default true,          -- inactive presets are hidden from the main menu but kept for reference
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Single-row table holding global UI/theme defaults the dev can
-- change for everyone at once (colors, default layout, feature
-- toggles, etc) without a code deploy. The app reads this on load.
create table if not exists app_config (
  id integer primary key default 1,
  config jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  constraint single_row check (id = 1)
);
insert into app_config (id, config) values (1, '{}'::jsonb) on conflict (id) do nothing;

-- Seed the one existing hardcoded preset so the table isn't empty
insert into boat_presets (preset_key, display_name, icon, description, hull_speed_kt, rated_wind_mph, sort_order)
values ('cruiser', 'Island Packet 380', '🛥', 'A blue-water cruiser built for offshore passages. Stiff, seaworthy, forgiving in heavy weather.', 7.2, 15, 0)
on conflict (preset_key) do nothing;

-- Row Level Security — permissive policies matching the rest of this
-- single-developer game's setup (no real user auth system yet, so
-- the anon key needs full read/write access). Revisit once real
-- player accounts exist.
alter table boat_presets enable row level security;
drop policy if exists "boat_presets_anon_all" on boat_presets;
create policy "boat_presets_anon_all" on boat_presets
  for all using (true) with check (true);

alter table app_config enable row level security;
drop policy if exists "app_config_anon_all" on app_config;
create policy "app_config_anon_all" on app_config
  for all using (true) with check (true);
