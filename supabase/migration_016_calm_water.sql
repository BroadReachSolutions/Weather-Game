-- Migration 016: calm water flag for custom map regions
-- calm_grid is a parallel boolean grid (same shape as
-- classification_grid) marking which WATER cells should be flat/
-- wave-suppressed. Calm is a flag on regular water, not a separate
-- cell type, per request.

alter table custom_map_regions add column if not exists calm_grid jsonb not null default '[]'::jsonb;
