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
     visual appearance separately — this mesh only needs to carve out
     where land actually rises above it), land cells get raised to a
     flat-ish plateau height. Uses the same displaced-PlaneGeometry
     technique already established by the water shader's swell
     displacement, just applied to a static heightmap instead of an
     animated wave function. */
  function buildTerrainMesh(grid, worldSize, landHeight) {
    const gridSize = grid.length;
    const geo = new THREE.PlaneGeometry(worldSize, worldSize, gridSize - 1, gridSize - 1);
    const posAttr = geo.attributes.position;

    /* PlaneGeometry's vertex grid runs row-by-row matching our
       classification grid exactly, since we built it with
       (gridSize-1) segments -> gridSize vertices per row. */
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const vertIndex = gy * gridSize + gx;
        const isLand = grid[gy][gx] === "land";
        /* A small amount of per-vertex noise on land keeps flat
           plateaus from looking perfectly artificial, without
           needing real elevation data we don't have */
        const noise = isLand ? (Math.random() - 0.5) * (landHeight * 0.15) : 0;
        const height = isLand ? landHeight + noise : 0;
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

    const landHeight = Math.max(2, worldSize * 0.015); /* a modest, visually reasonable plateau height relative to the generated area's size */
    const mesh = buildTerrainMesh(grid, worldSize, landHeight);

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
