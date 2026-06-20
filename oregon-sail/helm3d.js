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

  const HEEL_TIME_CONSTANT = 0.7;    /* seconds to close most of the heel gap */
  const PITCH_TIME_CONSTANT = 0.5;
  const HEADING_TIME_CONSTANT = 0.35; /* boat visually catches up to its real heading fairly quickly, but still eases instead of snapping */

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
    buildWake();
    buildWildlife();
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
     WILDLIFE — occasional fish (a small dorsal-fin wedge breaking
     the surface) that spawn near the boat, swim across, and vanish.
     Purely decorative/ambient, doesn't read any game state. A new
     one spawns every so often as long as there are fewer than a cap.
     --------------------------------------------------------------- */
  let wildlifeGroup = null;
  let lastWildlifeSpawn = 0;
  const MAX_WILDLIFE = 3;
  const WILDLIFE_SPAWN_INTERVAL = 8; /* seconds, roughly */

  function buildWildlife() {
    wildlifeGroup = new THREE.Group();
    scene.add(wildlifeGroup);
  }

  function spawnFish() {
    const finGeo = new THREE.ConeGeometry(0.12, 0.35, 4);
    const finMat = new THREE.MeshBasicMaterial({ color: 0x2e4a52 });
    const fin = new THREE.Mesh(finGeo, finMat);
    fin.rotation.x = Math.PI / 2.4;

    /* Spawn somewhere in a ring around the boat, not too close, not
       too far, heading on a random course across that area */
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnDist = 12 + Math.random() * 20;
    fin.position.set(Math.cos(spawnAngle) * spawnDist, 0.05, Math.sin(spawnAngle) * spawnDist);

    const headingAngle = Math.random() * Math.PI * 2;
    fin.rotation.y = headingAngle;
    fin.userData.vx = Math.sin(headingAngle) * 0.04;
    fin.userData.vz = Math.cos(headingAngle) * 0.04;
    fin.userData.life = 0;
    fin.userData.maxLife = 14 + Math.random() * 10; /* seconds before it despawns */

    wildlifeGroup.add(fin);
  }

  function animateWildlife(dtSeconds) {
    if (!wildlifeGroup) return;
    lastWildlifeSpawn += dtSeconds;
    if (lastWildlifeSpawn > WILDLIFE_SPAWN_INTERVAL && wildlifeGroup.children.length < MAX_WILDLIFE) {
      if (Math.random() < 0.4) spawnFish(); /* not guaranteed every interval, keeps it sparse */
      lastWildlifeSpawn = 0;
    }

    for (let i = wildlifeGroup.children.length - 1; i >= 0; i--) {
      const fin = wildlifeGroup.children[i];
      fin.position.x += fin.userData.vx;
      fin.position.z += fin.userData.vz;
      fin.position.y = 0.05 + Math.sin(waveClock * 3 + i) * 0.04; /* gentle bob, like breaking the surface */
      fin.userData.life += dtSeconds;
      if (fin.userData.life > fin.userData.maxLife) {
        wildlifeGroup.remove(fin);
      }
    }
  }

  /* ---------------------------------------------------------------
     GROUND PLANE — a simple flat-colored seabed/horizon backdrop.
     Previously stitched a 5×5 grid of real satellite tiles here, but
     that's been removed (per request) to keep this view purely
     focused on the boat/water/sky, and it was also a real perf cost
     (25 tile fetches + canvas redraws every time the boat moved far
     enough to trigger a refresh).
     --------------------------------------------------------------- */
  function buildGroundPlane() {
    const geo = new THREE.PlaneGeometry(900, 900);
    const mat = new THREE.MeshBasicMaterial({ color: 0x1f5870, transparent: true, opacity: 0.5 });
    groundMesh = new THREE.Mesh(geo, mat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.y = -0.05;
    scene.add(groundMesh);
  }

  /* ---------------------------------------------------------------
     WATER — animated plane using vertex displacement for a simple
     rolling-wave look, not a real ocean simulation.
     --------------------------------------------------------------- */
  const waterUniforms = {
    uTime: { value: 0 },
    uAmplitude: { value: 0.4 },
    uDeepColor: { value: new THREE.Color(0x2a73ad) },
    uLightColor: { value: new THREE.Color(0x6bb8e0) }
  };

  function buildWater() {
    const geo = new THREE.PlaneGeometry(300, 300, 60, 60);

    /* Two-tone water, computed entirely on the GPU instead of looping
       over ~3700 vertices in JavaScript every frame (a real CPU
       bottleneck that was contributing to the reported stutter). The
       vertex shader displaces each point with the same layered-sine
       ripple pattern as before; the fragment shader blends between a
       deep and light tone based on that same displacement. JS now
       only updates two small uniforms (time, amplitude) per frame. */
    const mat = new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      transparent: true,
      side: THREE.DoubleSide,
      vertexShader: `
        uniform float uTime;
        uniform float uAmplitude;
        varying float vRipple;
        void main() {
          float slowClock = uTime * 0.35;
          float ripple = sin(position.x * 0.18 + slowClock) * uAmplitude * 0.6
                       + sin(position.y * 0.14 + slowClock * 0.8) * uAmplitude * 0.4
                       + sin((position.x - position.y) * 0.09 + slowClock * 0.5) * uAmplitude * 0.25;
          vRipple = ripple / max(uAmplitude, 0.0001);
          vec3 displaced = vec3(position.x, position.y, ripple);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uDeepColor;
        uniform vec3 uLightColor;
        varying float vRipple;
        void main() {
          float t = clamp((vRipple + 1.0) / 2.0, 0.0, 1.0);
          vec3 color = mix(uDeepColor, uLightColor, t);
          gl_FragColor = vec4(color, 0.6);
        }
      `
    });

    waterMesh = new THREE.Mesh(geo, mat);
    waterMesh.rotation.x = -Math.PI / 2;
    waterMesh.position.y = 0;
    scene.add(waterMesh);
  }

  function animateWater(waveHeightFt) {
    if (!waterMesh) return;
    /* Calmer, slower amplitude than before — the previous version
       moved noticeably too fast for a relaxed sailing feel. Just two
       uniform writes now; the actual per-vertex work happens on the
       GPU in the shader above. */
    waterUniforms.uAmplitude.value = Math.min(1.0, (waveHeightFt || 1) * 0.14);
    waterUniforms.uTime.value = waveClock;
  }

  /* ---------------------------------------------------------------
     WAKE — a simple V-shaped trail behind the stern that widens and
     brightens with speed, so the player has a visual cue that the
     boat is actually moving even when the camera angle makes the
     surrounding water's own animation hard to judge by itself.
     --------------------------------------------------------------- */
  let bowWaveMesh = null;
  let wakeTrailMesh = null;
  let wakeHistory = []; /* { x, z, t } world-space points sampled behind the boat over time */
  const WAKE_LIFETIME_SEC = 15;
  const WAKE_MAX_POINTS = 90; /* sampled at ~6/sec for 15s of trail */
  const WAKE_SAMPLE_INTERVAL = WAKE_LIFETIME_SEC / WAKE_MAX_POINTS;
  let wakeSampleClock = 0;

  function buildWake() {
    /* Wake trail — a ribbon built from the boat's actual recorded
       path over the last ~15 seconds, instead of a fixed shape
       attached to the stern. Lives directly in the scene (not
       parented to boatGroup) since it needs to stay behind at each
       position the boat actually was, not move/rotate with it now. */
    const maxVerts = WAKE_MAX_POINTS * 2; /* two edge vertices per sample point */
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(maxVerts * 3), 3));
    geo.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(maxVerts), 1));
    const indices = [];
    for (let i = 0; i < WAKE_MAX_POINTS - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
    geo.setIndex(indices);
    geo.setDrawRange(0, 0); /* nothing to draw until we have history */

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(0.92, 0.97, 1.0, vAlpha * 0.45);
        }
      `
    });

    wakeTrailMesh = new THREE.Mesh(geo, mat);
    scene.add(wakeTrailMesh);

    /* Bow wave — a small breaking-white wedge right at the bow,
       widening with speed the same way real water piles up and
       breaks at the bow of a moving boat. This one stays attached
       to the boat since it's an immediate effect, not a history trail. */
    const bowGeo = new THREE.BufferGeometry();
    const bowVerts = new Float32Array([
      0, 0, 0,    0.7, 0, -0.9,   0.18, 0, 0.5,
      0, 0, 0,   -0.7, 0, -0.9,  -0.18, 0, 0.5
    ]);
    bowGeo.setAttribute("position", new THREE.BufferAttribute(bowVerts, 3));
    bowGeo.setIndex([0, 1, 2, 3, 4, 5]);
    const bowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false
    });
    bowWaveMesh = new THREE.Mesh(bowGeo, bowMat);
    /* Bow point of the hull is at local Z = 4.2 */
    bowWaveMesh.position.set(0, 0.08, 4.0);
    boatGroup.add(bowWaveMesh);
  }

  /* Each entry: { dx, dz, t } - offset from the boat's CURRENT
     position (in the boat's own local/world-aligned XZ plane) where
     the boat actually was `t` seconds ago, reconstructed by
     integrating recorded heading+speed backward in time. Since
     boatGroup never actually translates in this scene (the world is
     boat-centered; the ground texture scrolls instead), we can't
     record real XZ history — this is the local equivalent. */
  function recordWakePoint(headingDeg, speedKt, dtSeconds) {
    wakeSampleClock += dtSeconds;
    if (wakeSampleClock < WAKE_SAMPLE_INTERVAL) return;
    const interval = wakeSampleClock;
    wakeSampleClock = 0;

    /* Age every existing point and push them further behind by how
       far the boat has traveled in this sample interval */
    const headingRad = (headingDeg * Math.PI) / 180;
    const nm = (speedKt || 0) * (interval / 3600);
    /* World-units-per-nm is arbitrary in this stylized scene; reuse
       the same rough scale the wake/boat geometry already uses */
    const moveDist = nm * 60;
    const moveX = -Math.sin(headingRad) * moveDist;
    const moveZ = -Math.cos(headingRad) * moveDist;

    wakeHistory.forEach(p => { p.dx += moveX; p.dz += moveZ; p.t += interval; });

    if ((speedKt || 0) >= 0.3) {
      wakeHistory.push({ dx: 0, dz: 0, t: 0 });
    }
    if (wakeHistory.length > WAKE_MAX_POINTS) wakeHistory.shift();
  }

  function updateWakeTrail(dtSeconds) {
    if (!wakeTrailMesh) return;
    wakeHistory = wakeHistory.filter(p => p.t < WAKE_LIFETIME_SEC);

    const pos = wakeTrailMesh.geometry.attributes.position;
    const alpha = wakeTrailMesh.geometry.attributes.alpha;
    const n = wakeHistory.length;

    if (n < 2) {
      wakeTrailMesh.geometry.setDrawRange(0, 0);
      return;
    }

    for (let i = 0; i < n; i++) {
      const p = wakeHistory[i];
      /* Width tapers from narrow (oldest/aft) to the boat's stern
         width (newest), and fades out as it ages past the lifetime */
      const ageT = p.t / WAKE_LIFETIME_SEC;
      const fade = Math.max(0, 1 - ageT);
      const halfWidth = 0.15 + (i / Math.max(1, n - 1)) * 0.55;

      /* Perpendicular direction for ribbon width — approximate using
         the segment direction to the next point (or previous, at the end) */
      const next = wakeHistory[i + 1] || wakeHistory[i - 1] || p;
      const ddx = next.dx - p.dx, ddz = next.dz - p.dz;
      const len = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
      const perpX = (-ddz / len) * halfWidth;
      const perpZ = (ddx / len) * halfWidth;

      pos.setXYZ(i * 2, p.dx + perpX, 0.04, p.dz + perpZ);
      pos.setXYZ(i * 2 + 1, p.dx - perpX, 0.04, p.dz - perpZ);
      alpha.setX(i * 2, fade);
      alpha.setX(i * 2 + 1, fade);
    }

    pos.needsUpdate = true;
    alpha.needsUpdate = true;
    wakeTrailMesh.geometry.setDrawRange(0, (n - 1) * 6);

    /* Anchor the trail at the boat's current stern position/heading.
       The dx/dz offsets recorded above are already in world-aligned
       (heading-relative-at-the-time) terms, so the mesh itself stays
       unrotated — only translated to the boat's current location. */
    if (currentHeadingDeg != null && boatGroup) {
      wakeTrailMesh.position.set(boatGroup.position.x, 0, boatGroup.position.z);
    }
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
       small round portholes along each side, sitting on deck. Built
       from simple, reliable primitives (box walls + a tilted roof
       plane) rather than hand-indexed triangles, which were fragile
       and prone to rendering incorrectly.
       --------------------------------------------------------------- */
    const cabinMat = new THREE.MeshPhongMaterial({ color: 0xf2efe6, flatShading: true });
    const cabinCenterZ = 0.3;   /* center of the cabin trunk, aft-to-fore */
    const cabinLength = 2.7;    /* aft edge to where it tapers in toward the bow */
    const cabinWidth = 1.7;
    const cabinWallHeight = 0.85;

    /* Cabin walls — a straightforward box, sides clipped narrower
       toward the bow by the separately-placed roof's slope/taper look */
    const cabinWallGeo = new THREE.BoxGeometry(cabinWidth, cabinWallHeight, cabinLength);
    const cabinWallMesh = new THREE.Mesh(cabinWallGeo, cabinMat);
    cabinWallMesh.position.set(0, deckY + cabinWallHeight / 2, cabinCenterZ);
    boatGroup.add(cabinWallMesh);

    /* Roof — a single tilted plane sitting on top of the walls,
       angled down toward the bow (+Z) for a real cabin-trunk look */
    const roofGeo = new THREE.BoxGeometry(cabinWidth + 0.1, 0.08, cabinLength + 0.2);
    const roofMesh = new THREE.Mesh(roofGeo, cabinMat);
    roofMesh.position.set(0, deckY + cabinWallHeight + 0.04, cabinCenterZ);
    roofMesh.rotation.x = -0.12; /* slopes down toward the bow */
    boatGroup.add(roofMesh);

    const portholeMat = new THREE.MeshPhongMaterial({ color: 0x1a2a35 });
    const portholeGeo = new THREE.CircleGeometry(0.16, 12);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 3; i++) {
        const porthole = new THREE.Mesh(portholeGeo, portholeMat);
        porthole.position.set(
          side * (cabinWidth / 2 + 0.01),
          deckY + cabinWallHeight / 2 + 0.1,
          cabinCenterZ - cabinLength / 2 + 0.5 + i * 0.85
        );
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
        /* Cylinder's default long axis is Y. Rotating on X lays it
           along Z first, THEN yawing on Y aims that Z-aligned segment
           toward the real stanchion-to-stanchion direction. The
           previous order (Z then Y) laid it along X instead, which
           is the reported 90°-off lifelines. */
        line.rotation.x = Math.PI / 2;
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
    /* Headsail (jib) — a roller-furling jib. Tack is raised above the
       cabin top (previously sat near deck level, which put the sail
       behind/below the cabin roof instead of clearing over it). The
       luff (mast-base-to-masthead edge) is the furl axis: furling
       wraps the sail around that vertical axis like a real roller
       furler, rather than just scaling it flat. */
    headsailGroup = new THREE.Group();
    headsailGroup.position.set(mastX, deckY + 1.3, mastZ); /* tack now clears above the cabin roof */
    boatGroup.add(headsailGroup);

    const headsailGeo = new THREE.BufferGeometry();
    const headsailVerts = new Float32Array([
      0, 0, 0,        /* tack, at the headsailGroup origin */
      0, 5.0, 0,      /* head, up near the masthead */
      0, 0, 3.3       /* clew, forward toward the bow */
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
  /* jibFurlPct: 0 (fully furled/rolled up) .. 100 (full jib out).
     Wraps the sail around its luff (the vertical mast/forestay edge,
     local Y axis of headsailGroup) as it furls — rotating it to the
     port side (negative Y rotation) while shrinking its foot/leech
     extent, reading as the sail winding itself up around the
     forestay rather than just shrinking in place. */
  function updateHeadsailReef(jibFurlPct) {
    if (!headsailMesh) return;
    const pct = Math.max(0, Math.min(100, jibFurlPct)) / 100;
    headsailMesh.scale.z = pct;
    headsailMesh.rotation.y = -(1 - pct) * (Math.PI / 2.2); /* wraps toward the other side as it furls */
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

  const TARGET_FPS = 30;
  const FRAME_BUDGET_MS = 1000 / TARGET_FPS;
  let lastFrameTime = 0;

  function tick() {
    animFrameId = requestAnimationFrame(tick);

    /* Cap rendering at 30fps — requestAnimationFrame fires at the
       display's native rate (often 60Hz+), but we don't need that
       many updates for this stylized scene, and capping it reduces
       battery/CPU load to a more sustainable level on phones. */
    const now = performance.now();
    if (now - lastFrameTime < FRAME_BUDGET_MS) return;
    lastFrameTime = now;

    waveClock += 0.04; /* doubled from 0.02 since this now runs at 30fps (throttled) instead of 60fps, keeping the same real-time speed */

    const waveHeightFt = window.OSHelm3DState ? window.OSHelm3DState.waveHeightFt : 1;
    animateWater(waveHeightFt);
    animateWindLines(1);
    animateSky(1);
    animateWildlife(0.033); /* matches the real ~33ms frame budget at 30fps now, not a 60fps assumption */
    if (window.OSHelm3DState) {
      const speedKt = window.OSHelm3DState.speedKt || 0;
      recordWakePoint(currentHeadingDeg || window.OSHelm3DState.heading || 0, speedKt, 0.033);
      if (bowWaveMesh) {
        const t = Math.min(1, Math.max(0, speedKt) / 6);
        bowWaveMesh.visible = speedKt > 0.5;
        bowWaveMesh.scale.set(0.6 + t * 1.4, 1, 0.6 + t * 1.4);
        bowWaveMesh.material.opacity = 0.35 + t * 0.45;
      }
    }
    updateWakeTrail(0.033);
    updateWindLines(window.OSHelm3DState ? window.OSHelm3DState.windSpeedKt || 0 : 0);

    if (window.OSHelm3DState) {
      const s = window.OSHelm3DState;
      /* Time-based exponential easing — closes a consistent FRACTION
         of the remaining gap per real second, independent of how
         often this function actually runs. The previous version used
         a fixed per-call fraction (e.g. heading += delta * 0.15),
         which made motion framerate-dependent: at 60fps it looked
         reasonably smooth, but capping to 30fps (or any frame drop)
         immediately made turns choppier since the same fraction was
         now only being applied half as often. This is the real fix
         for the reported "small fast clippings" turning feel. */
      const dt = FRAME_BUDGET_MS / 1000; /* seconds per (throttled) frame */
      const heelAlpha = 1 - Math.exp(-dt / HEEL_TIME_CONSTANT);
      const pitchAlpha = 1 - Math.exp(-dt / PITCH_TIME_CONSTANT);
      const headingAlpha = 1 - Math.exp(-dt / HEADING_TIME_CONSTANT);

      const targetHeel = computeTargetHeel(s.windSpeedKt, s.trimFactor, s.pointOfSailFactor, s.isSailing);
      currentHeelDeg += (targetHeel - currentHeelDeg) * heelAlpha;

      /* Gentle idle rocking even with sails down / calm water — a
         becalmed or anchored boat should still bob slightly rather
         than sit perfectly rigid, which read as static/lifeless */
      const effectiveWaveHeight = s.isSailing ? (waveHeightFt || 1) : Math.max(0.5, (waveHeightFt || 1) * 0.5);
      const targetPitch = Math.sin(waveClock * 0.7) * Math.min(8, effectiveWaveHeight * 1.2);
      currentPitchDeg += (targetPitch - currentPitchDeg) * pitchAlpha;

      /* Heading — the boat's actual facing direction. Smoothed with
         proper angle-wrapping so it doesn't spin the long way around
         when crossing the 0/360 boundary (e.g. 350° -> 10°). */
      if (typeof s.heading === "number") {
        if (currentHeadingDeg == null) currentHeadingDeg = s.heading;
        let delta = ((s.heading - currentHeadingDeg + 540) % 360) - 180;
        currentHeadingDeg = (currentHeadingDeg + delta * headingAlpha + 360) % 360;
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
    setState: function (state) {
      window.OSHelm3DState = state;
    },
    resize: onResize
  };
})();
