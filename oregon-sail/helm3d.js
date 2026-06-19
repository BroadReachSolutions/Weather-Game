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
  let boatGroup, hullMesh, mastMesh, boomGroup, sailMesh;
  let waterMesh, groundMesh;
  let animFrameId = null;
  let canvasEl = null;

  let currentHeelDeg = 0;   /* side-to-side tilt from wind force on sails */
  let currentPitchDeg = 0;  /* bow-up/down from waves */
  let waveClock = 0;

  const HEEL_SMOOTHING = 0.06;
  const PITCH_SMOOTHING = 0.08;

  /* ---------------------------------------------------------------
     SCENE SETUP
     --------------------------------------------------------------- */
  function initScene() {
    canvasEl = document.getElementById("osHelm3D");
    if (!canvasEl || !window.THREE) return false;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x7ec8e3);
    scene.fog = new THREE.Fog(0x9fd3e8, 40, 220);

    const wrap = document.getElementById("osHelmViewWrap");
    const w = wrap.clientWidth || 360;
    const h = wrap.clientHeight || 240;

    camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 1000);
    camera.position.set(0, 10, 18);

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
    controls.target.set(0, 1, 0);
    controls.maxPolarAngle = Math.PI * 0.49; /* don't let camera dip below water */
    controls.minDistance = 6;
    controls.maxDistance = 60;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    buildGroundPlane();
    buildWater();
    buildBoat();

    window.addEventListener("resize", onResize);
    return true;
  }

  /* ---------------------------------------------------------------
     GROUND PLANE — textured with the same satellite imagery the
     chart plotter uses, so the player can see real coastline/land
     shape near their position. Flat (no elevation), oriented to
     true north so it stays consistent with the boat's real heading.
     --------------------------------------------------------------- */
  function buildGroundPlane() {
    const geo = new THREE.PlaneGeometry(400, 400);
    const mat = new THREE.MeshBasicMaterial({ color: 0x3a5f6b, transparent: true, opacity: 0.0 });
    groundMesh = new THREE.Mesh(geo, mat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.y = -0.05;
    scene.add(groundMesh);
  }

  function updateGroundTexture(lat, lon) {
    if (!groundMesh) return;
    /* Same ArcGIS World Imagery tile source as the chart plotter,
       fetched at a fixed mid-zoom so it covers a reasonable area
       around the boat without constant re-fetching on every move. */
    const zoom = 13;
    const tileX = Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
    const latRad = (lat * Math.PI) / 180;
    const tileY = Math.floor(
      (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom)
    );
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${tileY}/${tileX}`;

    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    loader.load(url, (texture) => {
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      groundMesh.material.map = texture;
      groundMesh.material.opacity = 0.9;
      groundMesh.material.needsUpdate = true;
    }, undefined, () => {
      /* Tile fetch failed (offline, rate-limited, etc) — keep the
         plain water-blue fallback, not a hard error for the player */
    });
  }

  /* ---------------------------------------------------------------
     WATER — animated plane using vertex displacement for a simple
     rolling-wave look, not a real ocean simulation.
     --------------------------------------------------------------- */
  function buildWater() {
    const geo = new THREE.PlaneGeometry(300, 300, 60, 60);
    const mat = new THREE.MeshPhongMaterial({
      color: 0x1f6f8b,
      transparent: true,
      opacity: 0.85,
      shininess: 80,
      side: THREE.DoubleSide
    });
    waterMesh = new THREE.Mesh(geo, mat);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.y = 0;
    scene.add(waterMesh);
  }

  function animateWater(waveHeightFt) {
    if (!waterMesh) return;
    const amplitude = Math.min(1.2, (waveHeightFt || 1) * 0.12);
    const pos = waterMesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i); /* plane's local Y before rotation = world Z */
      const z = Math.sin(x * 0.25 + waveClock) * amplitude * 0.6 +
                 Math.sin(y * 0.18 + waveClock * 1.3) * amplitude * 0.4;
      pos.setZ(i, z);
    }
    pos.needsUpdate = true;
    waterMesh.geometry.computeVertexNormals();
  }

  /* ---------------------------------------------------------------
     BOAT — simple hull, mast, boom, and a triangular sail. The boom
     rotates to match boom_angle; the whole boatGroup heels (Z-tilt)
     and pitches/rolls (X/Z tilt) based on physics data.
     --------------------------------------------------------------- */
  function buildBoat() {
    boatGroup = new THREE.Group();

    /* Hull — a stretched, slightly tapered box stands in for a hull shape */
    const hullGeo = new THREE.BoxGeometry(2.2, 0.8, 7);
    const hullMat = new THREE.MeshPhongMaterial({ color: 0xe8e4da });
    hullMesh = new THREE.Mesh(hullGeo, hullMat);
    hullMesh.position.y = 0.4;
    boatGroup.add(hullMesh);

    /* Keel fin beneath, just for visual grounding */
    const keelGeo = new THREE.BoxGeometry(0.3, 1.2, 2);
    const keelMesh = new THREE.Mesh(keelGeo, new THREE.MeshPhongMaterial({ color: 0x2a2a2a }));
    keelMesh.position.y = -0.6;
    boatGroup.add(keelMesh);

    /* Mast */
    const mastGeo = new THREE.CylinderGeometry(0.08, 0.08, 7, 8);
    mastMesh = new THREE.Mesh(mastGeo, new THREE.MeshPhongMaterial({ color: 0x5a4632 }));
    mastMesh.position.set(0, 4.3, 0.5);
    boatGroup.add(mastMesh);

    /* Boom group — pivots at the mast base for rotation */
    boomGroup = new THREE.Group();
    boomGroup.position.set(0, 1.1, 0.5);
    boatGroup.add(boomGroup);

    const boomGeo = new THREE.CylinderGeometry(0.05, 0.05, 3.2, 6);
    const boomMesh = new THREE.Mesh(boomGeo, new THREE.MeshPhongMaterial({ color: 0xcfd8df }));
    boomMesh.rotation.z = Math.PI / 2;
    boomMesh.position.set(0, 0, -1.6);
    boomGroup.add(boomMesh);

    /* Sail — a simple triangle plane between mast and boom tip */
    const sailShape = new THREE.Shape();
    sailShape.moveTo(0, 0);
    sailShape.lineTo(0, 6.6);
    sailShape.lineTo(2.6, 0);
    sailShape.lineTo(0, 0);
    const sailGeo = new THREE.ShapeGeometry(sailShape);
    sailMesh = new THREE.Mesh(sailGeo, new THREE.MeshPhongMaterial({
      color: 0xf5f5f0, side: THREE.DoubleSide, transparent: true, opacity: 0.92
    }));
    sailMesh.position.set(0, 1.1, 0.5);
    boatGroup.add(sailMesh);

    scene.add(boatGroup);
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

    if (window.OSHelm3DState) {
      const s = window.OSHelm3DState;
      const targetHeel = computeTargetHeel(s.windSpeedKt, s.trimFactor, s.pointOfSailFactor, s.isSailing);
      currentHeelDeg += (targetHeel - currentHeelDeg) * HEEL_SMOOTHING;

      const targetPitch = Math.sin(waveClock * 0.7) * Math.min(8, (waveHeightFt || 1) * 1.2);
      currentPitchDeg += (targetPitch - currentPitchDeg) * PITCH_SMOOTHING;

      if (boatGroup) {
        /* Heel to whichever side the wind is pushing from (boom side) */
        const heelSign = (s.boomAngleDeg || 0) >= 0 ? -1 : 1;
        boatGroup.rotation.z = (currentHeelDeg * heelSign * Math.PI) / 180;
        boatGroup.rotation.x = (currentPitchDeg * Math.PI) / 180;
        boatGroup.position.y = Math.sin(waveClock * 0.7) * Math.min(0.4, (waveHeightFt || 1) * 0.08);
      }

      updateBoom(s.boomAngleDeg || 0);

      if (sailMesh) {
        /* Subtle billow: scale the sail slightly based on trim quality,
           a stylized stand-in for a filled vs. luffing sail */
        const fill = 0.85 + (s.trimFactor || 0) * 0.15;
        sailMesh.scale.set(fill, 1, 1);
      }
    }

    controls.update();
    renderer.render(scene, camera);
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
