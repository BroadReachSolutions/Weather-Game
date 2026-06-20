/* ============================================================
   Oregon Sail — 3D Helm View
   A stylized, low-poly 3D rendering of the boat on the water,
   replacing the satellite map on the Helm tab (the map itself
   moved to a chart-plotter tile in the Nav Station tab).

   Driven by the SAME data the rest of the game already computes:
     - point of sail + trim quality -> heel angle
     - wave height (from weather) -> pitch/roll rocking
     - boom_angle -> boom swings to match
     - course_bearing -> boat's heading in the scene
     - true wind direction -> wind arrow / sail fill direction

   This is a gameplay-feel renderer, not a graphics showcase —
   geometry is intentionally simple (boxes/cylinders/planes).
   ============================================================ */

(function () {
  let scene, camera, renderer, controls;
  let boatGroup, hullMesh, mastMesh, boomGroup, sailMesh, headsailGroup;
  let waterMesh, groundMesh;
  let animFrameId = null;
  let canvasEl = null;

  let currentHeelDeg = 0;   /* side-to-side tilt from wind force on sails */
  let currentPitchDeg = 0;  /* bow-up/down from waves */
  let currentHeadingDeg = null; /* boat's facing direction, null until first state arrives */
  let waveClock = 0;

  const HEEL_SMOOTHING = 0.06;
  const PITCH_SMOOTHING = 0.08;
  const HEADING_SMOOTHING = 0.15;

  /* ---------------------------------------------------------------
     SCENE SETUP
     --------------------------------------------------------------- */
  function initScene() {
    canvasEl = document.getElementById("osHelm3D");
    if (!canvasEl || !window.THREE) return false;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x7ec8e3);
    scene.fog = new THREE.Fog(0x9fd3e8, 90, 320);

    const wrap = document.getElementById("osHelmViewWrap");
    const w = wrap.clientWidth || 360;
    const h = wrap.clientHeight || 240;

    camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 1000);
    camera.position.set(0, 18, 32);

    renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    /* Lighting — simple sun + ambient fill */
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(30, 50, 20);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    /* Orbit controls — drag to look around, as requested */
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 3, 0);
    controls.maxPolarAngle = Math.PI * 0.49; /* don't let camera dip below water */
    controls.minDistance = 12;
    controls.maxDistance = 110;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    buildGroundPlane();
    buildWater();
    buildBoat();
    buildSky();

    windLinesGroup = new THREE.Group();
    scene.add(windLinesGroup);

    window.addEventListener("resize", onResize);
    return true;
  }

  /* ---------------------------------------------------------------
     SKY — a few simple decorative elements (sun glow + low-poly
     cloud puffs drifting slowly) so the scene doesn't feel like an
     empty colored dome. Purely cosmetic, no gameplay data involved.
     --------------------------------------------------------------- */
  let cloudGroup = null;

  function buildSky() {
    /* Soft sun glow — a large, dim sprite-like disc high in the sky */
    const sunGeo = new THREE.CircleGeometry(18, 24);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xfff6d8, transparent: true, opacity: 0.55, depthWrite: false
    });
    const sunMesh = new THREE.Mesh(sunGeo, sunMat);
    sunMesh.position.set(60, 70, -80);
    sunMesh.lookAt(0, 10, 0);
    scene.add(sunMesh);

    /* Low-poly cloud puffs — small clusters of soft white spheres
       scattered at altitude, drifting slowly across the sky */
    cloudGroup = new THREE.Group();
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    const cloudCount = 9;
    for (let i = 0; i < cloudCount; i++) {
      const cluster = new THREE.Group();
      const puffCount = 3 + Math.floor(Math.random() * 3);
      for (let p = 0; p < puffCount; p++) {
        const r = 2 + Math.random() * 2.5;
        const puffGeo = new THREE.SphereGeometry(r, 6, 5);
        const puff = new THREE.Mesh(puffGeo, cloudMat);
        puff.position.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 4);
        cluster.add(puff);
      }
      const angle = (i / cloudCount) * Math.PI * 2;
      const dist = 70 + Math.random() * 50;
      cluster.position.set(Math.cos(angle) * dist, 28 + Math.random() * 14, Math.sin(angle) * dist);
      cluster.userData.driftSpeed = 0.15 + Math.random() * 0.15;
      cloudGroup.add(cluster);
    }
    scene.add(cloudGroup);
  }

  function animateSky(elapsedFactor) {
    if (!cloudGroup) return;
    cloudGroup.children.forEach((cluster) => {
      cluster.position.x += cluster.userData.driftSpeed * elapsedFactor;
      if (cluster.position.x > 140) cluster.position.x = -140;
    });
  }

  /* ---------------------------------------------------------------
     GROUND PLANE — textured with the same satellite imagery the
     chart plotter uses, so the player can see real coastline/land
     shape near their position. Flat (no elevation), oriented to
     true north so it stays consistent with the boat's real heading.
     --------------------------------------------------------------- */
  function buildGroundPlane() {
    /* Plane sized to roughly match the real-world area the tile grid
       covers (see updateGroundTexture) — large enough that sailing
       toward land shows it well before you'd reach the plane's edge. */
    const geo = new THREE.PlaneGeometry(900, 900);
    const mat = new THREE.MeshBasicMaterial({ color: 0x3a5f6b, transparent: true, opacity: 0.0 });
    groundMesh = new THREE.Mesh(geo, mat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.y = -0.05;
    scene.add(groundMesh);
  }

  /* ---------------------------------------------------------------
     GROUND TEXTURE — stitches a grid of real ArcGIS satellite tiles
     into one canvas texture covering roughly a 25-mile radius around
     the boat (a 5×5 grid at zoom 11, ~15km/tile ≈ 75km / 47mi across).
     Refresh is distance-triggered from game-ui.js, not time-based —
     re-fetching 25 tiles every second would hammer the tile server.
     --------------------------------------------------------------- */
  const GROUND_TILE_ZOOM = 11;
  const GROUND_TILE_GRID = 5; /* 5x5 tiles, odd number so boat sits on the center tile */
  const GROUND_TILE_PX = 256; /* ArcGIS tile pixel size */

  function lonToTileX(lon, zoom) {
    return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
  }
  function latToTileY(lat, zoom) {
    const latRad = (lat * Math.PI) / 180;
    return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom));
  }

  let groundTextureLoadToken = 0; /* guards against a slow earlier load overwriting a newer one */

  function updateGroundTexture(lat, lon) {
    if (!groundMesh) return;
    const myToken = ++groundTextureLoadToken;

    const centerX = lonToTileX(lon, GROUND_TILE_ZOOM);
    const centerY = latToTileY(lat, GROUND_TILE_ZOOM);
    const half = Math.floor(GROUND_TILE_GRID / 2);

    const canvas = document.createElement("canvas");
    canvas.width = GROUND_TILE_GRID * GROUND_TILE_PX;
    canvas.height = GROUND_TILE_GRID * GROUND_TILE_PX;
    const ctx = canvas.getContext("2d");
    /* Fallback fill while tiles load in, in case some fail */
    ctx.fillStyle = "#1f6f8b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let loaded = 0;
    const total = GROUND_TILE_GRID * GROUND_TILE_GRID;

    function finalize() {
      if (myToken !== groundTextureLoadToken) return; /* a newer call superseded this one */
      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      groundMesh.material.map = texture;
      groundMesh.material.opacity = 0.92;
      groundMesh.material.needsUpdate = true;
    }

    for (let row = 0; row < GROUND_TILE_GRID; row++) {
      for (let col = 0; col < GROUND_TILE_GRID; col++) {
        const tx = centerX - half + col;
        const ty = centerY - half + row;
        const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${GROUND_TILE_ZOOM}/${ty}/${tx}`;

        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          if (myToken !== groundTextureLoadToken) return;
          ctx.drawImage(img, col * GROUND_TILE_PX, row * GROUND_TILE_PX, GROUND_TILE_PX, GROUND_TILE_PX);
          loaded++;
          if (loaded === total) finalize();
        };
        img.onerror = () => {
          /* Missing tile (open ocean sometimes 404s, or offline) —
             leave the fallback fill for that cell, don't block the rest */
          loaded++;
          if (loaded === total) finalize();
        };
        img.src = url;
      }
    }
  }

  /* ---------------------------------------------------------------
     WATER — animated plane using vertex displacement for a simple
     rolling-wave look, not a real ocean simulation.
     --------------------------------------------------------------- */
  function buildWater() {
    const geo = new THREE.PlaneGeometry(300, 300, 50, 50);
    /* Old-school stylized water: flat-colored and noticeably
       see-through, like early 3D sailing games — using a basic
       (unlit) material instead of Phong so wave troughs don't pick
       up harsh directional shadowing that read as black/gray */
    const mat = new THREE.MeshBasicMaterial({
      color: 0x3fb4e0,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide
    });
    waterMesh = new THREE.Mesh(geo, mat);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.y = 0;
    scene.add(waterMesh);

    /* A lighter cap layer of small foam-cap highlights, purely
       decorative — stylized whitecaps, also unlit/flat */
    const foamGeo = new THREE.PlaneGeometry(300, 300, 50, 50);
    const foamMat = new THREE.MeshBasicMaterial({
      color: 0xeaf8ff, transparent: true, opacity: 0.15,
      side: THREE.DoubleSide, depthWrite: false
    });
    const foamMesh = new THREE.Mesh(foamGeo, foamMat);
    foamMesh.rotation.x = -Math.PI / 2;
    foamMesh.position.y = 0.02;
    scene.add(foamMesh);
    waterMesh.userData.foamMesh = foamMesh;
  }

  function animateWater(waveHeightFt) {
    if (!waterMesh) return;
    /* Bigger, chunkier amplitude than a realistic ocean, but scaled
       back a bit from the very first pass since the boat is now
       1.8x larger and shouldn't look swamped by the swell */
    const amplitude = Math.min(1.4, (waveHeightFt || 1) * 0.18);
    const pos = waterMesh.geometry.attributes.position;
    const foamMesh = waterMesh.userData.foamMesh;
    const foamPos = foamMesh ? foamMesh.geometry.attributes.position : null;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = Math.sin(x * 0.22 + waveClock) * amplitude * 0.6 +
                 Math.sin(y * 0.16 + waveClock * 1.25) * amplitude * 0.4 +
                 Math.sin((x + y) * 0.1 + waveClock * 0.8) * amplitude * 0.25;
      pos.setZ(i, z);
      if (foamPos) foamPos.setZ(i, z + 0.03);
    }
    pos.needsUpdate = true;
    waterMesh.geometry.computeVertexNormals();
    if (foamPos) { foamPos.needsUpdate = true; }
  }

  /* ---------------------------------------------------------------
     BOAT — a proper hull silhouette (pointed bow, squared stern),
     mast, boom pivoting correctly at the mast base, mainsail, and a
     headsail (jib) that raises/lowers with the reef level. The boom
     rotates to match boom_angle; the whole boatGroup heels (Z-tilt)
     and pitches/rolls (X/Z tilt) based on physics data.
     --------------------------------------------------------------- */
  let headsailMesh = null;
  let windLinesGroup = null;

  function buildBoat() {
    boatGroup = new THREE.Group();
    /* Whole boat scaled up substantially so it reads clearly against
       the water/waves instead of looking swamped by them */
    boatGroup.scale.set(2.4, 2.4, 2.4);

    /* Hull — extruded from a top-down silhouette with a pointed bow
       (+Z) and a flat transom stern (-Z). Depth increased so the
       freeboard (waterline to deck) reads as a real 5-6ft equivalent
       once scaled, instead of a thin slab that sat low in the water. */
    const hullShape = new THREE.Shape();
    hullShape.moveTo(0, 4.2);       /* bow point */
    hullShape.quadraticCurveTo(0.9, 2.6, 1.05, 0.5);
    hullShape.lineTo(1.05, -2.6);   /* starboard side to stern */
    hullShape.lineTo(-1.05, -2.6);  /* transom (stern) */
    hullShape.lineTo(-1.05, 0.5);
    hullShape.quadraticCurveTo(-0.9, 2.6, 0, 4.2); /* port side back to bow */

    const hullExtrude = new THREE.ExtrudeGeometry(hullShape, { depth: 2.1, bevelEnabled: false });
    hullExtrude.rotateX(Math.PI / 2);
    const hullMat = new THREE.MeshPhongMaterial({ color: 0xe8e4da, flatShading: true });
    hullMesh = new THREE.Mesh(hullExtrude, hullMat);
    /* Raised so most of the hull sits above the waterline (y=0),
       giving real visible freeboard instead of riding low */
    hullMesh.position.y = 1.0;
    boatGroup.add(hullMesh);

    /* ExtrudeGeometry extrudes along local +Z from 0 to depth; our
       rotateX(90°) on the geometry maps local +Z to world -Y, so the
       hull's deck (top edge, local z=0) ends up at hullMesh.position.y
       itself, and the keel/bottom (local z=depth) ends up BELOW that
       at position.y - depth. Using position.y + depth here previously
       put deckY a full hull-depth too high, floating the entire
       cabin/bimini/mast assembly above the actual hull. */
    const deckY = 1.0;

    /* Keel fin beneath, just for visual grounding. Hull bottom is at
       deckY - hullDepth (1.0 - 2.1 = -1.1); keel hangs below that. */
    const keelGeo = new THREE.BoxGeometry(0.3, 1.2, 2);
    const keelMesh = new THREE.Mesh(keelGeo, new THREE.MeshPhongMaterial({ color: 0x2a2a2a }));
    keelMesh.position.y = -1.7;
    boatGroup.add(keelMesh);

    /* ---------------------------------------------------------------
       CABIN TOP — a raised structure forward of the cockpit with
       small round portholes along each side, sitting on deck.
       --------------------------------------------------------------- */
    /* Cabin top — tapers to a point at the forward (bow) end instead
       of a flat box front, echoing the hull's own pointed bow shape.
       Built as an extruded top-down silhouette like the hull. */
    const cabinShape = new THREE.Shape();
    cabinShape.moveTo(0, 1.9);          /* forward point */
    cabinShape.quadraticCurveTo(0.7, 1.3, 0.85, 0.6);
    cabinShape.lineTo(0.85, -1.0);      /* starboard side aft */
    cabinShape.lineTo(-0.85, -1.0);     /* aft edge */
    cabinShape.lineTo(-0.85, 0.6);
    cabinShape.quadraticCurveTo(-0.7, 1.3, 0, 1.9); /* port side back to the point */

    const cabinExtrude = new THREE.ExtrudeGeometry(cabinShape, { depth: 0.9, bevelEnabled: false });
    cabinExtrude.rotateX(Math.PI / 2);
    const cabinMat = new THREE.MeshPhongMaterial({ color: 0xf2efe6, flatShading: true });
    const cabinMesh = new THREE.Mesh(cabinExtrude, cabinMat);
    /* Same rotateX(90°) quirk as the hull — local z=0 (top surface of
       the shape, which here is the cabin roof) ends up at this
       position.y, with the structure extending DOWN to the deck. */
    cabinMesh.position.set(0, deckY + 0.9, 1.3);
    boatGroup.add(cabinMesh);

    const portholeMat = new THREE.MeshPhongMaterial({ color: 0x1a2a35 });
    const portholeGeo = new THREE.CircleGeometry(0.16, 12);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 3; i++) {
        const porthole = new THREE.Mesh(portholeGeo, portholeMat);
        porthole.position.set(side * 0.86, deckY + 0.5, -0.5 + i * 0.7);
        porthole.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        boatGroup.add(porthole);
      }
    }

    /* ---------------------------------------------------------------
       COCKPIT + BIMINI + HELM — an open well aft of the cabin with
       a canvas bimini top on tubular frames, and a simple wheel/post
       at the helm station underneath it.
       --------------------------------------------------------------- */
    const cockpitFloorGeo = new THREE.BoxGeometry(1.4, 0.15, 1.8);
    const cockpitFloorMesh = new THREE.Mesh(cockpitFloorGeo, new THREE.MeshPhongMaterial({ color: 0xd8d4c8 }));
    cockpitFloorMesh.position.set(0, deckY + 0.1, -1.1);
    boatGroup.add(cockpitFloorMesh);

    const biminiFrameMat = new THREE.MeshPhongMaterial({ color: 0xc8ccd0 });
    const biminiPostPositions = [
      [-0.65, -0.3], [0.65, -0.3], [-0.65, -1.8], [0.65, -1.8]
    ];
    biminiPostPositions.forEach(([px, pz]) => {
      const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.3, 6);
      const post = new THREE.Mesh(postGeo, biminiFrameMat);
      post.position.set(px, deckY + 0.65, pz);
      boatGroup.add(post);
    });
    const biminiTopGeo = new THREE.BoxGeometry(1.5, 0.06, 1.7);
    const biminiTopMesh = new THREE.Mesh(biminiTopGeo, new THREE.MeshPhongMaterial({
      color: 0x2c5f73, flatShading: true
    }));
    biminiTopMesh.position.set(0, deckY + 1.32, -1.05);
    boatGroup.add(biminiTopMesh);

    /* Helm — wheel on a post, under the bimini, aft end of the cockpit */
    const helmPostGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.55, 6);
    const helmPostMesh = new THREE.Mesh(helmPostGeo, new THREE.MeshPhongMaterial({ color: 0x3a3a3a }));
    helmPostMesh.position.set(0, deckY + 0.37, -1.7);
    boatGroup.add(helmPostMesh);

    const helmWheelGeo = new THREE.TorusGeometry(0.3, 0.025, 6, 16);
    const helmWheelMesh = new THREE.Mesh(helmWheelGeo, new THREE.MeshPhongMaterial({ color: 0x4a3527 }));
    helmWheelMesh.position.set(0, deckY + 0.68, -1.7);
    helmWheelMesh.rotation.x = Math.PI / 2.3; /* tilted back like a real boat wheel */
    boatGroup.add(helmWheelMesh);

    /* ---------------------------------------------------------------
       LIFELINES — thin cables on stanchions around the deck perimeter
       --------------------------------------------------------------- */
    const stanchionMat = new THREE.MeshPhongMaterial({ color: 0xd0d4d8 });
    const lifelineMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8 });
    const deckEdgeZ = [3.6, 2.4, 1.2, 0, -1.2, -2.4]; /* stanchion stations along the hull */

    [-1, 1].forEach((side) => {
      const stanchionPositions = [];
      deckEdgeZ.forEach((z) => {
        /* Hull narrows toward the bow — approximate the half-width at
           each Z station so stanchions roughly follow the hull line */
        const t = Math.max(0, Math.min(1, (4.2 - z) / (4.2 - (-2.6))));
        const halfWidth = 1.05 * (1 - 0.5 * Math.pow(1 - t, 2));
        const x = side * Math.min(1.0, halfWidth);
        stanchionPositions.push([x, z]);

        const stanchionGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.45, 5);
        const stanchion = new THREE.Mesh(stanchionGeo, stanchionMat);
        stanchion.position.set(x, deckY + 0.22, z);
        boatGroup.add(stanchion);
      });

      /* Connect consecutive stanchions with a top lifeline cable */
      for (let i = 0; i < stanchionPositions.length - 1; i++) {
        const [x1, z1] = stanchionPositions[i];
        const [x2, z2] = stanchionPositions[i + 1];
        const dx = x2 - x1, dz = z2 - z1;
        const len = Math.sqrt(dx * dx + dz * dz);
        const lineGeo = new THREE.CylinderGeometry(0.012, 0.012, len, 4);
        const line = new THREE.Mesh(lineGeo, lifelineMat);
        line.position.set((x1 + x2) / 2, deckY + 0.42, (z1 + z2) / 2);
        line.rotation.z = Math.PI / 2;
        line.rotation.y = Math.atan2(dx, dz);
        boatGroup.add(line);
      }
    });

    /* ---------------------------------------------------------------
       MAST, BOOM, SAILS (existing, repositioned for the taller deck)
       --------------------------------------------------------------- */
    const mastX = 0, mastZ = 0.6;
    const mastBaseY = deckY;
    const mastGeo = new THREE.CylinderGeometry(0.08, 0.08, 9, 8);
    mastMesh = new THREE.Mesh(mastGeo, new THREE.MeshPhongMaterial({ color: 0x5a4632 }));
    mastMesh.position.set(mastX, mastBaseY + 4.5, mastZ);
    boatGroup.add(mastMesh);

    /* Standing rigging — forestay (bow to masthead) and two side
       shrouds (port/starboard deck to masthead), thin taut cables */
    const riggingMat = new THREE.MeshBasicMaterial({ color: 0xcccccc });
    function addStay(fromX, fromZ, toY) {
      const dx = mastX - fromX, dz = mastZ - fromZ, dy = toY - mastBaseY;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const geo = new THREE.CylinderGeometry(0.018, 0.018, len, 4);
      const mesh = new THREE.Mesh(geo, riggingMat);
      mesh.position.set((fromX + mastX) / 2, (mastBaseY + toY) / 2, (fromZ + mastZ) / 2);
      mesh.lookAt(mastX, toY, mastZ);
      mesh.rotateX(Math.PI / 2);
      boatGroup.add(mesh);
    }
    addStay(mastX, 4.1, mastBaseY + 9); /* forestay to the bow */
    addStay(-1.0, 0.6, mastBaseY + 8.1); /* port shroud */
    addStay(1.0, 0.6, mastBaseY + 8.1);  /* starboard shroud */

    /* Boom group — pivots exactly at the mast's base/centerline so it
       reads as properly attached, not floating beside the mast */
    boomGroup = new THREE.Group();
    boomGroup.position.set(mastX, mastBaseY + 1.8, mastZ);
    boatGroup.add(boomGroup);

    const boomLen = 3.2;
    const boomGeo = new THREE.CylinderGeometry(0.05, 0.05, boomLen, 6);
    const boomMesh = new THREE.Mesh(boomGeo, new THREE.MeshPhongMaterial({ color: 0xcfd8df }));
    /* A cylinder's default long axis is Y. Rotating on X lays it down
       along Z (fore-aft, running with the keel) — the previous
       rotation.z laid it along X instead (side-to-side, perpendicular
       to the hull), which was the reported 90°-off bug. */
    boomMesh.rotation.x = Math.PI / 2;
    boomMesh.position.set(0, 0, -boomLen / 2); /* extends aft from the mast pivot */
    boomGroup.add(boomMesh);

    /* Mainsail — triangle from mast (at boom pivot height up to mast
       top) back to the boom tip, attached at the mast the whole time */
    const mainsailGeo = new THREE.BufferGeometry();
    const mainsailVerts = new Float32Array([
      0, 0, 0,      /* mast base (boom pivot height) */
      0, 7.0, 0,    /* mast top */
      0, 0, -boomLen /* boom tip (local to boomGroup) */
    ]);
    mainsailGeo.setAttribute("position", new THREE.BufferAttribute(mainsailVerts, 3));
    mainsailGeo.setIndex([0, 1, 2]);
    mainsailGeo.computeVertexNormals();
    sailMesh = new THREE.Mesh(mainsailGeo, new THREE.MeshPhongMaterial({
      color: 0xf5f5f0, side: THREE.DoubleSide, transparent: true, opacity: 0.92, flatShading: true
    }));
    boomGroup.add(sailMesh); /* parented to boomGroup so it swings with the boom but stays mast-attached */

    /* Headsail (jib) — a roller-furling jib. Its luff (the edge along
       the forestay, from mast base up toward the masthead) is the
       furl axis: furling rolls the sail's clew up TOWARD that edge,
       like a real roller furler winding the sail around the
       forestay, rather than just shrinking it downward. We model
       this with a dedicated group pivoted at the tack (mast base)
       whose rotation/scale we drive from updateHeadsailReef. */
    headsailGroup = new THREE.Group();
    headsailGroup.position.set(mastX, mastBaseY + 0.6, mastZ);
    boatGroup.add(headsailGroup);

    const headsailGeo = new THREE.BufferGeometry();
    const headsailVerts = new Float32Array([
      0, 0, 0,        /* tack, at the headsailGroup origin (mast base) */
      0, 5.6, 0,      /* head, up near the masthead */
      0, 0, 3.3        /* clew, forward toward the bow */
    ]);
    headsailGeo.setAttribute("position", new THREE.BufferAttribute(headsailVerts, 3));
    headsailGeo.setIndex([0, 1, 2]);
    headsailGeo.computeVertexNormals();
    headsailMesh = new THREE.Mesh(headsailGeo, new THREE.MeshPhongMaterial({
      color: 0xf0f0ec, side: THREE.DoubleSide, transparent: true, opacity: 0.9, flatShading: true
    }));
    headsailGroup.add(headsailMesh);

    scene.add(boatGroup);
  }

  /* jibFurlPct: 0 (fully furled) .. 100 (full jib out). Scales the
     headsail's visible height to match how much jib is actually
     deployed, matching the new continuous furl control. */
  /* jibFurlPct: 0 (fully furled/rolled up) .. 100 (full jib out).
     A real roller-furling jib winds the sail around the forestay
     starting from the leech (the free aft edge, our "clew" point),
     rolling inward toward the luff — so we shrink the sail's
     foot/leech extent (local Z, from luff at z=0 to clew at z=3.3)
     toward zero, which reads as the sail disappearing forward into
     a furled roll at the mast/forestay rather than just sinking down. */
  function updateHeadsailReef(jibFurlPct) {
    if (!headsailMesh) return;
    const scale = Math.max(0, Math.min(100, jibFurlPct)) / 100;
    headsailMesh.scale.z = scale;
  }

  /* Rebuilds scene-wide wind streaks scattered across the visible
     water area (not attached to the boat/mast) so wind is visible
     everywhere around the player, not just at the masthead. More
     streaks + longer + thicker as wind speed increases. */
  let lastWindLineSpeedKt = -1;
  let windStreakSpeed = 0;
  function updateWindLines(windSpeedKt) {
    if (!windLinesGroup) return;
    const rounded = Math.round(windSpeedKt);
    windStreakSpeed = windSpeedKt;
    if (rounded === lastWindLineSpeedKt) return; /* avoid rebuilding every frame */
    lastWindLineSpeedKt = rounded;

    while (windLinesGroup.children.length) {
      const child = windLinesGroup.children[0];
      windLinesGroup.remove(child);
    }

    const count = Math.max(8, Math.min(40, Math.round(8 + windSpeedKt * 1.6)));
    const length = Math.max(0.5, Math.min(2.2, 0.5 + windSpeedKt * 0.07));
    const thickness = Math.max(0.02, Math.min(0.07, 0.02 + windSpeedKt * 0.002));

    for (let i = 0; i < count; i++) {
      const geo = new THREE.CylinderGeometry(thickness, thickness, length, 4);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
      const line = new THREE.Mesh(geo, mat);
      line.rotation.x = Math.PI / 2; /* lie flat, streaming along Z */
      /* Scatter across a wide area around the boat at varying heights
         just above the water, so wind reads as an ambient field */
      line.position.set(
        (Math.random() - 0.5) * 70,
        0.3 + Math.random() * 4,
        (Math.random() - 0.5) * 70
      );
      line.userData.baseZ = line.position.z;
      line.userData.offset = Math.random() * 40;
      windLinesGroup.add(line);
    }
  }

  /* Streams each wind line along the wind direction over time,
     wrapping back around so the field feels continuous */
  function animateWindLines(elapsedFactor) {
    if (!windLinesGroup) return;
    /* Orient the whole field to blow toward where the wind is actually
       going (windDeg is the compass direction it's coming FROM, so it
       blows toward windDeg+180). This was previously fixed along a
       single world axis regardless of real wind direction. */
    if (window.OSHelm3DState && typeof window.OSHelm3DState.windDeg === "number") {
      const towardDeg = (window.OSHelm3DState.windDeg + 180) % 360;
      /* Same sign convention as the boat's heading rotation below
         (negative) — using the opposite sign here previously made
         the wind spin the wrong way relative to the boat, which is
         what caused it to visually disagree with the real forecast
         direction. */
      windLinesGroup.rotation.y = -(towardDeg * Math.PI) / 180;
    }
    windLinesGroup.children.forEach((line) => {
      line.position.z -= windStreakSpeed * 0.01 * elapsedFactor;
      if (line.position.z < -40) line.position.z = 40;
    });
  }

  function updateBoom(boomAngleDeg) {
    if (!boomGroup) return;
    /* boom_angle is -90..90 (port/starboard) in the game's convention */
    boomGroup.rotation.y = -(boomAngleDeg * Math.PI) / 180;
  }

  /* ---------------------------------------------------------------
     PHYSICS-DRIVEN ANIMATION
     Heel comes from how hard the wind is loading the sail (driven
     by the same trim-quality + point-of-sail factors the backend
     uses for speed) — a well-trimmed boat in strong wind heels more
     than a luffing one in light wind. Pitch/roll comes from wave
     height. Both are smoothed so the motion feels organic, not jumpy.
     --------------------------------------------------------------- */
  function computeTargetHeel(windSpeedKt, trimFactor, pointOfSailFactor, isSailing) {
    if (!isSailing) return 0;
    const windLoad = Math.min(1, windSpeedKt / 20); /* normalize ~20kt as "a lot" */
    const heelMax = 18; /* degrees, stylized not exact */
    return windLoad * trimFactor * pointOfSailFactor * heelMax;
  }

  function tick() {
    animFrameId = requestAnimationFrame(tick);
    waveClock += 0.02;

    const waveHeightFt = window.OSHelm3DState ? window.OSHelm3DState.waveHeightFt : 1;
    animateWater(waveHeightFt);
    animateWindLines(1);
    animateSky(1);
    updateWindLines(window.OSHelm3DState ? window.OSHelm3DState.windSpeedKt || 0 : 0);

    if (window.OSHelm3DState) {
      const s = window.OSHelm3DState;
      const targetHeel = computeTargetHeel(s.windSpeedKt, s.trimFactor, s.pointOfSailFactor, s.isSailing);
      currentHeelDeg += (targetHeel - currentHeelDeg) * HEEL_SMOOTHING;

      /* Gentle idle rocking even with sails down / calm water — a
         becalmed or anchored boat should still bob slightly rather
         than sit perfectly rigid, which read as static/lifeless */
      const effectiveWaveHeight = s.isSailing ? (waveHeightFt || 1) : Math.max(0.5, (waveHeightFt || 1) * 0.5);
      const targetPitch = Math.sin(waveClock * 0.7) * Math.min(8, effectiveWaveHeight * 1.2);
      currentPitchDeg += (targetPitch - currentPitchDeg) * PITCH_SMOOTHING;

      /* Heading — the boat's actual facing direction. This was missing
         entirely before (only heel/pitch were applied), which is why
         turning the wheel never visibly turned the boat. Smoothed with
         proper angle-wrapping so it doesn't spin the long way around
         when crossing the 0/360 boundary (e.g. 350° -> 10°). */
      if (typeof s.heading === "number") {
        if (currentHeadingDeg == null) currentHeadingDeg = s.heading;
        let delta = ((s.heading - currentHeadingDeg + 540) % 360) - 180;
        currentHeadingDeg = (currentHeadingDeg + delta * HEADING_SMOOTHING + 360) % 360;
      }

      if (boatGroup) {
        /* Heel to whichever side the wind is actually hitting the
           boat from, derived from real heading vs true wind — NOT
           boom angle, which was only a rough proxy and could
           visually disagree with where the wind streaks show the
           wind actually coming from (e.g. while poorly trimmed or
           motor-sailing). relative 0-360, 0=wind dead ahead,
           >180 = wind from the port side. */
        let heelSign = -1;
        if (typeof s.heading === "number" && typeof s.windDeg === "number") {
          const relative = ((s.windDeg - s.heading) + 360) % 360;
          heelSign = relative > 180 ? 1 : -1; /* wind on port heels to starboard (-1 here), and vice versa */
        }
        boatGroup.rotation.order = "YXZ"; /* apply heading first, then pitch/heel relative to it */
        boatGroup.rotation.y = currentHeadingDeg != null ? -(currentHeadingDeg * Math.PI) / 180 : 0;
        boatGroup.rotation.z = (currentHeelDeg * heelSign * Math.PI) / 180;
        boatGroup.rotation.x = (currentPitchDeg * Math.PI) / 180;
        boatGroup.position.y = 0.3 + Math.sin(waveClock * 0.7) * Math.min(0.4, effectiveWaveHeight * 0.08);
      }

      updateBoom(s.boomAngleDeg || 0);
      updateHeadsailReef(s.isSailing ? (s.jibFurlPct != null ? s.jibFurlPct : 100) : 0); /* 0 = fully down, not sailing */
      updateWindLines(s.windSpeedKt || 0);

      /* Sails visible only while sailing_active; mainsail billow is a
         subtle camber bend (Z displacement of the boom-tip vertex)
         rather than X-scaling, since it's a flat triangle fan now.
         Mainsail height also scales down with reef level. */
      if (sailMesh) {
        sailMesh.visible = !!s.isSailing;
        const reefScaleMap = { 0: 1.0, 1: 0.65, 2: 0.35 };
        sailMesh.scale.y = reefScaleMap[s.reefLevel] != null ? reefScaleMap[s.reefLevel] : 1.0;
        const fill = (s.trimFactor || 0) * 0.4; /* 0..0.4 units of camber */
        const posAttr = sailMesh.geometry.attributes.position;
        posAttr.setX(2, fill); /* boom-tip vertex bows outward slightly when well-trimmed */
        posAttr.needsUpdate = true;
      }
      if (headsailMesh) headsailMesh.visible = !!s.isSailing;
    }

    controls.update();
    updateCompassOverlay();
    renderer.render(scene, camera);
  }

  /* ---------------------------------------------------------------
     COMPASS OVERLAY — shows two lines on a top-down compass rose:
     where the boat is actually facing (its real course_bearing) and
     where the camera is currently looking, since orbiting can point
     the camera anywhere regardless of the boat's heading.
     --------------------------------------------------------------- */
  function updateCompassOverlay() {
    const boatLine = document.getElementById("osHelmCompassBoatLine");
    const camLine = document.getElementById("osHelmCompassCamLine");
    if (!boatLine || !camLine || !camera || !controls) return;

    /* Boat heading: currentHeadingDeg is compass-style (0=N, 90=E).
       The compass SVG's "up" tick mark is N at (50,14), so we just
       rotate a line of that same length by the heading. */
    const r = 36;
    if (currentHeadingDeg != null) {
      const rad = (currentHeadingDeg * Math.PI) / 180;
      const x = 50 + Math.sin(rad) * r;
      const y = 50 - Math.cos(rad) * r;
      boatLine.setAttribute("x2", x.toFixed(1));
      boatLine.setAttribute("y2", y.toFixed(1));
    }

    /* Camera direction: derive compass bearing from the camera's
       position relative to its orbit target (where it's looking
       FROM, reversed, since we want which way it's looking AT) */
    const dx = controls.target.x - camera.position.x;
    const dz = controls.target.z - camera.position.z;
    /* Three.js world: -Z is "north" in our scene's initial camera
       setup (camera starts at +Z looking toward origin) */
    const camBearingRad = Math.atan2(dx, -dz);
    const camBearingDeg = ((camBearingRad * 180) / Math.PI + 360) % 360;
    const camX = 50 + Math.sin(camBearingRad) * r;
    const camY = 50 - Math.cos(camBearingRad) * r;
    camLine.setAttribute("x2", camX.toFixed(1));
    camLine.setAttribute("y2", camY.toFixed(1));
  }

  function onResize() {
    const wrap = document.getElementById("osHelmViewWrap");
    if (!wrap || !renderer || !camera) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /* ---------------------------------------------------------------
     PUBLIC API — game-ui.js calls these to feed live data in
     --------------------------------------------------------------- */
  window.OSHelm3D = {
    init: function () {
      if (renderer) return; /* already running */
      const ok = initScene();
      if (!ok) {
        setTimeout(() => window.OSHelm3D.init(), 300);
        return;
      }
      tick();
    },
    updateGroundTexture: updateGroundTexture,
    setState: function (state) {
      window.OSHelm3DState = state;
    },
    resize: onResize
  };
})();
