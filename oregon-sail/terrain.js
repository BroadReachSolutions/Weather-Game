/* ============================================================
   Oregon Sail — Terrain Generation
   On-demand procedural terrain from real satellite imagery. This is
   NOT a pre-built map of anywhere — it's a pure pipeline that takes
   the player's current real lat/lon and generates 3D land geometry
   for the area around them, the same way the existing chart
   plotter's satellite tile grid refreshes as the player moves
   (every ~6nm) rather than loading "the whole world" up front.

   PIPELINE: fetch tile -> classify pixels (land/water by color) ->
   build a heightmap -> generate real THREE.js geometry from it ->
   position/scale it against the player's real lat/lon, using the
   same UNITS_PER_FOOT conversion the rest of the 3D scene uses.

   Phase 1 scope: generates the land mesh and places it correctly.
   Collision detection and shoreline breaking waves are separate,
   later phases — this module only builds the geometry.
   ============================================================ */

(function () {
  /* Standard slippy-map tile math (the same convention used by
     virtually every web tile service, including the ArcGIS source
     we already use for the chart plotter) — converts a real lat/lon
     into which tile image covers that point at a given zoom level. */
  function latLonToTile(lat, lon, zoom) {
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lon + 180) / 360) * n);
    const y = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );
    return { x, y, zoom };
  }

  /* Inverse: top-left lat/lon corner of a given tile, used to figure
     out how a sampled pixel within the tile maps back to a real
     lat/lon (and from there, to our scene's world X/Z via the
     existing UNITS_PER_FOOT/haversine conventions). */
  function tileToLatLon(x, y, zoom) {
    const n = Math.pow(2, zoom);
    const lon = (x / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const lat = (latRad * 180) / Math.PI;
    return { lat, lon };
  }

  const TILE_SIZE_PX = 256; /* standard tile image size for this tile service */

  /* Fetches one satellite tile image and returns it loaded onto an
     offscreen canvas we can read pixel data from. Uses the same
     ArcGIS World Imagery source already configured in the CSP for
     the chart plotter/compass map. */
  function fetchTileToCanvas(tileX, tileY, zoom) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = TILE_SIZE_PX;
        canvas.height = TILE_SIZE_PX;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, TILE_SIZE_PX, TILE_SIZE_PX);
        resolve({ canvas, ctx });
      };
      img.onerror = reject;
      img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${tileY}/${tileX}`;
    });
  }

  /* Fetches the USGS National Hydrography Dataset overlay tile for
     the same z/y/x coordinates (same Web Mercator tiling scheme as
     the satellite source) -- real, purpose-built water-feature data
     from the USGS, not a photo we have to interpret. This overlay is
     mostly TRANSPARENT with water features drawn in a consistent
     style, which is what makes it classifiable far more reliably
     than satellite color: real coastal/tidal/marsh water is often
     tannic, brownish, or murky and doesn't reliably read as "blue"
     in a photo, but the hydro dataset already KNOWS where the water
     is regardless of what color it happens to look like. Free,
     no API key required (confirmed working via direct test). */
  function fetchHydroTileToCanvas(tileX, tileY, zoom) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = TILE_SIZE_PX;
        canvas.height = TILE_SIZE_PX;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, TILE_SIZE_PX, TILE_SIZE_PX);
        resolve({ canvas, ctx });
      };
      img.onerror = reject;
      img.src = `https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/${zoom}/${tileY}/${tileX}`;
    });
  }

  /* Classifies the hydro overlay by alpha + color, rather than the
     satellite classifier's color-only heuristic -- this overlay is
     transparent everywhere there's no water, so a pixel with
     meaningful opacity in the water-blue family is genuinely
     classified water, not guessed. Far more reliable since this is
     authoritative hydrography data, not a photograph. */
  function classifyHydroPixel(r, g, b, a) {
    if (a < 40) return "land"; /* fully/mostly transparent = no water feature drawn here */
    const isBlueish = b >= r && b >= g - 15; /* the overlay's water fill is consistently blue-family; looser than the satellite heuristic since we're not fighting photo noise here */
    return isBlueish ? "water" : "land";
  }

  /* Same downsample-and-classify approach as buildClassificationGrid,
     but reading the hydro overlay's alpha channel too (which the
     satellite imagery doesn't have/need, since it's fully opaque). */
  function buildHydroClassificationGrid(ctx, gridSize) {
    const imageData = ctx.getImageData(0, 0, TILE_SIZE_PX, TILE_SIZE_PX);
    const pixels = imageData.data;
    const cellPx = TILE_SIZE_PX / gridSize;
    const grid = [];

    for (let gy = 0; gy < gridSize; gy++) {
      const row = [];
      for (let gx = 0; gx < gridSize; gx++) {
        let rSum = 0, gSum = 0, bSum = 0, aSum = 0, count = 0;
        const startX = Math.floor(gx * cellPx);
        const startY = Math.floor(gy * cellPx);
        const endX = Math.floor((gx + 1) * cellPx);
        const endY = Math.floor((gy + 1) * cellPx);
        for (let py = startY; py < endY; py++) {
          for (let px = startX; px < endX; px++) {
            const idx = (py * TILE_SIZE_PX + px) * 4;
            rSum += pixels[idx];
            gSum += pixels[idx + 1];
            bSum += pixels[idx + 2];
            aSum += pixels[idx + 3];
            count++;
          }
        }
        row.push(classifyHydroPixel(rSum / count, gSum / count, bSum / count, aSum / count));
      }
      grid.push(row);
    }
    return grid;
  }

  /* Combined classification entry point: tries the real USGS hydro
     data first (more reliable, purpose-built for exactly this), and
     falls back to the satellite color heuristic only if the hydro
     fetch fails (network issue, or genuinely no coverage -- this
     dataset is US-focused, so areas outside the US would have no
     hydro tiles at all). This is the function every consumer
     (live game, bulk importer, map editor) should call instead of
     calling fetchTileToCanvas/buildClassificationGrid directly,
     so all of them benefit from the more reliable source uniformly. */
  async function classifyTile(tileX, tileY, zoom, gridSize) {
    try {
      const hydroResult = await fetchHydroTileToCanvas(tileX, tileY, zoom);
      const grid = buildHydroClassificationGrid(hydroResult.ctx, gridSize);
      return { grid, source: "hydro" };
    } catch (e) {
      console.warn("Oregon Sail terrain: hydro classification unavailable, falling back to satellite color heuristic", e);
      const satResult = await fetchTileToCanvas(tileX, tileY, zoom);
      const grid = buildClassificationGrid(satResult.ctx, gridSize);
      return { grid, source: "satellite-fallback" };
    }
  }

  /* Builds a real THREE.js mesh from the classification grid: water
     cells get zero height (the existing water shader handles their
     visual appearance separately for cells far from shore — but near
     the coastline this mesh's own water-side slope is what keeps the
     seafloor from clipping through/overlapping the animated wave
     surface), land cells rise gradually further from the shoreline,
     capped at a real max elevation. Uses the same displaced-
     PlaneGeometry technique already established by the water
     shader's swell displacement, just applied to a static heightmap
     instead of an animated wave function. */

  /* Computes, for every cell, its distance (in grid cells) to the
     nearest cell of the OPPOSITE type — i.e. for a land cell, how far
     to the nearest water cell, and vice versa. This is a standard
     distance-transform technique; brute-force here since our grid is
     small (48x48), which is plenty fast for a one-time generation
     step. Returns a same-shaped grid of distances. This is also
     exactly the "how close is this point to the shoreline" value
     Phase 3's breaking-wave effect will want to reuse later. */
  function computeShoreDistanceGrid(grid) {
    const gridSize = grid.length;
    const distances = [];
    for (let gy = 0; gy < gridSize; gy++) {
      const row = [];
      for (let gx = 0; gx < gridSize; gx++) {
        const myType = grid[gy][gx];
        let minDist = gridSize; /* effectively "far" if nothing opposite-type is found anywhere */
        for (let oy = 0; oy < gridSize; oy++) {
          for (let ox = 0; ox < gridSize; ox++) {
            if (grid[oy][ox] === myType) continue;
            const d = Math.sqrt((gx - ox) ** 2 + (gy - oy) ** 2);
            if (d < minDist) minDist = d;
          }
        }
        row.push(minDist);
      }
      distances.push(row);
    }
    return distances;
  }

  function buildTerrainMesh(grid, worldSize, maxLandHeight, maxWaterDepth, calmGrid) {
    const gridSize = grid.length;
    const geo = new THREE.PlaneGeometry(worldSize, worldSize, gridSize - 1, gridSize - 1);
    const posAttr = geo.attributes.position;
    const shoreDist = computeShoreDistanceGrid(grid);
    const taperCells = Math.max(2, gridSize * 0.2);
    /* Use passed maxWaterDepth or fall back to real 100ft depth */
    const seaFloorDepth = maxWaterDepth || (100 * 0.24);

    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const vertIndex = gy * gridSize + gx;
        const cellType = grid[gy][gx];
        const dist = shoreDist[gy][gx];
        const t = Math.min(1, dist / taperCells);
        const eased = t * t * (3 - 2 * t);

        let height;
        if (cellType === "land") {
          const noise = (Math.random() - 0.5) * (maxLandHeight * 0.05);
          height = maxLandHeight + noise;
        } else if (cellType === "beach") {
          const beachMax = Math.max(1, maxLandHeight * 0.08);
          height = beachMax * eased;
        } else {
          /* Water (calm or not) -- calm is a FLAG on regular water
             cells, not a separate cell type, per request. Calm cells
             are pinned flat at sea level (y=0) instead of following
             the normal seafloor-depth slope, which is what the live
             water shader will also respect via mesh.userData.calmGrid
             to suppress wave displacement there. */
          const isCalm = !!(calmGrid && calmGrid[gy] && calmGrid[gy][gx]);
          if (isCalm) {
            height = 0;
          } else {
            let neighborIsBeach = false;
            for (let dy = -1; dy <= 1 && !neighborIsBeach; dy++) {
              for (let dx = -1; dx <= 1 && !neighborIsBeach; dx++) {
                const ny = gy + dy, nx = gx + dx;
                if (ny >= 0 && ny < gridSize && nx >= 0 && nx < gridSize && grid[ny][nx] === "beach") {
                  neighborIsBeach = true;
                }
              }
            }
            height = neighborIsBeach ? -seaFloorDepth * eased : -seaFloorDepth;
          }
        }
        posAttr.setZ(vertIndex, height);
      }
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshPhongMaterial({
      color: 0x6b8e4e,
      flatShading: true
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.classificationGrid = grid;
    mesh.userData.shoreDistanceGrid = shoreDist;
    mesh.userData.worldSize = worldSize;
    /* Kept as-is for the live water shader to use as a quick lookup
       when suppressing wave displacement near calm areas. */
    mesh.userData.calmGrid = calmGrid || [];
    return mesh;
  }

  /* ---------------------------------------------------------------
     PUBLIC API
     --------------------------------------------------------------- */

  /* Checks for a hand-drawn custom region (from the Map Editor)
     anchored near the given real lat/lon, within a generous
     tolerance (roughly the same area a satellite tile would cover).
     Returns a ready-to-add THREE.Group built from the SAME
     buildTerrainMesh used for satellite-derived terrain (just fed a
     hand-painted grid instead of a photo-classified one), or null if
     none exists nearby — callers should fall back to satellite
     generation in that case. Requires sbClient (the shared
     Supabase client already loaded by the main game) to query the
     custom_map_regions table. */
  async function checkForCustomRegion(lat, lon, unitsPerFoot) {
    if (typeof sbClient === "undefined") return null;
    try {
      const tolerance = 0.01; /* roughly ~0.7nm at most latitudes, generous enough to catch a region anchored nearby */
      const { data, error } = await sbClient
        .from("custom_map_regions")
        .select("*")
        .eq("is_active", true)
        .gte("anchor_lat", lat - tolerance)
        .lte("anchor_lat", lat + tolerance)
        .gte("anchor_lon", lon - tolerance)
        .lte("anchor_lon", lon + tolerance)
        .limit(1);
      if (error || !data || data.length === 0) return null;

      const region = data[0];
      const worldSize = (region.world_size_ft || 2000) * (unitsPerFoot || 0.24);
      const landHeight = Math.max(3, worldSize * 0.02);
      const waterDepth = Math.max(15, worldSize * 0.05);
      const mesh = buildTerrainMesh(region.classification_grid, worldSize, landHeight, waterDepth, region.calm_grid);

      const group = new THREE.Group();
      group.add(mesh);
      group.userData.isCustomRegion = true;
      group.userData.regionId = region.id;
      group.userData.centerLat = lat;
      group.userData.centerLon = lon;
      /* Structures (piers, dock spines, fuel docks) placed in the
         editor -- reuses the exact same primitives the marina
         already builds, so v1 custom-region structures look and
         collide identically to marina docks. Positions are stored
         grid-relative in the editor; convert to world units here
         using the same per-cell spacing the terrain mesh itself uses. */
      if (Array.isArray(region.structures) && window.OSMarinaStructures) {
        const cellSize = worldSize / (region.grid_size || 64);
        const halfGrid = (region.grid_size || 64) / 2;
        region.structures.forEach(s => {
          const worldX = (s.x - halfGrid) * cellSize;
          const worldZ = (s.z - halfGrid) * cellSize;
          const structureMesh = window.OSMarinaStructures.build(s.type, unitsPerFoot, s.lengthFt, worldX, worldZ, s.headingDeg);
          if (structureMesh) group.add(structureMesh);
        });
      }
      return group;
    } catch (e) {
      console.error("Oregon Sail terrain: custom region check failed", e);
      return null;
    }
  }

  /* Generates terrain for the area around a given real lat/lon and
     returns a ready-to-add THREE.Group. worldRadiusUnits should match
     whatever view radius the caller wants covered (e.g. the existing
     5nm/0.5mi scene radius) — this function converts that into how
     large the generated mesh needs to be using the scene's own
     UNITS_PER_FOOT, so it lines up at the correct real-world scale.
     Checks for a hand-drawn custom region first (Map Editor output);
     falls back to satellite-based generation if none exists nearby. */
  async function generateTerrainForLocation(lat, lon, worldRadiusUnits, unitsPerFoot) {
    const customRegion = await checkForCustomRegion(lat, lon, unitsPerFoot);
    if (customRegion) return customRegion;

    /* Zoom 15 gives a tile covering roughly 0.3-0.4nm per tile at
       most latitudes — close enough to our typical view radius that
       one tile is a reasonable Phase 1 starting point. Later phases
       could fetch a small grid of adjacent tiles for a larger area. */
    const zoom = 15;
    const tile = latLonToTile(lat, lon, zoom);

    const gridSize = 48;
    let grid;
    try {
      const result = await classifyTile(tile.x, tile.y, tile.zoom, gridSize);
      grid = result.grid;
    } catch (e) {
      console.error("Oregon Sail terrain: failed to fetch/classify tile", e);
      return null;
    }

    /* A zoom-15 tile spans roughly this many real feet across,
       depending on latitude — used to figure out the world-unit size
       of the generated mesh so it's at the correct real scale. */
    const metersPerPixelAtZoom = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
    const tileSpanMeters = metersPerPixelAtZoom * TILE_SIZE_PX;
    const tileSpanFeet = tileSpanMeters * 3.28084;
    const worldSize = tileSpanFeet * (unitsPerFoot || 0.24);

    /* Land rises well above the waterline; the seafloor drops
       genuinely deep away from shore -- both scaled relative to the
       generated area's size, but with water depth deliberately
       larger than land height (a real coastline typically drops off
       into deeper water faster than it rises into tall terrain, and
       this also guarantees the seafloor sits well clear of the
       lowest possible wave trough from the water shader, fixing the
       reported overlap/clipping). */
    const maxLandHeight = Math.max(3, worldSize * 0.02);
    const maxWaterDepth = Math.max(15, worldSize * 0.05);
    const mesh = buildTerrainMesh(grid, worldSize, maxLandHeight, maxWaterDepth);

    const group = new THREE.Group();
    group.add(mesh);
    group.userData.tile = tile;
    group.userData.centerLat = lat;
    group.userData.centerLon = lon;
    return group;
  }

  window.OSTerrain = {
    generateTerrainForLocation,
    latLonToTile,
    tileToLatLon,
    classifyPixel, /* exposed for testing/tuning the classification heuristic */
    fetchTileToCanvas, /* exposed for bulk import, which needs to fetch many tiles directly rather than going through the single-tile generateTerrainForLocation pipeline */
    buildClassificationGrid,
    fetchHydroTileToCanvas,
    classifyHydroPixel,
    buildHydroClassificationGrid,
    classifyTile, /* the recommended entry point -- tries real USGS hydro data first, falls back to the satellite color heuristic only if that fails. Every consumer (live game, bulk importer, map editor) should use this instead of calling the satellite-only path directly. */
    TILE_SIZE_PX
  };
})();
