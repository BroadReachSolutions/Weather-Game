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
    const geo = new THREE.PlaneGeometry(300, 300, 50, 50);
    /* RuneScape-style water: flat, saturated, slightly translucent
       blue with a bright specular highlight rather than realistic
       reflections — a stylized "toy ocean" look */
    const mat = new THREE.MeshPhongMaterial({
      color: 0x2e9bd6,
      specular: 0xbfe9ff,
      shininess: 120,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
      flatShading: true
    });
    waterMesh = new THREE.Mesh(geo, mat);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.y = 0;
    scene.add(waterMesh);

    /* A lighter cap layer of small foam-cap dots for visual texture,
       purely decorative — stylized whitecaps */
    const foamGeo = new THREE.PlaneGeometry(300, 300, 50, 50);
    const foamMat = new THREE.MeshBasicMaterial({
      color: 0xeaf8ff, transparent: true, opacity: 0.18,
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
    /* Bigger, chunkier amplitude than a realistic ocean — stylized,
       readable swell rather than subtle ripples */
    const amplitude = Math.min(2.2, (waveHeightFt || 1) * 0.28);
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

    /* Hull — extruded from a top-down silhouette with a pointed bow
       (+Z) and a flat transom stern (-Z), instead of a plain box */
    const hullShape = new THREE.Shape();
    hullShape.moveTo(0, 4.2);       /* bow point */
    hullShape.quadraticCurveTo(0.9, 2.6, 1.05, 0.5);
    hullShape.lineTo(1.05, -2.6);   /* starboard side to stern */
    hullShape.lineTo(-1.05, -2.6);  /* transom (stern) */
    hullShape.lineTo(-1.05, 0.5);
    hullShape.quadraticCurveTo(-0.9, 2.6, 0, 4.2); /* port side back to bow */

    const hullExtrude = new THREE.ExtrudeGeometry(hullShape, { depth: 0.9, bevelEnabled: false });
    hullExtrude.rotateX(Math.PI / 2);
    const hullMat = new THREE.MeshPhongMaterial({ color: 0xe8e4da, flatShading: true });
    hullMesh = new THREE.Mesh(hullExtrude, hullMat);
    hullMesh.position.y = 0.1;
    boatGroup.add(hullMesh);

    /* A contrasting hull stripe / rubrail for visual definition */
    const stripeGeo = new THREE.BoxGeometry(2.16, 0.12, 6.9);
    const stripeMesh = new THREE.Mesh(stripeGeo, new THREE.MeshPhongMaterial({ color: 0x1565c0 }));
    stripeMesh.position.set(0, 0.45, 0.8);
    boatGroup.add(stripeMesh);

    /* Keel fin beneath, just for visual grounding */
    const keelGeo = new THREE.BoxGeometry(0.3, 1.2, 2);
    const keelMesh = new THREE.Mesh(keelGeo, new THREE.MeshPhongMaterial({ color: 0x2a2a2a }));
    keelMesh.position.y = -0.6;
    boatGroup.add(keelMesh);

    /* Mast — positioned forward of center, the boom and sails attach to it */
    const mastX = 0, mastZ = 0.6;
    const mastGeo = new THREE.CylinderGeometry(0.08, 0.08, 7, 8);
    mastMesh = new THREE.Mesh(mastGeo, new THREE.MeshPhongMaterial({ color: 0x5a4632 }));
    mastMesh.position.set(mastX, 4.3, mastZ);
    boatGroup.add(mastMesh);

    /* Boom group — pivots exactly at the mast's base/centerline so it
       reads as properly attached, not floating beside the mast */
    boomGroup = new THREE.Group();
    boomGroup.position.set(mastX, 1.2, mastZ);
    boatGroup.add(boomGroup);

    const boomLen = 3.2;
    const boomGeo = new THREE.CylinderGeometry(0.05, 0.05, boomLen, 6);
    const boomMesh = new THREE.Mesh(boomGeo, new THREE.MeshPhongMaterial({ color: 0xcfd8df }));
    boomMesh.rotation.z = Math.PI / 2;
    boomMesh.position.set(0, 0, -boomLen / 2); /* extends aft from the mast pivot */
    boomGroup.add(boomMesh);

    /* Mainsail — triangle from mast (at boom pivot height up to mast
       top) back to the boom tip, attached at the mast the whole time */
    const sailShape = new THREE.Shape();
    sailShape.moveTo(0, 0);
    sailShape.lineTo(0, 6.0);
    sailShape.lineTo(0, 0);
    /* Build as a triangle fan so it stays visually attached to the
       mast edge regardless of boom rotation (the geometry's one edge
       IS the mast, the opposite point is the boom tip in boomGroup) */
    const mainsailGeo = new THREE.BufferGeometry();
    const mainsailVerts = new Float32Array([
      0, 0, 0,      /* mast base (boom pivot height) */
      0, 6.0, 0,    /* mast top */
      0, 0, -boomLen /* boom tip (local to boomGroup) */
    ]);
    mainsailGeo.setAttribute("position", new THREE.BufferAttribute(mainsailVerts, 3));
    mainsailGeo.setIndex([0, 1, 2]);
    mainsailGeo.computeVertexNormals();
    sailMesh = new THREE.Mesh(mainsailGeo, new THREE.MeshPhongMaterial({
      color: 0xf5f5f0, side: THREE.DoubleSide, transparent: true, opacity: 0.92, flatShading: true
    }));
    boomGroup.add(sailMesh); /* parented to boomGroup so it swings with the boom but stays mast-attached */

    /* Headsail (jib) — forward of the mast, between the bow and a
       point partway up the mast. Height scales with reef level:
       full sail = full height, reef 1 = partly down, reef 2 = mostly
       down, matching the request directly. */
    const headsailGeo = new THREE.BufferGeometry();
    const headsailVerts = new Float32Array([
      mastX, 0.9, mastZ,   /* tack, near the mast base */
      mastX, 5.2, mastZ,   /* head, partway up the mast */
      mastX, 0.9, 3.9      /* clew, forward toward the bow */
    ]);
    headsailGeo.setAttribute("position", new THREE.BufferAttribute(headsailVerts, 3));
    headsailGeo.setIndex([0, 1, 2]);
    headsailGeo.computeVertexNormals();
    headsailMesh = new THREE.Mesh(headsailGeo, new THREE.MeshPhongMaterial({
      color: 0xf0f0ec, side: THREE.DoubleSide, transparent: true, opacity: 0.9, flatShading: true
    }));
    boatGroup.add(headsailMesh);

    /* Wind speed lines — small streaming lines near the mast that
       get longer/thicker with stronger wind, give a sense of wind
       force the way flags or pennants would */
    windLinesGroup = new THREE.Group();
    windLinesGroup.position.set(mastX, 6.0, mastZ);
    boatGroup.add(windLinesGroup);

    scene.add(boatGroup);
  }

  /* reefLevel: 0 = full sail, 1 = reef 1 (partly down), 2 = reef 2
     (mostly down). Scales the headsail's visible height to match. */
  function updateHeadsailReef(reefLevel) {
    if (!headsailMesh) return;
    const scaleByReef = { 0: 1.0, 1: 0.6, 2: 0.3 };
    const scale = scaleByReef[reefLevel] != null ? scaleByReef[reefLevel] : 1.0;
    headsailMesh.scale.y = scale;
  }

  /* Rebuilds the small streaming wind-speed lines near the masthead.
     More lines + longer + thicker as wind speed increases, fewer and
     shorter in light air — a simple visual wind-force indicator. */
  let lastWindLineSpeedKt = -1;
  function updateWindLines(windSpeedKt) {
    if (!windLinesGroup) return;
    const rounded = Math.round(windSpeedKt);
    if (rounded === lastWindLineSpeedKt) return; /* avoid rebuilding every frame */
    lastWindLineSpeedKt = rounded;

    while (windLinesGroup.children.length) windLinesGroup.remove(windLinesGroup.children[0]);

    const count = Math.max(2, Math.min(6, Math.round(2 + windSpeedKt / 5)));
    const length = Math.max(0.4, Math.min(1.6, 0.4 + windSpeedKt * 0.06));
    const thickness = Math.max(0.015, Math.min(0.05, 0.015 + windSpeedKt * 0.002));

    for (let i = 0; i < count; i++) {
      const geo = new THREE.CylinderGeometry(thickness, thickness, length, 4);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
      const line = new THREE.Mesh(geo, mat);
      line.rotation.z = Math.PI / 2; /* lay it horizontal, streaming aft */
      line.position.set((i - count / 2) * 0.18, 0.1 - i * 0.05, -length / 2);
      windLinesGroup.add(line);
    }
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
      updateHeadsailReef(s.isSailing ? (s.reefLevel || 0) : 3); /* 3 = fully down, not sailing */
      updateWindLines(s.windSpeedKt || 0);

      /* Sails visible only while sailing_active; mainsail billow is a
         subtle camber bend (Z displacement of the boom-tip vertex)
         rather than X-scaling, since it's a flat triangle fan now */
      if (sailMesh) {
        sailMesh.visible = !!s.isSailing;
        const fill = (s.trimFactor || 0) * 0.4; /* 0..0.4 units of camber */
        const posAttr = sailMesh.geometry.attributes.position;
        posAttr.setX(2, fill); /* boom-tip vertex bows outward slightly when well-trimmed */
        posAttr.needsUpdate = true;
      }
      if (headsailMesh) headsailMesh.visible = !!s.isSailing;
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
