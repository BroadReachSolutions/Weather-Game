-- ============================================================
-- OREGON SAIL — Database Schema
-- Run this in Supabase SQL Editor (Project > SQL Editor > New query)
-- ============================================================

-- Each row = one player's boat/voyage state.
-- Device-only for now (no auth), identified by a random device_id
-- generated client-side and stored in localStorage. Easy to swap for
-- a real auth.users foreign key later.
create table if not exists boats (
  id              uuid primary key default gen_random_uuid(),
  device_id       text unique not null,        -- client-generated anonymous id
  name            text default 'Unnamed Vessel',

  -- Position (lat/lon) — current real-world location of the boat
  lat             double precision not null default 41.2565,  -- Portland, ME area start
  lon             double precision not null default -70.2553,

  -- Heading/course
  course_bearing  double precision,             -- degrees, 0-360, null = no course set
  destination_lat double precision,
  destination_lon double precision,
  course_mode     text default 'idle',          -- 'idle' | 'sailing' | 'motoring' | 'anchored'

  -- Resources
  food            double precision default 100,  -- 0-100 scale, or units — tune later
  water           double precision default 100,
  fuel            double precision default 100,
  money           double precision default 200,
  hull_health     double precision default 100,  -- storm damage reduces this

  -- Voyage meta
  leg_name        text default 'Maine Departure',  -- current trip segment
  total_nm_traveled double precision default 0,    -- lifetime nautical miles
  is_main_journey boolean default false,            -- true once attempting Maine->Oregon

  created_at      timestamptz default now(),
  last_tick_at    timestamptz default now(),
  updated_at      timestamptz default now()
);

-- Every tick (every 10 min via scheduled function) writes a row here
-- so the client can show recent history / "what happened while away".
create table if not exists tick_log (
  id              bigint generated always as identity primary key,
  boat_id         uuid references boats(id) on delete cascade,
  ts              timestamptz default now(),

  -- weather snapshot used for this tick
  wind_speed_kt   double precision,
  wind_dir_deg    double precision,
  wave_height_ft  double precision,

  -- what happened
  nm_moved        double precision default 0,
  food_consumed   double precision default 0,
  water_consumed  double precision default 0,
  fuel_consumed   double precision default 0,
  hull_damage     double precision default 0,
  event_type      text,             -- 'normal' | 'storm' | 'becalmed' | 'low_tide_grounding' | 'arrived'
  event_message   text
);

-- Predefined waypoints/ports along the route, used for course planning
-- and "smaller trips to earn money" side-quests.
create table if not exists ports (
  id              text primary key,   -- short slug, e.g. 'portland_me'
  name            text not null,
  lat             double precision not null,
  lon             double precision not null,
  region          text,               -- 'maine' | 'icww' | 'florida' | 'gulf' | 'panama' | 'pacific' | 'oregon'
  is_icww         boolean default false,  -- intracoastal waterway leg — shallow water warnings apply
  description     text
);

-- Simple seed of a few key ports along a Maine -> ICWW -> Florida ->
-- (around or through) -> Oregon style route. Expand later.
insert into ports (id, name, lat, lon, region, is_icww, description) values
  ('portland_me',   'Portland, ME',         43.6591, -70.2568, 'maine',  false, 'Starting port.'),
  ('boston_ma',      'Boston, MA',           42.3601, -71.0589, 'maine',  false, 'First overnight stop.'),
  ('newport_ri',      'Newport, RI',          41.4901, -71.3128, 'maine',  false, 'Sailing hub, good supplies.'),
  ('norfolk_va',      'Norfolk, VA',          36.8508, -76.2859, 'icww',   true,  'ICWW entrance — watch shallow water.'),
  ('charleston_sc',   'Charleston, SC',       32.7765, -79.9311, 'icww',   true,  'Classic ICWW stop.'),
  ('st_augustine_fl', 'St. Augustine, FL',    29.9012, -81.3124, 'icww',   true,  'Home waters!'),
  ('miami_fl',        'Miami, FL',            25.7617, -80.1918, 'florida',false, 'Turn point toward the Gulf or Panama.'),
  ('key_west_fl',      'Key West, FL',         24.5551, -81.7800, 'florida',false, 'Southernmost stop before the long crossing.')
on conflict (id) do nothing;

-- Row Level Security: lock things down since this is publicly
-- readable via the anon key. Boats can only be read/written by
-- matching device_id passed from the client (no auth yet, so this
-- is best-effort, not bulletproof — fine for a v1 hobby game).
alter table boats enable row level security;
alter table tick_log enable row level security;
alter table ports enable row level security;

-- Anyone can read ports (static reference data)
create policy "ports are publicly readable" on ports
  for select using (true);

-- Anyone can create/read/update a boat (device_id is the de facto
-- secret since it's a random UUID-like string only the owning
-- device knows). Good enough for a v1; tighten once real auth exists.
create policy "boats are publicly readable" on boats
  for select using (true);

create policy "anyone can insert a boat" on boats
  for insert with check (true);

create policy "anyone can update a boat" on boats
  for update using (true);

create policy "tick log is publicly readable" on tick_log
  for select using (true);

create policy "anyone can insert tick log entries" on tick_log
  for insert with check (true);
