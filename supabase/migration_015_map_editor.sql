-- Migration 015: Custom map regions (Map Editor)
-- Stores hand-drawn terrain (land/water classification grid) and
-- structure placements authored in the standalone Map Editor tool.
-- The live game's terrain system checks for a region here matching
-- the player's location/practice-area selection before falling back
-- to satellite-based procedural generation.

create table if not exists custom_map_regions (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Untitled Region',
  -- If set, this region appears at a real-world location; if null,
  -- it's a standalone practice area (like the marina) selectable by
  -- name rather than tied to GPS.
  anchor_lat double precision,
  anchor_lon double precision,
  -- The hand-painted land/water grid, same shape/format as
  -- terrain.js's satellite-derived classification grid: a 2D array
  -- of "land"/"water" strings, stored as jsonb.
  classification_grid jsonb not null,
  grid_size integer not null default 64,
  -- World size in real feet this grid spans (matches terrain.js's
  -- worldSize concept) -- the editor lets the author pick this.
  world_size_ft double precision not null default 2000,
  -- Structures placed by clicking rather than painted: array of
  -- { type, x, z, headingDeg, lengthFt } objects, x/z in grid-relative
  -- coordinates. type is one of the reused marina primitives for v1
  -- ("pier", "dock_spine", "fuel_dock").
  structures jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_custom_map_regions_anchor on custom_map_regions (anchor_lat, anchor_lon);
