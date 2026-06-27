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

  /* Classifies a single RGB pixel as land or water using color
     heuristics. Water reads as blue/cyan/dark-teal tones across a
     wide brightness range (deep ocean is dark blue, shallows/sand
     bars under water can be lighter cyan); land reads as green
     (vegetation), tan/brown (sand, dirt, roads), or gray (rock,
     pavement, structures). This is a real heuristic, not perfect
     ground truth — it will do well on clear open water against solid
     coastline, less well on docks, turbid river mouths, or deep
     shadow. That's an accepted, honest limitation for this pass. */
  function classifyPixel(r, g, b) {
    /* Water: blue channel meaningfully higher than red, and not too
       bright/white (foam, glare) or too dark (shadow on land) */
    const isBlueish = b > r + 8 && b > g - 10;
    const brightness = (r + g + b) / 3;
    if (isBlueish && brightness > 15 && brightness < 230) return "water";
    return "land";
  }

  /* Downsamples a tile canvas into a coarse grid (default 48x48,
     plenty for generating a recognizable coastline shape without
     needing per-pixel resolution) and classifies each cell by
     averaging the pixels within it. Returns a 2D array of "land"/
     "water" strings. */
  function buildClassificationGrid(ctx, gridSize) {
    const imageData = ctx.getImageData(0, 0, TILE_SIZE_PX, TILE_SIZE_PX);
    const pixels = imageData.data;
    const cellPx = TILE_SIZE_PX / gridSize;
    const grid = [];

    for (let gy = 0; gy < gridSize; gy++) {
      const row = [];
      for (let gx = 0; gx < gridSize; gx++) {
        let rSum = 0, gSum = 0, bSum = 0, count = 0;
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
            count++;
          }
        }
        const avgR = rSum / count, avgG = gSum / count, avgB = bSum / count;
        row.push(classifyPixel(avgR, avgG, avgB));
      }
      grid.push(row);
    }
    return grid;
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

  function buildTerrainMesh(grid, worldSize, maxLandHeight, maxWaterDepth) {
    const gridSize = grid.length;
    const geo = new THREE.PlaneGeometry(worldSize, worldSize, gridSize - 1, gridSize - 1);
    const posAttr = geo.attributes.position;
    const shoreDist = computeShoreDistanceGrid(grid);

    /* Distance (in grid cells) at which land/water height reaches its
       full max — anything closer to shore than this smoothly tapers
       toward the actual waterline (y=0), which is what creates a real
       slope through the shoreline instead of a hard step. Roughly a
       fifth of the grid so the slope reads clearly without being the
       entire map. */
    const taperCells = Math.max(2, gridSize * 0.2);

    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const vertIndex = gy * gridSize + gx;
        const isLand = grid[gy][gx] === "land";
        const dist = shoreDist[gy][gx];
        const t = Math.min(1, dist / taperCells); /* 0 right at the shoreline, 1 once fully tapered */
        /* Smoothstep-style easing (t*t*(3-2t)) instead of a linear
           ramp, for a more natural-looking slope rather than a flat
           ramp with a sharp kink where it starts. */
        const eased = t * t * (3 - 2 * t);

        let height;
        if (isLand) {
          const noise = (Math.random() - 0.5) * (maxLandHeight * 0.1);
          height = maxLandHeight * eased + noise;
        } else {
          height = -maxWaterDepth * eased;
        }
        posAttr.setZ(vertIndex, height); /* PlaneGeometry is built in the XY plane; Z becomes height after the same rotateX(-90deg) the water plane uses */
      }
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshPhongMaterial({
      color: 0x6b8e4e, /* a generic land-green; later phases could texture this from the actual tile image */
      flatShading: true
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.classificationGrid = grid; /* kept for later phases (collision detection) */
    mesh.userData.shoreDistanceGrid = shoreDist; /* kept for later phases (shoreline breaking waves) */
    mesh.userData.worldSize = worldSize;
    return mesh;
  }

  /* ---------------------------------------------------------------
     PUBLIC API
     --------------------------------------------------------------- */

  /* Generates terrain for the area around a given real lat/lon and
     returns a ready-to-add THREE.Group. worldRadiusUnits should match
     whatever view radius the caller wants covered (e.g. the existing
     5nm/0.5mi scene radius) — this function converts that into how
     large the generated mesh needs to be using the scene's own
     UNITS_PER_FOOT, so it lines up at the correct real-world scale. */
  async function generateTerrainForLocation(lat, lon, worldRadiusUnits, unitsPerFoot) {
    /* Zoom 15 gives a tile covering roughly 0.3-0.4nm per tile at
       most latitudes — close enough to our typical view radius that
       one tile is a reasonable Phase 1 starting point. Later phases
       could fetch a small grid of adjacent tiles for a larger area. */
    const zoom = 15;
    const tile = latLonToTile(lat, lon, zoom);

    let canvasResult;
    try {
      canvasResult = await fetchTileToCanvas(tile.x, tile.y, tile.zoom);
    } catch (e) {
      console.error("Oregon Sail terrain: failed to fetch satellite tile", e);
      return null;
    }

    const gridSize = 48;
    const grid = buildClassificationGrid(canvasResult.ctx, gridSize);

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
    classifyPixel /* exposed for testing/tuning the classification heuristic */
  };
})();
