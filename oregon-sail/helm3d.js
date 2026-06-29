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

  /* ---------------------------------------------------------------
     GLOBAL SCALE CONVENTION
     The Boat Designer's max Hull Length slider value (12 scene
     units) now represents a real 50ft boat -- this is the one
     conversion factor everything distance-related in the scene
     derives from (render distance, water flow speed, AI boat speed),
     replacing the previous disconnected conventions (a separate
     60-units-per-nm rule for the wake trail, an unrelated tuned
     constant for the water-flow visual effect) that didn't agree
     with each other or with the boat's own actual size.
     --------------------------------------------------------------- */
  const UNITS_PER_FOOT = 12 / 50; /* 0.24 */
  const FEET_PER_UNIT = 1 / UNITS_PER_FOOT;
  const UNITS_PER_NM = UNITS_PER_FOOT * 6076.12; /* derived, not a separate tuned constant */
  const WATER_VISUAL_SPEED_MULTIPLIER = 2; /* purely visual -- water surface scrolls twice as fast as real boat speed would imply, per request, without touching actual boat physics/movement */
  let sunLight, ambientLight;
  let boatGroup, hullMesh, mastMesh, boomGroup, sailMesh, headsailGroup;
  let waterMesh, groundMesh;
  let animFrameId = null;
  let canvasEl = null;

  let currentHeelDeg = 0;   /* side-to-side tilt from wind force on sails */
  let currentPitchDeg = 0;  /* bow-up/down from waves */
  let currentWaveRollDeg = 0;   /* smoothed wave-driven roll, eased to avoid per-frame jitter */
  let currentWavePitchDeg = 0;  /* smoothed wave-driven pitch */
  let currentWaveBobY = 0;      /* smoothed vertical bob from riding the swell */
  let currentHeadingDeg = null; /* boat's facing direction, null until first state arrives */
  let waterFlowHeadingDeg = null; /* separate, faster-reacting heading reference for water flow direction specifically -- decoupled from the boat's own intentionally slow/smooth visual turn rate, so the water doesn't visually lag behind a turn */
  let currentTurnLeanDeg = 0;   /* centrifugal lean into turns */
  let waveClock = 0;

  const HEEL_TIME_CONSTANT = 0.7;    /* seconds to close most of the heel gap */
  const PITCH_TIME_CONSTANT = 0.5;
  const HEADING_TIME_CONSTANT = 0.65; /* slowed further for a smoother, less abrupt turn — was 0.35 */
  const WAVE_MOTION_TIME_CONSTANT = 0.35; /* smooths wave-driven roll/pitch/bob so riding the swells reads as fluid motion instead of frame-to-frame jitter */

  /* ---------------------------------------------------------------
     SCENE SETUP
     --------------------------------------------------------------- */
  function initScene() {
    canvasEl = document.getElementById("osHelm3D");
    if (!canvasEl || !window.THREE) return false;

    scene = new THREE.Scene();
    /* Background is now a gradient skydome (see buildSky/updateSkyGradient)
       rather than a flat scene.background color, driven by the day/
       night cycle — no initial color needed here, the dome takes over
       on the very next frame. */
    scene.fog = new THREE.Fog(0x9fd3e8, 444, 634); /* slight fog starting at ~70% of the new 0.5mi (634-unit) render radius, full fog at the radius itself */

    const wrap = document.getElementById("osHelmViewWrap");
    const w = wrap.clientWidth || 360;
    const h = wrap.clientHeight || 240;

    camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 1267); /* generously exceeds the new 634-unit (0.5mi) view radius */
    camera.position.set(0, 18, 32);

    renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    /* Lighting — simple sun + ambient fill. Kept as module state so
       the day/night cycle can retint/reposition them over time. */
    sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    sunLight.position.set(30, 50, 20);
    scene.add(sunLight);
    ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambientLight);

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
    buildDayNightSky();

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

  let skyDomeMesh = null;
  let skyDomeCanvas = null;
  let skyDomeCtx = null;
  let skyDomeTexture = null;

  function buildSky() {
    /* Gradient sky — a large inverted sphere with a canvas-generated
       texture (deep blue at the top, lighter cyan near the horizon),
       instead of a single flat background color. Redrawn whenever
       the day/night cycle's colors change, since a canvas texture
       needs an explicit redraw + needsUpdate rather than a simple
       color property like scene.background had. */
    skyDomeCanvas = document.createElement("canvas");
    skyDomeCanvas.width = 2;
    skyDomeCanvas.height = 256;
    skyDomeCtx = skyDomeCanvas.getContext("2d");
    skyDomeTexture = new THREE.CanvasTexture(skyDomeCanvas);
    skyDomeTexture.wrapS = THREE.ClampToEdgeWrapping;
    skyDomeTexture.wrapT = THREE.ClampToEdgeWrapping;

    const domeGeo = new THREE.SphereGeometry(887, 24, 16); /* comfortably exceeds the new 634-unit (0.5mi) water radius */
    const domeMat = new THREE.MeshBasicMaterial({
      map: skyDomeTexture, side: THREE.BackSide, depthWrite: false, fog: false
    });
    skyDomeMesh = new THREE.Mesh(domeGeo, domeMat);
    scene.add(skyDomeMesh);
    scene.background = null; /* the dome itself is now the background, not a flat color */

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
      cluster.position.set(Math.cos(angle) * dist, 75 + Math.random() * 30, Math.sin(angle) * dist);
      cluster.userData.driftSpeed = 0.15 + Math.random() * 0.15;
      cloudGroup.add(cluster);
    }
    scene.add(cloudGroup);
  }

  /* Redraws the skydome's gradient texture between a top color and a
     horizon color — called from the day/night cycle whenever those
     colors change, instead of just setting scene.background directly. */
  function updateSkyGradient(topColor, horizonColor) {
    if (!skyDomeCtx) return;
    const grad = skyDomeCtx.createLinearGradient(0, 0, 0, skyDomeCanvas.height);
    grad.addColorStop(0, `#${topColor.getHexString()}`);
    grad.addColorStop(1, `#${horizonColor.getHexString()}`);
    skyDomeCtx.fillStyle = grad;
    skyDomeCtx.fillRect(0, 0, skyDomeCanvas.width, skyDomeCanvas.height);
    skyDomeTexture.needsUpdate = true;
  }

  function animateSky(elapsedFactor) {
    if (!cloudGroup) return;
    cloudGroup.children.forEach((cluster) => {
      cluster.position.x += cluster.userData.driftSpeed * elapsedFactor;
      if (cluster.position.x > 140) cluster.position.x = -140;
    });
  }

  /* ---------------------------------------------------------------
     DAY / NIGHT CYCLE
     Driven by the player's actual real-world local time (a sailor's
     clock doesn't reset every few minutes) — dawn/dusk transitions
     happen at roughly realistic hours, the sky/fog/water retint
     smoothly through the day, the sun arcs across the sky and dims
     into a moon at night, and a starfield fades in once the sun is
     well below the horizon.
     --------------------------------------------------------------- */
  let starsMesh = null;
  let moonMesh = null;
  let nightSkyDome = null;

  const SKY_DAY = new THREE.Color(0x2a6fd6);        /* deep blue, top of dome */
  const SKY_DAY_HORIZON = new THREE.Color(0x9fe0f0); /* lighter cyan near the horizon */
  const SKY_SUNSET = new THREE.Color(0xf2935a);
  const SKY_SUNSET_HORIZON = new THREE.Color(0xffd9a0);
  const SKY_NIGHT = new THREE.Color(0x040a1f);
  const SKY_NIGHT_HORIZON = new THREE.Color(0x0a1430);
  const FOG_DAY = new THREE.Color(0x9fd3e8);
  const FOG_SUNSET = new THREE.Color(0xd9a06e);
  const FOG_NIGHT = new THREE.Color(0x0a1430);
  const WATER_DEEP_DAY = new THREE.Color(0x1f8fd4);
  const WATER_DEEP_NIGHT = new THREE.Color(0x041830);
  const WATER_LIGHT_DAY = new THREE.Color(0x6bd0f0);
  const WATER_LIGHT_NIGHT = new THREE.Color(0x163048);

  function buildDayNightSky() {
    /* Starfield — a sprite-point cloud on a large sphere, hidden by
       day, fading in as the sun sets. Increased density and added
       per-star size variation so the night sky reads as a real
       starfield rather than a sparse scatter. */
    const starCount = 1400;
    const starPositions = new Float32Array(starCount * 3);
    const starSizes = new Float32Array(starCount);
    for (let i = 0; i < starCount; i++) {
      /* Random point on a large sphere above the horizon */
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.48; /* keep them in the upper sky */
      const r = 877; /* just inside the skydome's own radius (887) so stars sit right at its surface */
      starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.cos(phi) + 20;
      starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      starSizes[i] = 0.8 + Math.random() * 2.2; /* most stars small/dim, a few bigger/brighter */
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    starGeo.setAttribute("size", new THREE.BufferAttribute(starSizes, 1));

    /* PointsMaterial only supports a single global size, not per-
       vertex sizes from a buffer attribute -- using a small custom
       shader instead so the size variation set above actually has
       an effect (most stars small/dim, a few bigger/brighter). */
    const starOpacityUniform = { value: 0 };
    const starMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: starOpacityUniform },
      transparent: true,
      depthWrite: false,
      vertexShader: `
        attribute float size;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        void main() {
          /* Soft round dot instead of a square point sprite */
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float edge = smoothstep(0.5, 0.1, d);
          gl_FragColor = vec4(1.0, 1.0, 1.0, uOpacity * edge);
        }
      `
    });
    starsMesh = new THREE.Points(starGeo, starMat);
    starsMesh.userData.opacityUniform = starOpacityUniform;
    scene.add(starsMesh);

    /* Moon — a simple pale disc, opposite the sun's arc */
    const moonGeo = new THREE.CircleGeometry(8, 20);
    const moonMat = new THREE.MeshBasicMaterial({
      color: 0xe8eef5, transparent: true, opacity: 0, depthWrite: false
    });
    moonMesh = new THREE.Mesh(moonGeo, moonMat);
    scene.add(moonMesh);
  }

  /* Returns 0..1 representing time of day (0 = midnight, 0.5 = noon)
     from the player's real local clock. */
  function getTimeOfDayFraction() {
    /* Dev console override: lets the dev directly set a time of day
       for testing the day/night cycle without waiting for real time
       to pass. window.OSDevClockOverride is a 0..24 hour value. */
    if (window.OSDevClockOverride != null) {
      return (window.OSDevClockOverride % 24) / 24;
    }
    const now = new Date();
    return (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
  }

  function animateDayNight() {
    if (!scene || !sunLight) return;
    const t = getTimeOfDayFraction();

    /* Sun angle: a full circle over 24h, peaking at noon (t=0.5) */
    const sunAngle = (t - 0.25) * Math.PI * 2; /* sunrise ~0.25 (6am), sunset ~0.75 (6pm) */
    const sunHeight = Math.sin(sunAngle);      /* -1 at midnight, +1 at noon */
    const sunDist = 120;
    sunLight.position.set(Math.cos(sunAngle) * sunDist, Math.max(-20, sunHeight * 90 + 20), -40);

    /* dayFactor: 0 at deep night, 1 at full day, smoothly transitioning
       through dawn/dusk rather than snapping */
    const dayFactor = Math.max(0, Math.min(1, (sunHeight + 0.15) / 0.3));
    /* sunsetFactor: peaks around dawn/dusk specifically, for the warm
       orange tint, fading out at both full day and full night */
    const sunsetFactor = Math.max(0, 1 - Math.abs(sunHeight) / 0.35) * (1 - Math.abs(dayFactor - 0.5) * 0.3);

    const skyColor = SKY_NIGHT.clone().lerp(SKY_DAY, dayFactor).lerp(SKY_SUNSET, sunsetFactor * 0.5);
    const skyHorizonColor = SKY_NIGHT_HORIZON.clone().lerp(SKY_DAY_HORIZON, dayFactor).lerp(SKY_SUNSET_HORIZON, sunsetFactor * 0.5);
    const fogColor = FOG_NIGHT.clone().lerp(FOG_DAY, dayFactor).lerp(FOG_SUNSET, sunsetFactor * 0.5);
    updateSkyGradient(skyColor, skyHorizonColor);
    if (scene.fog) scene.fog.color.copy(fogColor);

    sunLight.intensity = 0.15 + dayFactor * 0.9;
    ambientLight.intensity = 0.25 + dayFactor * 0.4;
    sunLight.color.set(sunsetFactor > 0.3 ? 0xffcfa0 : 0xffffff);

    /* Water retint — darker, more muted at night */
    waterUniforms.uDeepColor.value.copy(WATER_DEEP_NIGHT).lerp(WATER_DEEP_DAY, dayFactor);
    waterUniforms.uLightColor.value.copy(WATER_LIGHT_NIGHT).lerp(WATER_LIGHT_DAY, dayFactor);

    /* Stars fade in as the sun drops well below the horizon */
    if (starsMesh && starsMesh.userData.opacityUniform) {
      const starOpacity = Math.max(0, Math.min(0.9, (0.05 - sunHeight) * 2.5));
      starsMesh.userData.opacityUniform.value = starOpacity;
    }

    /* Moon mirrors the sun's arc on the opposite side of the sky,
       visible mainly at night */
    if (moonMesh) {
      const moonAngle = sunAngle + Math.PI;
      const moonHeight = Math.sin(moonAngle);
      moonMesh.position.set(Math.cos(moonAngle) * sunDist, Math.max(-20, moonHeight * 90 + 20), -40);
      moonMesh.lookAt(0, 10, 0);
      moonMesh.material.opacity = Math.max(0, Math.min(0.85, (1 - dayFactor) * 0.9));
    }
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
    const geo = new THREE.PlaneGeometry(1400, 1400); /* exceeds the new 1267-unit water plane diameter */
    /* Pushed well below the deepest possible swell trough (max
       amplitude is currently capped around 10, so -15 leaves real
       margin) and made much more transparent — this plane is just a
       distant seafloor placeholder, not meant to be a visible surface
       that pokes through at the waterline like it was before. */
    const mat = new THREE.MeshBasicMaterial({ color: 0x123a4d, transparent: true, opacity: 0.25 });
    groundMesh = new THREE.Mesh(geo, mat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.y = -15;
    scene.add(groundMesh);
  }

  /* ---------------------------------------------------------------
     TERRAIN — real land generated from satellite imagery, anchored
     to wherever the player's boat actually is. The boat itself never
     translates in this scene (everything else moves/scrolls around
     it instead, per the existing convention), so the generated
     terrain group is positioned RELATIVE to the boat's current
     position using the same lat/lon-delta-to-world-units approach
     the wake trail and water flow already use, rather than moving
     the boat itself.

     Phase 1 scope: generates and places the mesh only. No collision
     detection or shoreline wave effects yet — those are separate,
     later phases.
     --------------------------------------------------------------- */
  let terrainGroup = null;
  let terrainGeneratedForLatLon = null; /* avoids re-generating on every frame; only regenerates if the boat has moved meaningfully */

  async function updateTerrain(boatLat, boatLon) {
    if (typeof window.OSTerrain === "undefined" || boatLat == null || boatLon == null) return;

    /* Only regenerate if we don't have terrain yet, or the boat has
       moved far enough that the current terrain may no longer cover
       the area around it (roughly a third of the generated tile's
       real-world span, so there's always a comfortable margin left
       before the player could sail off the edge of what's generated). */
    if (terrainGeneratedForLatLon) {
      const distFt = window.OSPhysics
        ? window.OSPhysics.haversineNm(boatLat, boatLon, terrainGeneratedForLatLon.lat, terrainGeneratedForLatLon.lon) * 6076.12
        : 0;
      if (distFt < 1000) return; /* still well within the generated area */
    }

    const newTerrainGroup = await window.OSTerrain.generateTerrainForLocation(boatLat, boatLon, AI_BOAT_WORLD_RADIUS, UNITS_PER_FOOT);
    if (!newTerrainGroup) return;

    if (terrainGroup) {
      scene.remove(terrainGroup);
      terrainGroup.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
    }

    terrainGroup = newTerrainGroup;
    terrainGeneratedForLatLon = { lat: boatLat, lon: boatLon };
    scene.add(terrainGroup);
  }

  /* ---------------------------------------------------------------
     WATER — animated plane using vertex displacement for a simple
     rolling-wave look, not a real ocean simulation.
     --------------------------------------------------------------- */
  const waterUniforms = {
    uTime: { value: 0 },
    uAmplitude: { value: 0.4 },
    uOffsetX: { value: 0 },
    uOffsetZ: { value: 0 },
    uDeepColor: { value: new THREE.Color(0x1565c0) },
    uLightColor: { value: new THREE.Color(0x4fa8e8) },
    uVeinColor: { value: new THREE.Color(0xeaf6ff) },
    uCellScale: { value: 0.05 }
  };

  /* Accumulated sampling offset, in world units — shifted each frame
     opposite the boat's real travel direction at a rate matching its
     actual speed. The water plane itself never moves; instead we
     slide the COORDINATES we sample the swell pattern at, which is
     the standard "scrolling texture" illusion-of-motion trick. This
     is what makes faster boat speed = faster-looking water flow,
     independent of the swells' own (random, not heading-tied) shape. */
  let waterOffsetX = 0;
  let waterOffsetZ = 0;

  function buildWater() {
    const geo = new THREE.PlaneGeometry(1267, 1267, 90, 90); /* stretched to the new 0.5mi (634-unit radius) view distance; same 90x90 subdivision count as before, no added performance cost */

    /* Stylized cracked-cell/voronoi water: irregular polygon "ice
       floe" cells of flat color, separated by bright white veins at
       the cell boundaries — matching the requested reference look.
       Swell displacement is unchanged (still real, already verified
       to dip symmetrically below as well as above zero); per-cell
       FLAT shading is what makes those dips actually read as
       depressions instead of a flat color blend, since each facet
       now visibly tilts with the underlying geometry. */
    const mat = new THREE.ShaderMaterial({
      uniforms: waterUniforms,
      transparent: true,
      side: THREE.DoubleSide,
      vertexShader: `
        uniform float uTime;
        uniform float uAmplitude;
        uniform float uOffsetX;
        uniform float uOffsetZ;
        varying float vHeight;
        varying vec2 vWorldXZ;
        varying float vRippleClock;

        vec2 rot(vec2 p, float a) {
          float c = cos(a), s = sin(a);
          return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
        }

        void main() {
          float slowClock = uTime * 0.35;
          vec2 p = vec2(position.x + uOffsetX, position.y + uOffsetZ);

          /* Seven swell layers total now, at angles spread across the
             full circle (0°, 63°, 124°, then four more well-scattered
             random angles below) so the combination never reads as
             coming from just one or two directions — this is what
             genuinely kills any sense of "rows," rather than relying
             on just a few hand-picked angles. Amplitude weight tapers
             down for the later layers so they add scattered texture
             and chop without overwhelming the main rolling motion
             from the first two. Frequencies are all slightly
             irregular relative to each other (no simple multiples) to
             avoid any obvious repeating pattern. */
          /* Eight swell layers total now: the original seven
             scattered-angle layers, PLUS a real perpendicular swell
             system at exactly 90° from the primary direction (a
             second distinct wave train crossing the main swell at a
             right angle, per request) -- this is intentionally a
             meaningful, real layer rather than just another
             scattered-angle texture pass, since it's specifically
             meant to be felt as waves crossing the existing ones. */
          vec2 primary = rot(p, 0.0);
          vec2 secondary = rot(p, 1.1);
          vec2 tertiary = rot(p, 2.16);
          vec2 layer4 = rot(p, 0.95);
          vec2 layer5 = rot(p, 4.09);
          vec2 layer6 = rot(p, 3.37);
          vec2 layer7 = rot(p, 0.36);
          vec2 perpendicular = rot(p, 1.5708); /* exactly 90 degrees (pi/2) from the primary swell */

          float swell = sin(primary.x * 0.045 + slowClock * 0.9) * uAmplitude
                      + sin(secondary.x * 0.11 + slowClock * 1.3) * uAmplitude * 0.22
                      + sin(tertiary.x * 0.071 + slowClock * 0.61 + 1.7) * uAmplitude * 0.16
                      + sin(layer4.x * 0.093 + slowClock * 1.07 + 0.6) * uAmplitude * 0.12
                      + sin(layer5.x * 0.058 + slowClock * 0.78 + 3.2) * uAmplitude * 0.10
                      + sin(layer6.x * 0.082 + slowClock * 1.21 + 4.8) * uAmplitude * 0.09
                      + sin(layer7.x * 0.066 + slowClock * 0.52 + 2.1) * uAmplitude * 0.08
                      + sin(perpendicular.x * 0.052 + slowClock * 0.75 + 5.5) * uAmplitude * 0.35;

          vHeight = swell / max(uAmplitude * 2.12, 0.0001); /* -1..1, normalized against the combined peak amplitude (now 8 layers) */
          vWorldXZ = p; /* pass the (offset) world position for the cell pattern */
          vRippleClock = uTime; /* drives the vein ripple animation in the fragment shader */

          vec3 displaced = vec3(position.x, position.y, swell);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uDeepColor;
        uniform vec3 uLightColor;
        uniform vec3 uVeinColor;
        uniform float uCellScale;
        varying float vHeight;
        varying vec2 vWorldXZ;
        varying float vRippleClock;

        /* Standard hash-based 2D voronoi: jittered grid cell centers */
        vec2 hash2(vec2 p) {
          p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
          return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
        }
        float hash1(vec2 p) {
          return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453123);
        }

        void main() {
          /* Ripple the sampling coordinate back and forth over time
             before computing the cell pattern -- this is what makes
             the white veins themselves visibly flow/wobble rather
             than sitting static while only the underlying swell
             height changes. Small amplitude relative to cell size so
             it reads as a gentle ripple, not a distortion of the
             cell shapes themselves. */
          vec2 rippleOffset = vec2(
            sin(vWorldXZ.y * 0.08 + vRippleClock * 0.6) * 0.35,
            cos(vWorldXZ.x * 0.08 + vRippleClock * 0.5) * 0.35
          );
          vec2 uv = (vWorldXZ + rippleOffset) * uCellScale;
          vec2 cell = floor(uv);
          vec2 frac = fract(uv);

          float minDist = 8.0;
          float secondMinDist = 8.0;
          vec2 nearestCell = cell;
          for (int y = -2; y <= 2; y++) {
            for (int x = -2; x <= 2; x++) {
              vec2 neighbor = vec2(float(x), float(y));
              vec2 point = hash2(cell + neighbor) * 0.5 + 0.5;
              vec2 diff = neighbor + point - frac;
              float dist = length(diff);
              if (dist < minDist) {
                secondMinDist = minDist;
                minDist = dist;
                nearestCell = cell + neighbor;
              } else if (dist < secondMinDist) {
                secondMinDist = dist;
              }
            }
          }

          /* Mostly uniform mid-blue, like the reference — only a
             gentle per-cell tone variation (each cell gets a slightly
             different fixed shade via its own hash, not tied to wave
             height) plus a faint wave-height tint so swells still
             read a little, without the strong light/dark gradient
             that made the previous version look unlike the reference. */
          float cellShade = hash1(nearestCell);
          vec3 baseColor = mix(uDeepColor, uLightColor, cellShade * 0.35);
          float heightTint = clamp(vHeight * 0.12, -0.12, 0.12);
          vec3 cellColor = baseColor + heightTint;

          /* The real cell boundary is where the distance to the
             nearest seed and the SECOND-nearest seed are close to
             equal (the point is roughly equidistant between two
             cells) — thresholding distance-to-nearest alone (the
             previous version) only ever lit up right at the seed
             points themselves, never at the actual edges, which is
             why no veins were visible at all. This is the standard
             fix for voronoi edge detection. */
          float edgeDist = secondMinDist - minDist;
          /* Softer, wider transition than before (0.0-0.08 was a
             sharp crisp line) so the vein fades in/out gradually
             instead of a hard bright crack */
          float vein = smoothstep(0.0, 0.22, edgeDist);
          /* Vein color itself is dimmed toward the cell's own color
             rather than pure bright white, so even at full vein
             strength it reads as a faded seam, not a glowing line */
          vec3 dimVeinColor = mix(uVeinColor, cellColor, 0.45);
          vec3 color = mix(dimVeinColor, cellColor, vein);

          gl_FragColor = vec4(color, 0.92);
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
    /* Bigger cartoon-style swell amplitude than a realistic ocean */
    waterUniforms.uAmplitude.value = Math.min(10, (waveHeightFt || 1) * 0.583);
    waterUniforms.uTime.value = waveClock;

    /* Motion illusion: slide the swell pattern's sampling position
       opposite the boat's real travel direction, at a rate scaled to
       its actual speed. Since the boat never literally translates in
       this scene, this scrolling-texture trick is what sells "we are
       moving forward" — slower boat speed reads as slower-flowing
       water, faster speed as faster-flowing, independent of the
       swells' own random (not heading-tied) shape. */
    const s = window.OSHelm3DState;
    const speedKt = (s && s.speedKt) || 0;
    if (waterFlowHeadingDeg != null && speedKt > 0.05) {
      /* Verified against the pre-existing, working wake-trail formula
         (recordWakePoint): real travel direction at a given heading
         is (-sin(heading), -cos(heading)) in world (X,Z) -- NOT
         (sin,cos) as an earlier pass through this code incorrectly
         assumed. Accumulating the offset in that direction is what
         makes the swell pattern visually slide toward the stern (the
         standard scrolling-texture motion illusion). */
      const headingRad = (waterFlowHeadingDeg * Math.PI) / 180;
      /* Correctly derived from the new global scale (UNITS_PER_FOOT):
         real feet/hour at this speed, converted to scene units,
         divided by 60 since this runs once per rendered frame at our
         60fps target. WATER_VISUAL_SPEED_MULTIPLIER is then applied
         on top, purely for visual effect (per request: "make the
         water graphics move like twice as fast so it looks like
         you're going faster") -- it does NOT touch speedKt itself or
         any other part of the boat's real physics/movement, only how
         fast the water's surface pattern visually scrolls. */
      const feetPerHour = speedKt * 6076.12;
      const unitsPerSecond = (feetPerHour / 3600) * UNITS_PER_FOOT;
      const moveRate = (unitsPerSecond / 60) * WATER_VISUAL_SPEED_MULTIPLIER;
      waterOffsetX += Math.sin(headingRad) * moveRate;
      waterOffsetZ += Math.cos(headingRad) * moveRate;
    }
    waterUniforms.uOffsetX.value = waterOffsetX;
    waterUniforms.uOffsetZ.value = waterOffsetZ;
  }

  /* JS port of the water shader's swell formula above — lets the
     boat sample its OWN real height at its position and actually
     ride the swells, instead of bobbing on a generic disconnected
     sine wave (which was the "driving through waves" complaint: the
     boat's bob and the water's real shape were unrelated oscillators
     with no connection to each other). Must stay numerically
     identical to the vertex shader above, or the boat will visibly
     float above/below the surface it's supposed to be sitting on. */
  function sampleSwellHeight(worldX, worldZ) {
    const amplitude = waterUniforms.uAmplitude.value;
    const slowClock = waveClock * 0.35;
    const px = worldX + waterUniforms.uOffsetX.value;
    const pz = worldZ + waterUniforms.uOffsetZ.value;

    function rotX(x, z, a) {
      return x * Math.cos(a) - z * Math.sin(a);
    }

    /* Must stay numerically identical to the water shader's vertex
       shader (see buildWater) -- eight layers (seven scattered-angle
       plus one real perpendicular swell at exactly 90 degrees from
       the primary) at the same angles, frequencies, phase offsets,
       and amplitude weights, so the boat's buoyancy/pitch physics
       matches the visual water exactly. */
    const primaryX = rotX(px, pz, 0.0);
    const secondaryX = rotX(px, pz, 1.1);
    const tertiaryX = rotX(px, pz, 2.16);
    const layer4X = rotX(px, pz, 0.95);
    const layer5X = rotX(px, pz, 4.09);
    const layer6X = rotX(px, pz, 3.37);
    const layer7X = rotX(px, pz, 0.36);
    const perpendicularX = rotX(px, pz, 1.5708);

    return Math.sin(primaryX * 0.045 + slowClock * 0.9) * amplitude
         + Math.sin(secondaryX * 0.11 + slowClock * 1.3) * amplitude * 0.22
         + Math.sin(tertiaryX * 0.071 + slowClock * 0.61 + 1.7) * amplitude * 0.16
         + Math.sin(layer4X * 0.093 + slowClock * 1.07 + 0.6) * amplitude * 0.12
         + Math.sin(layer5X * 0.058 + slowClock * 0.78 + 3.2) * amplitude * 0.10
         + Math.sin(layer6X * 0.082 + slowClock * 1.21 + 4.8) * amplitude * 0.09
         + Math.sin(layer7X * 0.066 + slowClock * 0.52 + 2.1) * amplitude * 0.08
         + Math.sin(perpendicularX * 0.052 + slowClock * 0.75 + 5.5) * amplitude * 0.35;
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
    /* Now uses the same global UNITS_PER_FOOT conversion as
       everything else in the scene (water flow speed, AI boat speed)
       instead of the old arbitrary 60-units-per-nm convention, which
       was disconnected from the boat's own actual real-world size. */
    const feetPerHourWake = (speedKt || 0) * 6076.12;
    const moveDist = (feetPerHourWake / 3600) * interval * UNITS_PER_FOOT;
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
  let spinnakerGroup = null;
  let spinnakerMesh = null;
  let windLinesGroup = null;

  /* ---------------------------------------------------------------
     BOAT DESIGN PARAMETERS ("DNA")
     Every dimension/color buildBoat() uses is read from this object
     instead of being hardcoded, so the dev console's boat designer
     can drive the exact same generator with different numbers and
     preview the result live. Defaults below match the boat exactly
     as it existed before this change — nothing looks different for
     existing players unless a custom design is actually supplied.
     --------------------------------------------------------------- */
  function defaultBoatDNA() {
    return {
      scale: 2.4,
      hullType: "cruiser",     /* cruiser | racer | trawler | catamaran */
      hullLength: 6.8,        /* bow point (4.2) to transom (-2.6) */
      hullWidth: 2.1,         /* full beam, port to starboard */
      freeboard: 1.0,         /* topsides height above the waterline (deck height) */
      depth: 2.1,             /* how far the hull extends below the waterline */
      waterline: 0,           /* the boat's resting vertical position relative to the true water surface (y=0) -- replaces the old dev-only buoyancy offset, now a real saved part of the design */
      bowWaterlineZ: 3.57,     /* local Z of the point on the bow that actually touches the water surface -- the hull is made to "ride" this exact point, not just bob as a whole */
      sternWaterlineZ: -2.21,  /* local Z of the equivalent point on the stern */
      cabinType: "trunk",     /* trunk | flush | pilothouse */
      cabinLength: 2.7,
      cabinWidth: 1.7,
      cabinHeight: 0.85,
      cabinOffsetZ: 0.3,      /* cabin center, fore(+)/aft(-) of midship */
      keelType: "fin",        /* fin | full | wing */
      mastHeight: 9,
      biminiType: "bimini",   /* bimini | hardtop | none */
      biminiWidth: 1.5,
      biminiLength: 1.7,
      lifelineType: "single", /* single | double | none */
      helmType: "wheel",      /* wheel | tiller */
      hullColor: 0xe8e4da,
      deckColor: 0xd8d4c8,
      cabinColor: 0xf2efe6,
      sailColor: 0xf5f5f0,
      biminiColor: 0x2c5f73,
      spinnakerColor: 0xe05050,
      modelUrl: null /* if set, loads a real imported .glb/.gltf model instead of building procedurally */
    };
  }

  let currentBoatDNA = defaultBoatDNA();
  let importedModelRoot = null; /* the loaded gltf.scene, when using an imported model instead of procedural geometry */

  /* ---------------------------------------------------------------
     IMPORTED MODEL LOADING
     Loads a real .glb/.gltf model in place of the procedural
     generator. Falls back to a procedural default boat if the load
     fails (network issue, bad URL, CORS/CSP block) rather than
     leaving the player with an empty boat. The loaded model is
     scaled/centered with a best-effort heuristic since imported
     models can come in at wildly different native scales/origins.
     --------------------------------------------------------------- */
  function loadImportedModel(url, targetGroup) {
    if (typeof THREE.GLTFLoader === "undefined") {
      console.error("Oregon Sail: GLTFLoader not available, falling back to procedural boat");
      buildBoat(Object.assign({}, currentBoatDNA, { modelUrl: null }));
      return;
    }

    const loader = new THREE.GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        importedModelRoot = gltf.scene;

        /* Best-effort auto-scale: fit the model's longest dimension
           to roughly match our procedural boat's typical hull length,
           since imported models can arrive at any native scale. */
        const box = new THREE.Box3().setFromObject(importedModelRoot);
        const size = new THREE.Vector3();
        box.getSize(size);
        const longest = Math.max(size.x, size.y, size.z, 0.01);
        const targetLength = 7; /* roughly our procedural hull's length before the outer DNA scale multiplier */
        const autoScale = targetLength / longest;
        importedModelRoot.scale.setScalar(autoScale);

        /* Re-center so the model's base sits near the boatGroup origin
           (our waterline reference), not wherever its own pivot was */
        const center = new THREE.Vector3();
        box.getCenter(center);
        importedModelRoot.position.set(-center.x * autoScale, -box.min.y * autoScale, -center.z * autoScale);

        targetGroup.add(importedModelRoot);
      },
      undefined,
      (error) => {
        console.error("Oregon Sail: failed to load imported model, falling back to procedural boat", error);
        importedModelRoot = null;
        /* Rebuild with modelUrl cleared so we don't loop trying the
           same broken URL — uses the rest of the same DNA otherwise */
        buildBoat(Object.assign({}, currentBoatDNA, { modelUrl: null }));
      }
    );
  }

  /* ---------------------------------------------------------------
     AI / AMBIANCE BOATS
     Random other boats wandering the same 5nm world, purely for
     atmosphere — client-side only, no database presence. Each one
     gets a fully randomized hull/cabin/mast/sail combination (same
     ranges as the dev console's Boat Designer sliders) and a random
     heading/speed, moves in a straight line, and despawns once it
     drifts beyond render distance. Solid (real collision geometry)
     so the player can physically run into one. A new one spawns at a
     random interval to replace whatever's despawned, keeping the
     world feeling populated without a fixed boat count.
     --------------------------------------------------------------- */
  let aiBoats = []; /* { group, velocityX, velocityZ, collider } */
  const AI_BOAT_WORLD_RADIUS = 634; /* matches the new 0.5mi view radius */
  const AI_BOAT_MAX_COUNT = 5;
  let aiBoatSpawnClock = 0;
  let aiBoatSpawnInterval = 15 + Math.random() * 20; /* next spawn in 15-35s, re-rolled after each spawn */

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }
  function randomColor() {
    return Math.floor(Math.random() * 0xffffff);
  }

  function randomBoatDNA() {
    const hullTypes = ["cruiser", "racer", "trawler"]; /* catamaran excluded -- the simplified AI builder below assumes a single hull */
    const cabinTypes = ["trunk", "flush", "pilothouse"];
    return {
      scale: randomBetween(1.8, 3.0),
      hullType: hullTypes[Math.floor(Math.random() * hullTypes.length)],
      hullLength: randomBetween(4, 12),
      hullWidth: randomBetween(1.2, 4),
      freeboard: randomBetween(0.4, 3),
      depth: randomBetween(0.4, 3),
      mastHeight: randomBetween(4, 16),
      cabinType: cabinTypes[Math.floor(Math.random() * cabinTypes.length)],
      cabinLength: randomBetween(1, 5),
      cabinWidth: randomBetween(0.8, 3),
      cabinHeight: randomBetween(0.4, 1.6),
      cabinOffsetZ: randomBetween(-1.5, 1.5),
      hullColor: randomColor(),
      deckColor: randomColor(),
      cabinColor: randomColor(),
      sailColor: randomColor()
    };
  }

  /* Simplified visual build for ambiance boats — hull, mast, boom,
     one mainsail triangle, one cabin box. Deliberately skips the
     player boat's full detail (lifelines, bimini, helm wheel,
     portholes, rigging, spinnaker) since these are distant/passing
     boats, not the player's own — this keeps the per-boat cost much
     lower than the full player-boat pipeline, important since
     several of these can exist at once. */
  function buildAIBoatMesh(d) {
    const group = new THREE.Group();
    group.scale.set(d.scale, d.scale, d.scale);

    const profiles = {
      cruiser: { widthMult: 1.0, sharpness: 0.3 },
      racer:   { widthMult: 0.88, sharpness: 0.85 },
      trawler: { widthMult: 1.15, sharpness: -0.2 }
    };
    const profile = profiles[d.hullType] || profiles.cruiser;
    const bowZ = d.hullLength * 0.618;
    const sternZ = -(d.hullLength - bowZ);
    const halfWidth = (d.hullWidth * profile.widthMult) / 2;

    const hullShape = buildSingleHullShape(bowZ, sternZ, halfWidth, profile.sharpness);
    const hullExtrude = new THREE.ExtrudeGeometry(hullShape, { depth: d.depth, bevelEnabled: false });
    hullExtrude.rotateX(Math.PI / 2);
    const hull = new THREE.Mesh(hullExtrude, new THREE.MeshPhongMaterial({ color: d.hullColor, flatShading: true }));
    hull.position.y = d.freeboard;
    group.add(hull);
    const deckY = d.freeboard;

    /* Simple cabin box */
    const cabinW = d.cabinWidth, cabinL = d.cabinLength, cabinH = d.cabinHeight;
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(cabinW, cabinH, cabinL),
      new THREE.MeshPhongMaterial({ color: d.cabinColor, flatShading: true })
    );
    cabin.position.set(0, deckY + cabinH / 2, d.cabinOffsetZ);
    group.add(cabin);

    /* Mast + boom + one mainsail triangle */
    const mastX = 0, mastZ = 0.6;
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, d.mastHeight, 6),
      new THREE.MeshPhongMaterial({ color: 0x5a4632 })
    );
    mast.position.set(mastX, deckY + d.mastHeight / 2, mastZ);
    group.add(mast);

    const boomLen = Math.max(1.5, d.hullLength * 0.4);
    const boomGroup = new THREE.Group();
    boomGroup.position.set(mastX, deckY + 1.6, mastZ);
    group.add(boomGroup);
    const boom = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, boomLen, 5),
      new THREE.MeshPhongMaterial({ color: 0xcfd8df })
    );
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 0, -boomLen / 2);
    boomGroup.add(boom);

    const sailHeight = Math.max(1.5, d.mastHeight - 2);
    const sailGeo = new THREE.BufferGeometry();
    sailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      0, 0, 0,
      0, sailHeight, 0,
      0, 0, -boomLen
    ]), 3));
    sailGeo.setIndex([0, 1, 2]);
    sailGeo.computeVertexNormals();
    const sail = new THREE.Mesh(sailGeo, new THREE.MeshPhongMaterial({
      color: d.sailColor, side: THREE.DoubleSide, transparent: true, opacity: 0.92, flatShading: true
    }));
    boomGroup.add(sail);

    /* Collision footprint used for player-collision checks — a
       simple box matching the hull's real length/width/freeboard
       rather than a precise hull-shaped volume, which is plenty for
       "can I crash into this boat" purposes */
    group.userData.colliderHalfLength = (bowZ - sternZ) / 2 * d.scale;
    group.userData.colliderHalfWidth = halfWidth * d.scale;

    return group;
  }

  /* Builds one random boat using the exact same generator as the
     open-water AI ambiance boats, but without any velocity/spawn-at-
     edge logic — used to fill marina slips with stationary, parked
     boats. Not added to the aiBoats movement-tracking array, so it
     never moves or despawns on its own; the marina module owns its
     lifecycle entirely. */
  function buildStationaryAIBoat() {
    const dna = randomBoatDNA();
    return buildAIBoatMesh(dna);
  }

  function spawnAIBoat() {
    if (aiBoats.length >= AI_BOAT_MAX_COUNT) return;
    const dna = randomBoatDNA();
    const group = buildAIBoatMesh(dna);

    /* Spawn at a random point on the edge of the visible world,
       heading on a random course that isn't guaranteed to immediately
       exit again (mostly aimed back toward the general vicinity of
       the center, with enough randomness to still feel organic) */
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnDist = AI_BOAT_WORLD_RADIUS * 0.95;
    const spawnX = Math.cos(spawnAngle) * spawnDist;
    const spawnZ = Math.sin(spawnAngle) * spawnDist;
    group.position.set(spawnX, 0.3, spawnZ);

    const headingDeg = Math.random() * 360;
    const headingRad = (headingDeg * Math.PI) / 180;
    group.rotation.y = ((headingDeg + 180) * Math.PI) / 180; /* matches the confirmed player-boat heading convention */

    const speedKt = randomBetween(2, 8);
    /* Correctly derived from the new global scale (UNITS_PER_FOOT),
       consistent with the water flow speed fix above -- replaces the
       old 60-units-per-nm convention, which was a separate, earlier
       calibration disconnected from the boat's own real size. */
    const feetPerHourAI = speedKt * 6076.12;
    const unitsPerSecond = (feetPerHourAI / 3600) * UNITS_PER_FOOT;
    const velocityX = -Math.sin(headingRad) * unitsPerSecond;
    const velocityZ = -Math.cos(headingRad) * unitsPerSecond;

    scene.add(group);
    aiBoats.push({ group, velocityX, velocityZ });
  }

  function updateAIBoats(elapsedFactor) {
    if (!scene) return;
    aiBoatSpawnClock += elapsedFactor;
    if (aiBoatSpawnClock > aiBoatSpawnInterval) {
      aiBoatSpawnClock = 0;
      aiBoatSpawnInterval = 15 + Math.random() * 20;
      spawnAIBoat();
    }

    for (let i = aiBoats.length - 1; i >= 0; i--) {
      const ai = aiBoats[i];
      ai.group.position.x += ai.velocityX * elapsedFactor; /* velocity is already in correct world-units-per-second */
      ai.group.position.z += ai.velocityZ * elapsedFactor;

      const dist = Math.sqrt(ai.group.position.x ** 2 + ai.group.position.z ** 2);
      if (dist > AI_BOAT_WORLD_RADIUS * 1.05) {
        /* Out of render distance — despawn and free its geometry */
        scene.remove(ai.group);
        ai.group.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) obj.material.dispose();
        });
        aiBoats.splice(i, 1);
      }
    }
  }

  /* Checks the player's boat against every AI boat's collision
     footprint, in world space (both the player and AI boats have
     real world positions/rotations now). Returns the first AI boat
     mesh group found to be overlapping, or null. Called from the
     main tick loop; actual collision RESPONSE (stopping, bouncing,
     damage, etc) is intentionally left for a follow-up — this just
     detects it, since "make them solid so you can crash into them"
     is the scoped request for this pass. */
  function checkAIBoatCollision(playerWorldX, playerWorldZ, playerHalfLength, playerHalfWidth, playerHeadingRad) {
    for (const ai of aiBoats) {
      const dx = playerWorldX - ai.group.position.x;
      const dz = playerWorldZ - ai.group.position.z;
      /* Rough circle-circle check first (cheap), using each boat's
         largest half-dimension as an approximate radius — good
         enough for "are these two boats close enough to matter"
         before bothering with anything more precise */
      const aiRadius = Math.max(ai.group.userData.colliderHalfLength || 3, ai.group.userData.colliderHalfWidth || 1);
      const playerRadius = Math.max(playerHalfLength || 3, playerHalfWidth || 1);
      const distSq = dx * dx + dz * dz;
      const combinedRadius = aiRadius + playerRadius;
      if (distSq < combinedRadius * combinedRadius) {
        return ai.group;
      }
    }
    return null;
  }

  function buildBoat(dna) {
    const d = dna || currentBoatDNA || defaultBoatDNA();
    /* Backfill type fields for any DNA saved before this update, so
       existing saved boats/presets default to the original look
       instead of erroring on a missing type */
    const defaults = defaultBoatDNA();
    Object.keys(defaults).forEach(k => { if (d[k] === undefined) d[k] = defaults[k]; });
    currentBoatDNA = d;

    boatGroup = new THREE.Group();
    boatGroup.scale.set(d.scale, d.scale, d.scale);
    scene.add(boatGroup);

    /* ---------------------------------------------------------------
       IMPORTED MODEL — if this boat's design specifies a real .glb
       model URL instead of procedural dimensions, load that instead
       of running the generator below. The whole imported model still
       gets heel/pitch/roll/turn-lean animation in the main tick loop
       (since that's applied to boatGroup as a whole, regardless of
       what's inside it) — what it does NOT get is per-part sail/boom
       animation, since those target specific named objects the
       procedural builder creates that an arbitrary imported model
       won't have. That's a deliberate, documented v1 boundary.
       --------------------------------------------------------------- */
    if (d.modelUrl) {
      /* Clear references to the previous procedural build's parts —
         without this they'd point to now-orphaned (detached, not
         rendered) objects from the last boatGroup, and the per-frame
         update functions (updateBoom, updateHeadsailReef, etc) would
         silently touch dead objects instead of correctly no-op'ing. */
      hullMesh = mastMesh = boomGroup = sailMesh = headsailMesh = headsailGroup = null;
      spinnakerGroup = spinnakerMesh = wakeMesh = bowWaveMesh = null;
      loadImportedModel(d.modelUrl, boatGroup);
      return; /* skip the procedural generator entirely */
    }

    /* ---------------------------------------------------------------
       HULL — dispatches to a per-type builder. Each builder returns
       { bowZ, sternZ, halfWidth, deckY, hullCount } so the rest of
       the boat (cabin, mast, lifelines, etc) can be positioned
       consistently regardless of which hull type was chosen.
       hullCount is 2 for catamarans (everything above deck still
       builds once, centered between the two hulls).
       --------------------------------------------------------------- */
    const hullInfo = buildHull(d);
    const { bowZ, sternZ, halfWidth, deckY } = hullInfo;

    buildKeel(d, hullInfo);

    /* ---------------------------------------------------------------
       CABIN TOP — dispatches to a per-type builder (trunk/flush/pilothouse)
       --------------------------------------------------------------- */
    const cabinInfo = buildCabin(d, hullInfo);
    const cabinWallHeight = cabinInfo.wallHeight;

    /* ---------------------------------------------------------------
       COCKPIT + BIMINI + HELM
       --------------------------------------------------------------- */
    const cockpitFloorGeo = new THREE.BoxGeometry(1.4, 0.15, 1.8);
    const cockpitFloorMesh = new THREE.Mesh(cockpitFloorGeo, new THREE.MeshPhongMaterial({ color: d.deckColor }));
    cockpitFloorMesh.position.set(0, deckY + 0.1, -1.1);
    boatGroup.add(cockpitFloorMesh);

    buildBimini(d, hullInfo);
    buildHelm(d, hullInfo);
    buildLifelines(d, hullInfo);

    /* ---------------------------------------------------------------
       MAST, BOOM, SAILS
       --------------------------------------------------------------- */
    const mastX = 0, mastZ = 0.6;
    const mastBaseY = deckY;
    const mastGeo = new THREE.CylinderGeometry(0.08, 0.08, d.mastHeight, 8);
    mastMesh = new THREE.Mesh(mastGeo, new THREE.MeshPhongMaterial({ color: 0x5a4632 }));
    mastMesh.position.set(mastX, mastBaseY + d.mastHeight / 2, mastZ);
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
    addStay(mastX, bowZ * 0.976, mastBaseY + d.mastHeight);            /* forestay to the bow */
    addStay(-1.0, 0.6, mastBaseY + d.mastHeight * 0.9);                /* port shroud */
    addStay(1.0, 0.6, mastBaseY + d.mastHeight * 0.9);                 /* starboard shroud */

    /* Boom group — pivots exactly at the mast's base/centerline so it
       reads as properly attached, not floating beside the mast */
    boomGroup = new THREE.Group();
    boomGroup.position.set(mastX, mastBaseY + 1.8, mastZ);
    boatGroup.add(boomGroup);

    const boomLen = 3.2;
    const boomGeo = new THREE.CylinderGeometry(0.05, 0.05, boomLen, 6);
    const boomMesh = new THREE.Mesh(boomGeo, new THREE.MeshPhongMaterial({ color: 0xcfd8df }));
    /* A cylinder's default long axis is Y. Rotating on X lays it down
       along Z (fore-aft, running with the keel) */
    boomMesh.rotation.x = Math.PI / 2;
    boomMesh.position.set(0, 0, -boomLen / 2); /* extends aft from the mast pivot */
    boomGroup.add(boomMesh);

    /* Mainsail — triangle from mast (at boom pivot height up to mast
       top) back to the boom tip, attached at the mast the whole time.
       Height scales with mast height so taller masts get taller sails.
       Built as a subdivided grid (not a flat 3-vertex triangle) so
       the leech (free trailing edge) has real geometry to animate —
       this is what lets the sail genuinely LUFF (flutter) when
       poorly trimmed versus pull smooth and full when well-trimmed,
       instead of just a single static camber bend. */
    const mainsailHeight = Math.max(2, d.mastHeight - 2);
    const sailRows = 6, sailCols = 5;
    const mainsailGeo = new THREE.BufferGeometry();
    const mainsailPositions = [];
    const mainsailUVs = []; /* u = luff(0)->leech(1), v = foot(0)->head(1), used by the luff shader */
    for (let row = 0; row <= sailRows; row++) {
      const v = row / sailRows; /* 0 at boom/foot, 1 at masthead/head */
      for (let col = 0; col <= sailCols; col++) {
        const u = col / sailCols; /* 0 at the mast/luff, 1 at the leech (free edge) */
        /* Sail tapers from full boom-length at the foot to a point at
           the head, matching the original triangle's silhouette */
        const widthAtThisHeight = (1 - v) * boomLen;
        const x = 0;
        const y = v * mainsailHeight;
        const z = -u * widthAtThisHeight;
        mainsailPositions.push(x, y, z);
        mainsailUVs.push(u, v);
      }
    }
    const mainsailIndices = [];
    for (let row = 0; row < sailRows; row++) {
      for (let col = 0; col < sailCols; col++) {
        const a = row * (sailCols + 1) + col;
        const b = a + 1;
        const c = a + (sailCols + 1);
        const dd = c + 1;
        mainsailIndices.push(a, c, b, b, c, dd);
      }
    }
    mainsailGeo.setAttribute("position", new THREE.Float32BufferAttribute(mainsailPositions, 3));
    mainsailGeo.setAttribute("uv", new THREE.Float32BufferAttribute(mainsailUVs, 2));
    mainsailGeo.setIndex(mainsailIndices);
    mainsailGeo.computeVertexNormals();
    sailMesh = new THREE.Mesh(mainsailGeo, new THREE.MeshPhongMaterial({
      color: d.sailColor, side: THREE.DoubleSide, transparent: true, opacity: 0.92, flatShading: false
    }));
    sailMesh.userData.basePositions = mainsailPositions.slice(); /* untouched rest shape, used each frame to compute displacement from */
    boomGroup.add(sailMesh); /* parented to boomGroup so it swings with the boom but stays mast-attached */

    /* Headsail (jib) — a roller-furling jib whose luff runs along the
       REAL forestay line (bow tack at deck level up to the masthead),
       matching the actual rigging instead of floating at an
       unrelated position above the cabin. headsailGroup's origin
       sits at the tack (the forestay's bow attachment point), with
       the group itself oriented along the forestay's exact direction
       so furling (a rotation around the local Y/luff axis below) wraps
       the sail up around that real line, like a real roller furler. */
    const forestayTackX = mastX, forestayTackZ = bowZ * 0.976, forestayTackY = deckY;
    const forestayHeadX = mastX, forestayHeadZ = mastZ, forestayHeadY = mastBaseY + d.mastHeight;
    const forestayDX = forestayHeadX - forestayTackX;
    const forestayDY = forestayHeadY - forestayTackY;
    const forestayDZ = forestayHeadZ - forestayTackZ;
    const forestayLen = Math.sqrt(forestayDX * forestayDX + forestayDY * forestayDY + forestayDZ * forestayDZ);

    headsailGroup = new THREE.Group();
    headsailGroup.position.set(forestayTackX, forestayTackY, forestayTackZ);
    /* Orient the group so its local +Y axis points exactly along the
       real forestay (tack to masthead) — built directly from the
       forestay's own direction vector via setFromUnitVectors, rather
       than a lookAt+rotate combo (which is easy to get backwards
       about which axis ends up pointing where). This makes the luff
       (built along local Y below) sit exactly on the real rigging
       line, and gives furling a real, unambiguous luff axis to wrap
       around. */
    const forestayDir = new THREE.Vector3(forestayDX, forestayDY, forestayDZ).normalize();
    headsailGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), forestayDir);
    boatGroup.add(headsailGroup);

    const headsailHeight = forestayLen; /* head now reaches all the way to the masthead, per request */
    const headsailFoot = -3.3; /* negative = clew swings aft instead of forward, per request */
    const headsailGeo = new THREE.BufferGeometry();
    const headsailVerts = new Float32Array([
      0, 0, 0,                 /* tack, at the headsailGroup origin (forestay/bow attachment) */
      0, headsailHeight, 0,    /* head, up along the luff toward the masthead */
      0, 0, headsailFoot       /* clew, out from the foot (local Z, perpendicular-ish to the luff) */
    ]);
    headsailGeo.setAttribute("position", new THREE.BufferAttribute(headsailVerts, 3));
    headsailGeo.setIndex([0, 1, 2]);
    headsailGeo.computeVertexNormals();
    headsailMesh = new THREE.Mesh(headsailGeo, new THREE.MeshPhongMaterial({
      color: d.sailColor, side: THREE.DoubleSide, transparent: true, opacity: 0.9, flatShading: true
    }));
    headsailGroup.add(headsailMesh);

    /* Spinnaker — a wide, billowed downwind sail flown forward of the
       bow, attached near the masthead (its halyard point) and pulled
       out to a point well ahead of the bow (where the pole/guy would
       hold it). Built as a small fan of triangles with the mid-width
       vertices pushed outward in Y/X to fake the characteristic
       balloon shape, rather than a single flat triangle like the
       main/jib — a spinnaker reads as flat-and-triangular if built
       the same way, which doesn't look right for this sail.
       Flipped 180° on Z (now negative-forward) and scaled up
       significantly per request — it was popping out the wrong
       direction and reading too small at the previous size. */
    spinnakerGroup = new THREE.Group();
    spinnakerGroup.position.set(mastX, mastBaseY + d.mastHeight * 0.85, mastZ);
    boatGroup.add(spinnakerGroup);

    const spinHeight = d.mastHeight * 1.1;
    const spinForward = 9; /* positive = pops out toward the bow (+Z), matching the hull's actual bow direction */
    const spinBillowOut = 3.0;      /* sideways bulge at mid-height, the "balloon" — much bigger */
    const spinBillowFwd = 1.6; /* forward bulge, matches the corrected spinForward sign */

    const spinnakerGeo = new THREE.BufferGeometry();
    const spinnakerVerts = new Float32Array([
      0, 0, 0,                                   /* head, at spinnakerGroup origin (near masthead) */
      spinBillowOut, -spinHeight * 0.45, spinForward * 0.55 + spinBillowFwd,  /* starboard belly */
      0, -spinHeight, spinForward,                /* clew/foot point, out ahead of the bow */
      -spinBillowOut, -spinHeight * 0.45, spinForward * 0.55 + spinBillowFwd  /* port belly */
    ]);
    spinnakerGeo.setAttribute("position", new THREE.BufferAttribute(spinnakerVerts, 3));
    spinnakerGeo.setIndex([0, 1, 2, 0, 2, 3]); /* two triangles sharing the head-to-foot edge */
    spinnakerGeo.computeVertexNormals();
    spinnakerMesh = new THREE.Mesh(spinnakerGeo, new THREE.MeshPhongMaterial({
      color: d.spinnakerColor || 0xe05050, side: THREE.DoubleSide, transparent: true, opacity: 0.92, flatShading: true
    }));
    spinnakerGroup.add(spinnakerMesh);
    spinnakerMesh.visible = false; /* only shown when actually deployed downwind */

    buildLights(d, hullInfo, mastX, mastZ, mastBaseY, cabinWallHeight);
  }

  /* ---------------------------------------------------------------
     NAVIGATION / DECK LIGHTS
     Five switchable lights, each a small THREE.PointLight or
     THREE.SpotLight plus a glowing bulb mesh so it reads visually
     even before the light itself illuminates anything nearby:
       - Anchor: white, very top of the mast, omnidirectional
       - Nav lights: red (port/left) + green (starboard/right) at the
         bow, white at the stern — the real maritime convention
       - Steaming: white, facing forward, halfway up the mast
       - Deck: white, mounted high, aimed straight down at the deck
       - Cockpit: white, low-mounted under the bimini, lighting the
         cockpit well
     All start OFF; game-ui.js calls setLightState() based on the
     boat's light_* columns whenever they change.
     --------------------------------------------------------------- */
  const lightObjects = {}; /* { anchor, nav, steaming, deck, cockpit } -> { lights: [...], bulbs: [...] } */

  function makeBulb(color, radius) {
    const geo = new THREE.SphereGeometry(radius || 0.05, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    return new THREE.Mesh(geo, mat);
  }

  function buildLights(d, hullInfo, mastX, mastZ, mastBaseY, cabinWallHeight) {
    const { bowZ, sternZ, halfWidth, deckY } = hullInfo;
    Object.keys(lightObjects).forEach(k => delete lightObjects[k]);

    /* --- ANCHOR LIGHT: white, very top of the mast, all-around --- */
    {
      const bulb = makeBulb(0xffffff, 0.07);
      bulb.position.set(mastX, mastBaseY + d.mastHeight + 0.1, mastZ);
      boatGroup.add(bulb);
      const light = new THREE.PointLight(0xffffff, 0, 12); /* intensity 0 = off by default */
      light.position.copy(bulb.position);
      boatGroup.add(light);
      lightObjects.anchor = { lights: [light], bulbs: [bulb] };
    }

    /* --- NAV LIGHTS: red port / green starboard at the bow, white stern --- */
    {
      const bowLightZ = bowZ * 0.85;
      /* Colors inverted per direct in-game confirmation -- the
         earlier convention-based reasoning didn't match reality.
         portBulb (at -halfWidth) is now GREEN, stbdBulb (at
         +halfWidth) is now RED. */
      const portBulb = makeBulb(0x2aff5a, 0.05);
      portBulb.position.set(-halfWidth * 0.9, deckY + 0.3, bowLightZ);
      boatGroup.add(portBulb);
      const portLight = new THREE.PointLight(0x2aff5a, 0, 6);
      portLight.position.copy(portBulb.position);
      boatGroup.add(portLight);

      const stbdBulb = makeBulb(0xff2a2a, 0.05);
      stbdBulb.position.set(halfWidth * 0.9, deckY + 0.3, bowLightZ);
      boatGroup.add(stbdBulb);
      const stbdLight = new THREE.PointLight(0xff2a2a, 0, 6);
      stbdLight.position.copy(stbdBulb.position);
      boatGroup.add(stbdLight);

      const sternBulb = makeBulb(0xffffff, 0.05);
      sternBulb.position.set(0, deckY + 0.4, sternZ + 0.1);
      boatGroup.add(sternBulb);
      const sternLight = new THREE.PointLight(0xffffff, 0, 6);
      sternLight.position.copy(sternBulb.position);
      boatGroup.add(sternLight);

      lightObjects.nav = {
        lights: [portLight, stbdLight, sternLight],
        bulbs: [portBulb, stbdBulb, sternBulb]
      };
    }

    /* --- STEAMING LIGHT: white, forward-facing, halfway up the mast --- */
    {
      const steamingY = mastBaseY + d.mastHeight * 0.5;
      const bulb = makeBulb(0xffffff, 0.05);
      bulb.position.set(mastX, steamingY, mastZ + 0.08);
      boatGroup.add(bulb);
      const light = new THREE.SpotLight(0xffffff, 0, 14, Math.PI / 4, 0.5);
      light.position.set(mastX, steamingY, mastZ);
      light.target.position.set(mastX, steamingY - 0.5, bowZ);
      boatGroup.add(light);
      boatGroup.add(light.target);
      lightObjects.steaming = { lights: [light], bulbs: [bulb] };
    }

    /* --- DECK LIGHT: white, mounted high, aimed straight down --- */
    {
      const deckLightY = mastBaseY + d.mastHeight * 0.35;
      const bulb = makeBulb(0xfff6d8, 0.04);
      bulb.position.set(mastX, deckLightY, mastZ);
      boatGroup.add(bulb);
      const light = new THREE.SpotLight(0xfff6d8, 0, 10, Math.PI / 3, 0.6);
      light.position.set(mastX, deckLightY, mastZ);
      light.target.position.set(mastX, deckY, mastZ);
      boatGroup.add(light);
      boatGroup.add(light.target);
      lightObjects.deck = { lights: [light], bulbs: [bulb] };
    }

    /* --- COCKPIT LIGHTS: low-mounted, lighting the cockpit well --- */
    {
      const cockpitZ = -1.1; /* matches cockpitFloorMesh's position */
      const positions = [
        { x: -0.6, z: cockpitZ + 0.6 },
        { x: 0.6, z: cockpitZ + 0.6 },
        { x: -0.6, z: cockpitZ - 0.6 },
        { x: 0.6, z: cockpitZ - 0.6 }
      ];
      const lights = [];
      const bulbs = [];
      positions.forEach((p) => {
        const bulb = makeBulb(0xfff0c8, 0.035);
        bulb.position.set(p.x, deckY + 1.0, p.z);
        boatGroup.add(bulb);
        const light = new THREE.PointLight(0xfff0c8, 0, 4);
        light.position.copy(bulb.position);
        boatGroup.add(light);
        lights.push(light);
        bulbs.push(bulb);
      });
      lightObjects.cockpit = { lights, bulbs };
    }

    /* Apply whatever switch states are already known (e.g. surviving
       a rebuildBoat() while lights were on) instead of always
       resetting to off */
    Object.keys(currentLightState).forEach(key => setLightState(key, currentLightState[key]));
  }

  /* Tracks the last-known switch state for each light so rebuildBoat()
     (boat designer preview, etc) can restore them instead of always
     starting dark. Updated by setLightState, read by buildLights. */
  const currentLightState = { anchor: false, nav: false, steaming: false, deck: false, cockpit: false };

  function setLightState(key, isOn) {
    currentLightState[key] = !!isOn;
    const obj = lightObjects[key];
    if (!obj) return;
    obj.lights.forEach(light => {
      light.intensity = isOn ? (light.isSpotLight ? 1.4 : 1.1) : 0;
    });
    obj.bulbs.forEach(bulb => {
      bulb.material.opacity = isOn ? 0.95 : 0.35;
    });
  }


  /* ---------------------------------------------------------------
     HULL TYPES
     Each builder constructs the hull mesh(es) and returns the shared
     measurements (bowZ/sternZ/halfWidth/deckY) the rest of the boat
     uses to position cabin/mast/lifelines consistently.
     --------------------------------------------------------------- */
  function buildSingleHullShape(bowZ, sternZ, halfWidth, bowSharpness) {
    /* bowSharpness: 0=full/round entry (trawler), 1=sharp/fine entry (racer) */
    const shape = new THREE.Shape();
    const bowCtrlX = halfWidth * (0.857 - bowSharpness * 0.25);
    const bowCtrlY = bowZ * (0.619 + bowSharpness * 0.1);
    shape.moveTo(0, bowZ);
    shape.quadraticCurveTo(bowCtrlX, bowCtrlY, halfWidth, bowZ * 0.119);
    shape.lineTo(halfWidth, sternZ);
    shape.lineTo(-halfWidth, sternZ);
    shape.lineTo(-halfWidth, bowZ * 0.119);
    shape.quadraticCurveTo(-bowCtrlX, bowCtrlY, 0, bowZ);
    return shape;
  }

  function buildHull(d) {
    const type = d.hullType || "cruiser";

    if (type === "catamaran") {
      /* Twin slender hulls (each ~40% the beam of a single-hull boat
         of the same length) spaced apart, joined conceptually by the
         deck/cockpit that builds on top at the centerline as usual. */
      const bowZ = d.hullLength * 0.618;
      const sternZ = -(d.hullLength - bowZ);
      const hullHalfWidth = (d.hullWidth * 0.4) / 2;
      const spacing = d.hullWidth * 0.85; /* gap between the two hull centerlines */

      const hullMat = new THREE.MeshPhongMaterial({ color: d.hullColor, flatShading: true });
      [-1, 1].forEach((side) => {
        const shape = buildSingleHullShape(bowZ, sternZ, hullHalfWidth, 0.7);
        const extrude = new THREE.ExtrudeGeometry(shape, { depth: d.depth, bevelEnabled: false });
        extrude.rotateX(Math.PI / 2);
        const mesh = new THREE.Mesh(extrude, hullMat);
        mesh.position.set(side * spacing / 2, d.freeboard, 0);
        boatGroup.add(mesh);
        if (side === -1) hullMesh = mesh; /* keep a reference for anything that expects one */
      });

      /* A simple connecting deck/bridge between the hulls, visually
         tying the catamaran together under the cockpit/cabin */
      const bridgeGeo = new THREE.BoxGeometry(spacing - hullHalfWidth, 0.12, d.hullLength * 0.6);
      const bridgeMesh = new THREE.Mesh(bridgeGeo, new THREE.MeshPhongMaterial({ color: d.deckColor }));
      bridgeMesh.position.set(0, d.freeboard - d.depth + 0.3, 0);
      boatGroup.add(bridgeMesh);

      return { bowZ, sternZ, halfWidth: spacing / 2 + hullHalfWidth, deckY: d.freeboard, hullCount: 2 };
    }

    /* Single-hull types: cruiser (balanced), racer (finer entry, narrower),
       trawler (fuller entry, wider) — same construction, different
       proportions/sharpness passed into the shape builder. */
    const profiles = {
      cruiser: { widthMult: 1.0, sharpness: 0.3 },
      racer:   { widthMult: 0.88, sharpness: 0.85 },
      trawler: { widthMult: 1.15, sharpness: -0.2 }
    };
    const profile = profiles[type] || profiles.cruiser;

    const bowZ = d.hullLength * 0.618;
    const sternZ = -(d.hullLength - bowZ);
    const halfWidth = (d.hullWidth * profile.widthMult) / 2;

    const hullShape = buildSingleHullShape(bowZ, sternZ, halfWidth, profile.sharpness);
    const hullExtrude = new THREE.ExtrudeGeometry(hullShape, { depth: d.depth, bevelEnabled: false });
    hullExtrude.rotateX(Math.PI / 2);
    const hullMat = new THREE.MeshPhongMaterial({ color: d.hullColor, flatShading: true });
    hullMesh = new THREE.Mesh(hullExtrude, hullMat);
    /* Deck sits at y = freeboard (raising this is what actually adds
       visible topsides above the waterline now, instead of the old
       fixed-at-1.0 deck height); the hull extends DOWN from there by
       `depth` units, controlling how far it reaches below the
       waterline independently of freeboard. */
    hullMesh.position.y = d.freeboard;
    boatGroup.add(hullMesh);

    /* ExtrudeGeometry extrudes along local +Z from 0 to depth; our
       rotateX(90°) on the geometry maps local +Z to world -Y, so the
       hull's deck (top edge, local z=0) ends up at hullMesh.position.y
       itself, and the keel/bottom (local z=depth) ends up BELOW that. */
    return { bowZ, sternZ, halfWidth, deckY: d.freeboard, hullCount: 1 };
  }

  /* ---------------------------------------------------------------
     KEEL TYPES
     --------------------------------------------------------------- */
  function buildKeel(d, hullInfo) {
    const { deckY } = hullInfo;
    const type = d.keelType || "fin";
    const keelMat = new THREE.MeshPhongMaterial({ color: 0x2a2a2a });

    if (hullInfo.hullCount === 2) {
      /* Catamarans typically run shallow mini-keels/skegs under each
         hull rather than one central fin */
      const spacing = (hullInfo.halfWidth) * 1.1;
      [-1, 1].forEach((side) => {
        const geo = new THREE.BoxGeometry(0.18, d.depth * 0.35, 1.4);
        const mesh = new THREE.Mesh(geo, keelMat);
        mesh.position.set(side * spacing * 0.5, deckY - d.depth - geo.parameters.height * 0.5 + 0.1, 0);
        boatGroup.add(mesh);
      });
      return;
    }

    if (type === "full") {
      /* Full keel: longer and shallower, running most of the hull's
         length — classic heavy-cruiser look */
      const geo = new THREE.BoxGeometry(0.28, d.depth * 0.5, hullInfo.bowZ - hullInfo.sternZ - 1.0);
      const mesh = new THREE.Mesh(geo, keelMat);
      mesh.position.set(0, deckY - d.depth - geo.parameters.height * 0.5 + 0.15, (hullInfo.bowZ + hullInfo.sternZ) / 2 * 0.3);
      boatGroup.add(mesh);
      return;
    }

    if (type === "wing") {
      /* Fin keel plus small winglets at the bottom */
      const finGeo = new THREE.BoxGeometry(0.3, d.depth * 0.8, 2);
      const finMesh = new THREE.Mesh(finGeo, keelMat);
      const finY = deckY - d.depth - finGeo.parameters.height * 0.5 + 0.1;
      finMesh.position.y = finY;
      boatGroup.add(finMesh);

      const wingGeo = new THREE.BoxGeometry(1.1, 0.12, 0.7);
      const wingMesh = new THREE.Mesh(wingGeo, keelMat);
      wingMesh.position.set(0, finY - finGeo.parameters.height / 2, 0);
      boatGroup.add(wingMesh);
      return;
    }

    /* Default: fin keel — a single rectangular blade */
    const keelGeo = new THREE.BoxGeometry(0.3, d.depth * 0.8, 2);
    const keelMesh = new THREE.Mesh(keelGeo, keelMat);
    keelMesh.position.y = deckY - d.depth - keelGeo.parameters.height * 0.5 + 0.1;
    boatGroup.add(keelMesh);
  }

  /* ---------------------------------------------------------------
     CABIN TYPES
     --------------------------------------------------------------- */
  function buildCabin(d, hullInfo) {
    const { deckY } = hullInfo;
    const type = d.cabinType || "trunk";
    const cabinMat = new THREE.MeshPhongMaterial({ color: d.cabinColor, flatShading: true });
    const cabinCenterZ = d.cabinOffsetZ;
    const cabinLength = d.cabinLength;
    const cabinWidth = d.cabinWidth;

    if (type === "flush") {
      /* Flush deck — no raised cabin structure at all, just a couple
         of small low hatches for visual interest */
      const hatchMat = new THREE.MeshPhongMaterial({ color: 0x1a2a35 });
      [0.5, -0.5].forEach((zOff) => {
        const hatchGeo = new THREE.BoxGeometry(0.5, 0.08, 0.4);
        const hatch = new THREE.Mesh(hatchGeo, hatchMat);
        hatch.position.set(0, deckY + 0.04, cabinCenterZ + zOff);
        boatGroup.add(hatch);
      });
      return { wallHeight: 0.1 }; /* near-zero so sails/headsail math stays sane */
    }

    if (type === "pilothouse") {
      /* Pilothouse — taller, more vertical walls, flat roof, larger
         rectangular windows instead of round portholes */
      const wallHeight = Math.max(d.cabinHeight, 1.2);
      const wallGeo = new THREE.BoxGeometry(cabinWidth, wallHeight, cabinLength);
      const wallMesh = new THREE.Mesh(wallGeo, cabinMat);
      wallMesh.position.set(0, deckY + wallHeight / 2, cabinCenterZ);
      boatGroup.add(wallMesh);

      const roofGeo = new THREE.BoxGeometry(cabinWidth + 0.15, 0.08, cabinLength + 0.15);
      const roofMesh = new THREE.Mesh(roofGeo, cabinMat);
      roofMesh.position.set(0, deckY + wallHeight + 0.04, cabinCenterZ);
      boatGroup.add(roofMesh); /* flat, no slope */

      const windowMat = new THREE.MeshPhongMaterial({ color: 0x16242e });
      for (let side = -1; side <= 1; side += 2) {
        const windowGeo = new THREE.PlaneGeometry(cabinLength * 0.55, wallHeight * 0.45);
        const win = new THREE.Mesh(windowGeo, windowMat);
        win.position.set(side * (cabinWidth / 2 + 0.01), deckY + wallHeight * 0.58, cabinCenterZ);
        win.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        boatGroup.add(win);
      }
      return { wallHeight };
    }

    /* Default: trunk cabin — box walls + sloped roof + portholes */
    const cabinWallHeight = d.cabinHeight;
    const cabinWallGeo = new THREE.BoxGeometry(cabinWidth, cabinWallHeight, cabinLength);
    const cabinWallMesh = new THREE.Mesh(cabinWallGeo, cabinMat);
    cabinWallMesh.position.set(0, deckY + cabinWallHeight / 2, cabinCenterZ);
    boatGroup.add(cabinWallMesh);

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
          cabinCenterZ - cabinLength / 2 + 0.5 + i * (cabinLength / 3.5)
        );
        porthole.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        boatGroup.add(porthole);
      }
    }
    return { wallHeight: cabinWallHeight };
  }

  /* ---------------------------------------------------------------
     BIMINI TYPES
     --------------------------------------------------------------- */
  function buildBimini(d, hullInfo) {
    const { deckY } = hullInfo;
    const type = d.biminiType || "bimini";
    if (type === "none") return;

    const biminiFrameMat = new THREE.MeshPhongMaterial({ color: 0xc8ccd0 });
    const biminiHalfW = d.biminiWidth / 2 - 0.1;
    const biminiPostPositions = [
      [-biminiHalfW, -0.3], [biminiHalfW, -0.3],
      [-biminiHalfW, -0.3 - (d.biminiLength - 0.2)], [biminiHalfW, -0.3 - (d.biminiLength - 0.2)]
    ];
    biminiPostPositions.forEach(([px, pz]) => {
      const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.3, 6);
      const post = new THREE.Mesh(postGeo, biminiFrameMat);
      post.position.set(px, deckY + 0.65, pz);
      boatGroup.add(post);
    });

    const isHardtop = type === "hardtop";
    const biminiTopGeo = new THREE.BoxGeometry(d.biminiWidth, isHardtop ? 0.1 : 0.06, d.biminiLength);
    const biminiTopMesh = new THREE.Mesh(biminiTopGeo, new THREE.MeshPhongMaterial({
      color: d.biminiColor, flatShading: true, shininess: isHardtop ? 60 : 10
    }));
    biminiTopMesh.position.set(0, deckY + 1.32, -0.3 - (d.biminiLength - 0.2) / 2);
    boatGroup.add(biminiTopMesh);
  }

  /* ---------------------------------------------------------------
     HELM TYPES
     --------------------------------------------------------------- */
  function buildHelm(d, hullInfo) {
    const { deckY } = hullInfo;
    const type = d.helmType || "wheel";

    if (type === "tiller") {
      /* A simple tiller arm instead of a wheel — pivots at the
         transom/stern, angled up toward the cockpit */
      const tillerGeo = new THREE.CylinderGeometry(0.025, 0.04, 1.1, 6);
      const tillerMesh = new THREE.Mesh(tillerGeo, new THREE.MeshPhongMaterial({ color: 0x4a3527 }));
      tillerMesh.position.set(0, deckY + 0.35, hullInfo.sternZ + 0.5);
      tillerMesh.rotation.x = Math.PI / 2.6;
      boatGroup.add(tillerMesh);
      return;
    }

    /* Default: wheel on a post, under the bimini, aft end of the cockpit */
    const helmPostGeo = new THREE.CylinderGeometry(0.05, 0.06, 0.55, 6);
    const helmPostMesh = new THREE.Mesh(helmPostGeo, new THREE.MeshPhongMaterial({ color: 0x3a3a3a }));
    helmPostMesh.position.set(0, deckY + 0.37, -1.7);
    boatGroup.add(helmPostMesh);

    const helmWheelGeo = new THREE.TorusGeometry(0.3, 0.025, 6, 16);
    const helmWheelMesh = new THREE.Mesh(helmWheelGeo, new THREE.MeshPhongMaterial({ color: 0x4a3527 }));
    helmWheelMesh.position.set(0, deckY + 0.68, -1.7);
    helmWheelMesh.rotation.x = Math.PI / 2.3; /* tilted back like a real boat wheel */
    boatGroup.add(helmWheelMesh);
  }

  /* ---------------------------------------------------------------
     LIFELINE TYPES
     --------------------------------------------------------------- */
  function buildLifelines(d, hullInfo) {
    const type = d.lifelineType || "single";
    if (type === "none") return;

    const { bowZ, sternZ, halfWidth, deckY } = hullInfo;
    const stanchionMat = new THREE.MeshPhongMaterial({ color: 0xd0d4d8 });
    const lifelineMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8 });
    const deckEdgeZ = [bowZ * 0.857, bowZ * 0.571, bowZ * 0.286, 0, sternZ * 0.5, sternZ];
    const cableHeights = type === "double" ? [0.22, 0.42] : [0.42];
    const stanchionHeight = type === "double" ? 0.45 : 0.45;

    [-1, 1].forEach((side) => {
      const stanchionPositions = [];
      deckEdgeZ.forEach((z) => {
        const t = Math.max(0, Math.min(1, (bowZ - z) / (bowZ - sternZ)));
        const hw = halfWidth * (1 - 0.5 * Math.pow(1 - t, 2));
        const x = side * Math.min(halfWidth * 0.95, hw);
        stanchionPositions.push([x, z]);

        const stanchionGeo = new THREE.CylinderGeometry(0.025, 0.025, stanchionHeight, 5);
        const stanchion = new THREE.Mesh(stanchionGeo, stanchionMat);
        stanchion.position.set(x, deckY + stanchionHeight / 2, z);
        boatGroup.add(stanchion);
      });

      cableHeights.forEach((cableY) => {
        for (let i = 0; i < stanchionPositions.length - 1; i++) {
          const [x1, z1] = stanchionPositions[i];
          const [x2, z2] = stanchionPositions[i + 1];
          const dx = x2 - x1, dz = z2 - z1;
          const len = Math.sqrt(dx * dx + dz * dz);
          const lineGeo = new THREE.CylinderGeometry(0.012, 0.012, len, 4);
          const line = new THREE.Mesh(lineGeo, lifelineMat);
          line.position.set((x1 + x2) / 2, deckY + cableY, (z1 + z2) / 2);
          line.rotation.x = Math.PI / 2;
          line.rotation.y = Math.atan2(dx, dz);
          boatGroup.add(line);
        }
      });
    });
  }

  /* jibFurlPct: 0 (fully furled/rolled up) .. 100 (full jib out).
     A real roller-furling jib winds the sail around the forestay
     starting from the leech (the free aft edge, our "clew" point),
     rolling inward toward the luff, and wraps around that vertical
     axis as it furls — reading as the sail winding itself up around
     the forestay rather than just shrinking or sinking in place. */
  function updateHeadsailReef(jibFurlPct) {
    if (!headsailMesh) return;
    const pct = Math.max(0, Math.min(100, jibFurlPct)) / 100;
    headsailMesh.scale.z = pct;
    headsailMesh.rotation.y = (1 - pct) * (Math.PI / 2.2); /* opens toward the mast/luff as it furls in, flipped from before */
  }

  /* spinnakerFurlPct: 0 (doused, squeezed into its sock at the
     masthead) .. 100 (fully flying). A cruising spinnaker is usually
     doused by pulling a sock down over it from the head, squeezing
     it into a long thin tube — visually distinct from the jib's
     furl-toward-mast rotation, so this scales the sail vertically
     (collapsing toward the head) and narrows it, rather than
     rotating it around an axis. isVisible additionally requires
     actually being on a downwind point of sail, since a spinnaker
     deployed anywhere else doesn't make sense to render filled. */
  function updateSpinnaker(spinnakerFurlPct, isVisible) {
    if (!spinnakerMesh) return;
    const pct = Math.max(0, Math.min(100, spinnakerFurlPct)) / 100;
    spinnakerMesh.visible = isVisible && pct > 0.02;
    spinnakerMesh.scale.y = Math.max(0.05, pct);   /* collapses toward the head as it's doused */
    spinnakerMesh.scale.x = 0.3 + pct * 0.7;        /* narrows as the sock squeezes it in */
  }

  /* Rebuilds scene-wide wind streaks scattered across the visible
     water area (not attached to the boat/mast) so wind is visible
     everywhere around the player, not just at the masthead. More
     streaks + longer + thicker as wind speed increases. */
  let lastWindLineSpeedKt = -1;
  let windStreakSpeed = 0;
  function buildWindStreakGeometry(length, thickness) {
    /* A tapered "comet" streak: wide/bright at the leading end,
       narrowing and fading toward the trailing end — reads as a
       motion trail rather than a plain solid rod. Built as a thin
       cone (not a cylinder), with a per-vertex alpha attribute so
       the trailing end genuinely fades to transparent rather than
       just darkening toward black (which is what vertex *color*
       alone would do under MeshBasicMaterial, since opacity there
       is a single flat scalar, not per-vertex). */
    const geo = new THREE.ConeGeometry(thickness, length, 6, 1, true);
    const alphas = [];
    const posAttr = geo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      /* ConeGeometry's local Y runs from -length/2 (base, wide end)
         to +length/2 (tip) — tip is the leading/bright end here */
      const y = posAttr.getY(i);
      const t = (y + length / 2) / length; /* 0 at base/trailing, 1 at tip/leading */
      alphas.push(t);
    }
    geo.setAttribute("alpha", new THREE.Float32BufferAttribute(alphas, 1));
    return geo;
  }

  const windStreakMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(0xdff3ff) } },
    vertexShader: `
      attribute float alpha;
      varying float vAlpha;
      void main() {
        vAlpha = alpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        gl_FragColor = vec4(uColor, vAlpha * 0.85);
      }
    `
  });

  function updateWindLines(windSpeedKt) {
    if (!windLinesGroup) return;
    /* Use whichever of true wind or apparent wind is actually faster
       — apparent wind is often stronger on a beat, true wind dominates
       running downwind; using the max gives the most visually
       accurate (and most dramatic, per request) streak speed. */
    const s = window.OSHelm3DState || {};
    const trueSpeed = (typeof windSpeedKt === "number" ? windSpeedKt : s.windSpeedKt) || 0;
    const apparentSpeed = s.apparentWindSpeedKt || 0;
    const effectiveSpeed = Math.max(trueSpeed, apparentSpeed);

    const rounded = Math.round(effectiveSpeed);
    windStreakSpeed = effectiveSpeed;
    if (rounded === lastWindLineSpeedKt) return; /* avoid rebuilding every frame */
    lastWindLineSpeedKt = rounded;

    while (windLinesGroup.children.length) {
      const child = windLinesGroup.children[0];
      windLinesGroup.remove(child);
    }

    /* Longer streaks, spanning from just above the water up to roughly
       cloud altitude, scattered through that whole vertical range so
       wind reads as filling the sky, not just a thin band near the deck */
    const count = Math.max(16, Math.min(70, Math.round(16 + effectiveSpeed * 2.2)));
    const length = Math.max(2.5, Math.min(9, 2.5 + effectiveSpeed * 0.3));
    const thickness = Math.max(0.05, Math.min(0.14, 0.05 + effectiveSpeed * 0.004));

    for (let i = 0; i < count; i++) {
      const geo = buildWindStreakGeometry(length, thickness);
      const line = new THREE.Mesh(geo, windStreakMat);
      line.rotation.x = Math.PI / 2; /* lie flat, streaming along Z, tip pointing forward */
      /* Scatter across a wide area around the boat, at heights
         spanning from just above the water up to cloud altitude
         (clouds sit around y=75-105 — see buildSky) */
      line.position.set(
        (Math.random() - 0.5) * 70,
        4 + Math.random() * 91, /* raised minimum so none spawn close enough to the water to look like scattered dots on its surface */
        (Math.random() - 0.5) * 70
      );
      line.userData.baseZ = line.position.z;
      line.userData.offset = Math.random() * 40;
      windLinesGroup.add(line);
    }
  }

  /* Streams each wind line along the FASTER of true/apparent wind's
     direction over time, wrapping back around so the field feels
     continuous. Re-orients every frame (cheap — just a rotation
     write) since apparent wind direction can change quickly as the
     boat's heading/speed change, unlike the rebuild-on-speed-change
     logic above which is intentionally throttled. */
  function animateWindLines(elapsedFactor) {
    if (!windLinesGroup) return;
    const s = window.OSHelm3DState;
    if (s && typeof s.windDeg === "number") {
      const trueSpeed = s.windSpeedKt || 0;
      const apparentSpeed = s.apparentWindSpeedKt || 0;
      const useApparent = apparentSpeed > trueSpeed && typeof s.apparentWindDeg === "number";
      const sourceDeg = useApparent ? s.apparentWindDeg : s.windDeg;

      const towardDeg = (sourceDeg + 180) % 360;
      /* Same sign convention as the boat's heading rotation (negative) */
      windLinesGroup.rotation.y = -(towardDeg * Math.PI) / 180;
    }
    windLinesGroup.children.forEach((line) => {
      line.position.z -= windStreakSpeed * 0.025 * elapsedFactor; /* 2.5x faster than before (was 0.01) */
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
  function computeTargetHeel(windSpeedKt, trimFactor, pointOfSailFactor, isSailing, ratedWindKt) {
    if (!isSailing) return 0;
    /* Scales from 0° at zero wind up to 30° (max leeward heel) right
       at the boat's actual rated wind speed -- previously this was
       normalized against a fixed, boat-agnostic 20kt assumption with
       an 18° cap, disconnected from each boat's real rated_wind_mph. */
    const effectiveRatedWind = ratedWindKt || 13; /* ~15mph in knots, fallback if not provided */
    const windLoad = Math.min(1, windSpeedKt / effectiveRatedWind);
    const heelMax = 30; /* degrees, at/above rated wind */
    return windLoad * trimFactor * pointOfSailFactor * heelMax;
  }

  const TARGET_FPS = 60; /* raised from 30 -- the lower cap was causing visible stutter, especially in wind particle motion */
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

    waveClock += 0.02; /* back to matching 60fps real-time rate (was 0.04 for the 30fps cap) */

    /* Heading update moved here, to the very top of tick(), so it
       runs BEFORE animateWater/animateWindLines/recordWakePoint below
       -- previously this ran ~50 lines later in the heel/pitch block,
       which meant water flow direction, wind streak direction, and
       the wake trail were always one frame behind the boat's actual
       current heading (or stuck on a stale/null value if that later
       block hadn't executed yet for any reason). This is the real
       fix for "water doesn't change direction when I turn." */
    let turnRateDegPerFrame = 0;
    if (window.OSHelm3DState && typeof window.OSHelm3DState.heading === "number") {
      const headingDt = FRAME_BUDGET_MS / 1000;
      const earlyHeadingAlpha = 1 - Math.exp(-headingDt / HEADING_TIME_CONSTANT);
      const targetHeadingNow = window.OSHelm3DState.heading;
      if (currentHeadingDeg == null) currentHeadingDeg = targetHeadingNow;
      const delta = ((targetHeadingNow - currentHeadingDeg + 540) % 360) - 180;
      const prevHeading = currentHeadingDeg;
      currentHeadingDeg = (currentHeadingDeg + delta * earlyHeadingAlpha + 360) % 360;
      turnRateDegPerFrame = ((currentHeadingDeg - prevHeading + 540) % 360) - 180;

      /* Water flow heading updates MUCH faster than the boat's own
         smooth visual turn (short time constant, not the boat's
         slower HEADING_TIME_CONSTANT) -- this is what fixes the
         water appearing to "stay in one direction" while turning:
         it was tracking the same slow-smoothed value as the boat's
         visual rotation, so during a turn the flow direction lagged
         far enough behind that it read as the boat drifting sideways
         rather than the water correctly redirecting with the turn. */
      const waterFlowAlpha = 1 - Math.exp(-headingDt / 0.15);
      if (waterFlowHeadingDeg == null) waterFlowHeadingDeg = targetHeadingNow;
      const flowDelta = ((targetHeadingNow - waterFlowHeadingDeg + 540) % 360) - 180;
      waterFlowHeadingDeg = (waterFlowHeadingDeg + flowDelta * waterFlowAlpha + 360) % 360;
    }

    const waveHeightFt = window.OSHelm3DState ? window.OSHelm3DState.waveHeightFt : 1;
    animateWater(waveHeightFt);
    animateWindLines(1);
    animateSky(1);
    animateDayNight();
    animateWildlife(0.0167); /* matches the real ~16.7ms frame budget at 60fps */
    if (window.OSHelm3DState) {
      const speedKt = window.OSHelm3DState.speedKt || 0;
      recordWakePoint(currentHeadingDeg || window.OSHelm3DState.heading || 0, speedKt, 0.0167);
      if (bowWaveMesh) {
        const t = Math.min(1, Math.max(0, speedKt) / 6);
        bowWaveMesh.visible = speedKt > 0.5;
        bowWaveMesh.scale.set(0.6 + t * 1.4, 1, 0.6 + t * 1.4);
        bowWaveMesh.material.opacity = 0.35 + t * 0.45;
      }
    }
    updateWakeTrail(0.0167);
    updateAIBoats(0.0167);
    if (window.OSHelm3DState && window.OSHelm3DState.boatLat != null) {
      updateTerrain(window.OSHelm3DState.boatLat, window.OSHelm3DState.boatLon);
    }
    if (currentBoatDNA && aiBoats.length) {
      const playerHalfLength = (currentBoatDNA.hullLength || 6.8) / 2 * (currentBoatDNA.scale || 2.4);
      const playerHalfWidth = (currentBoatDNA.hullWidth || 2.1) / 2 * (currentBoatDNA.scale || 2.4);
      const headingRadNow = currentHeadingDeg != null ? (currentHeadingDeg * Math.PI) / 180 : 0;
      const collidedWith = checkAIBoatCollision(0, 0, playerHalfLength, playerHalfWidth, headingRadNow);
      if (collidedWith && typeof window.OSOnBoatCollision === "function") {
        window.OSOnBoatCollision(); /* hook for game-ui.js to react (sound, damage, etc) in a follow-up -- detection only for this pass */
      }
    }
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
      const waveMotionAlpha = 1 - Math.exp(-dt / WAVE_MOTION_TIME_CONSTANT);

      const targetHeel = computeTargetHeel(s.windSpeedKt, s.trimFactor, s.pointOfSailFactor, s.isSailing, s.ratedWindKt);
      currentHeelDeg += (targetHeel - currentHeelDeg) * heelAlpha;

      /* Gentle idle rocking even with sails down / calm water — a
         becalmed or anchored boat should still bob slightly rather
         than sit perfectly rigid, which read as static/lifeless */
      const effectiveWaveHeight = s.isSailing ? (waveHeightFt || 1) : Math.max(0.5, (waveHeightFt || 1) * 0.5);
      const targetPitch = Math.sin(waveClock * 0.7) * Math.min(14, effectiveWaveHeight * 2.0);
      currentPitchDeg += (targetPitch - currentPitchDeg) * pitchAlpha;

      /* Heading/turnRateDegPerFrame are now computed once at the very
         top of tick() (before water/wind/wake animate), not here --
         see the comment there for why. currentHeelDeg/turnRateDegPerFrame
         remain in scope from outer closures for use below. */

      if (boatGroup) {
        /* Heel to whichever side the wind is actually hitting the
           boat from, derived from real heading vs true wind — NOT
           boom angle, which was only a rough proxy and could
           visually disagree with where the wind streaks show the
           wind actually coming from (e.g. while poorly trimmed or
           motor-sailing). relative 0-360, 0=wind dead ahead,
           0-180=wind hitting the STARBOARD side, 180-360=wind hitting
           the PORT side.

           Sign was confirmed backwards by working through a concrete
           example: with our hull's +X=starboard convention,
           boatGroup.rotation.z follows the standard right-hand rule
           around +Z, so a POSITIVE rotation.z lifts starboard up
           (heels toward PORT), and a NEGATIVE rotation.z heels toward
           STARBOARD. Wind hitting the starboard side (relative 0-180)
           pushes the boat away from that side, heeling it to PORT --
           which needs heelSign=+1, not -1 as the code previously had. */
        let heelSign = 1;
        if (typeof s.heading === "number" && typeof s.windDeg === "number") {
          const relative = ((s.windDeg - s.heading) + 360) % 360;
          heelSign = relative > 180 ? -1 : 1; /* wind on starboard (0-180) heels to port (+1); wind on port (180-360) heels to starboard (-1) */
        }
        /* Real wave-driven roll/pitch — sampled directly from the
           water's actual swell height at points just to port/
           starboard and fore/aft of the boat (it sits at world
           origin in XZ, never translating), instead of a generic
           sine wave disconnected from the real surface. This is what
           makes the boat genuinely RIDE the swells rather than drive
           through them: the deck's height and tilt now reflect what
           the water is actually doing right under the hull. */
        const sampleDist = 2.2; /* still used for roll (port/starboard), which isn't part of this request */
        const heightPort = sampleSwellHeight(-sampleDist, 0);
        const heightStbd = sampleSwellHeight(sampleDist, 0);

        /* Bow/stern waterline riding: sample the real swell height at
           the boat's own actual bow and stern waterline contact
           points (adjustable boat design properties, not a generic
           fixed distance) and derive BOTH the pitch angle and the
           hull's vertical position directly from those two real
           points -- this is what makes the boat genuinely "clip" to
           the wave surface at the bow and stern rather than just
           bobbing as a whole based on an approximated center sample. */
        const bowZ2 = currentBoatDNA.bowWaterlineZ != null ? currentBoatDNA.bowWaterlineZ : 3.57;
        const sternZ2 = currentBoatDNA.sternWaterlineZ != null ? currentBoatDNA.sternWaterlineZ : -2.21;
        const heightBow = sampleSwellHeight(0, bowZ2);
        const heightStern = sampleSwellHeight(0, sternZ2);

        /* Real geometric pitch angle between the two actual waterline
           points -- no arbitrary multiplier needed, since the real
           horizontal distance (bowZ2 - sternZ2) is used directly. */
        const targetWaveRollDeg = Math.max(-8, Math.min(8,
          Math.atan2(heightStbd - heightPort, sampleDist * 2) * (180 / Math.PI) * 3.5));
        const targetWavePitchDeg = Math.max(-12, Math.min(12,
          Math.atan2(heightBow - heightStern, bowZ2 - sternZ2) * (180 / Math.PI)));

        /* Hull's vertical position is the average of where its two
           real ends actually sit on the wave surface -- physically
           the point the hull "rides" if both the bow and stern
           waterline points are constrained to touch the real surface. */
        const targetWaveBobY = (heightBow + heightStern) / 2;

        /* Smoothed toward their targets rather than applied raw every
           frame — these are slope/derivative values riding on top of
           an already-oscillating swell function, so without easing
           any small per-frame timing irregularity reads as visible
           jitter. This is the fix for the reported stuttering. */
        currentWaveRollDeg += (targetWaveRollDeg - currentWaveRollDeg) * waveMotionAlpha;
        currentWavePitchDeg += (targetWavePitchDeg - currentWavePitchDeg) * waveMotionAlpha;
        currentWaveBobY += (targetWaveBobY - currentWaveBobY) * waveMotionAlpha;

        /* Turn lean — a real boat heels INTO a hard turn (centrifugal
           effect), independent of wind heel. turnRateDegPerFrame is
           signed (positive = turning to starboard/right), so this
           naturally leans the correct direction either way. Smoothed
           toward a target rather than applied instantly so it doesn't
           jitter frame to frame. */
        const targetTurnLean = Math.max(-10, Math.min(10, turnRateDegPerFrame * -3.5));
        currentTurnLeanDeg += (targetTurnLean - currentTurnLeanDeg) * 0.12;

        boatGroup.rotation.order = "YXZ"; /* apply heading first, then pitch/heel relative to it */
        /* ROOT CAUSE, finally verified against real ground truth: the
           wake trail's travel-direction formula (recordWakePoint,
           pre-existing and independently working) uses
           moveX=-sin(heading), moveZ=-cos(heading) for the boat's
           real world travel direction at a given heading. The bow's
           visual rotation must produce that SAME world direction.
           Given the bow is built at local +Z, matching that requires
           rotation.y = heading + 180° (not bare +heading or bare
           -heading, both of which were tried and failed against the
           user's concrete, confirmed test case: hdg=90 must visually
           face world (-1,0), per the wake formula above). */
        boatGroup.rotation.y = currentHeadingDeg != null ? -((currentHeadingDeg + 180) * Math.PI) / 180 : -Math.PI; /* flipped sign based on direct visual confirmation: bow pointed left when blue line pointed right (east) with the previous formula */
        boatGroup.rotation.z = ((currentHeelDeg * heelSign) + currentWaveRollDeg + currentTurnLeanDeg) * Math.PI / 180;
        boatGroup.rotation.x = (currentPitchDeg * 0.4 + currentWavePitchDeg) * Math.PI / 180; /* wind-heel pitch contribution reduced, real wave pitch now does most of the work */
        /* The boat's resting position is its own real, saved
           waterline value (currentBoatDNA.waterline). The vertical
           bob is only loosely safety-clamped (not tightly pinned)
           so the boat genuinely RIDES the real swell height instead
           of being constrained to a near-fixed position -- the
           previous 0.6-unit range was far smaller than the actual
           swell height the water shader can produce at bigger swell
           settings, which is why the boat looked locked to one
           height instead of following the waves. */
        const waterlineY = (currentBoatDNA && currentBoatDNA.waterline != null) ? currentBoatDNA.waterline : 0;
        const maxBobRange = 10; /* generous outer safety bound -- covers even the highest swell settings without clipping, not a normal-operation limiter */
        const clampedBob = Math.max(-maxBobRange, Math.min(maxBobRange, currentWaveBobY));
        boatGroup.position.y = waterlineY + clampedBob;
      }

      updateBoom(s.boomAngleDeg || 0);
      updateHeadsailReef(s.isSailing ? (s.jibFurlPct != null ? s.jibFurlPct : 100) : 0); /* 0 = fully down, not sailing */
      updateSpinnaker(s.spinnakerFurlPct || 0, !!s.isSailing && !!s.isDownwind);

      /* Sails visible only while sailing_active. Mainsail now animates
         real luff/fill across its whole surface instead of a single
         camber-bend vertex: well-trimmed sails belly out smoothly
         (a proper curved fill), poorly trimmed ones flutter/ripple
         along the leech like a real luffing sail, scaled by how
         strong the wind is (stronger wind = more visible flutter
         energy). Mainsail height also scales down with reef level. */
      if (sailMesh && sailMesh.userData.basePositions) {
        sailMesh.visible = !!s.isSailing;
        const reefScaleMap = { 0: 1.0, 1: 0.65, 2: 0.35 };
        sailMesh.scale.y = reefScaleMap[s.reefLevel] != null ? reefScaleMap[s.reefLevel] : 1.0;

        const trim = s.trimFactor || 0;          /* 0 = badly trimmed/luffing, 1 = perfectly trimmed */
        const windStrength = Math.min(1, (s.windSpeedKt || 0) / 15);
        const posAttr = sailMesh.geometry.attributes.position;
        const uvAttr = sailMesh.geometry.attributes.uv;
        const base = sailMesh.userData.basePositions;

        for (let i = 0; i < posAttr.count; i++) {
          const u = uvAttr.getX(i); /* 0 at luff/mast, 1 at leech/free edge */
          const v = uvAttr.getY(i); /* 0 at foot, 1 at head */
          const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];

          /* Smooth belly fill — bows outward more toward the leech and
             mid-height, proportional to trim quality */
          const fillAmount = trim * 0.5 * Math.sin(u * Math.PI * 0.5) * Math.sin(v * Math.PI);

          /* Luff flutter — a traveling ripple along the leech that
             gets stronger the worse the trim and the stronger the wind,
             and fades to zero right at the luff (u=0, attached to mast) */
          const luffStrength = (1 - trim) * windStrength;
          const flutter = Math.sin(u * 9 + waveClock * 14 + v * 3) * 0.12 * luffStrength * u;

          posAttr.setX(i, bx + fillAmount + flutter * 0.3);
          posAttr.setZ(i, bz - fillAmount * 0.4 + flutter);
        }
        posAttr.needsUpdate = true;
        sailMesh.geometry.computeVertexNormals();
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
       The compass SVG's "up" tick mark is N at (50,14). Now that
       boatGroup's actual rotation.y is fixed (see tick(), was
       inverted -- the true root cause of all the heading-related
       sign confusion across previous fix attempts), the bow's real
       world bearing directly equals currentHeadingDeg, so this line
       uses the standard compass mapping directly. */
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
       FROM, reversed, since we want which way it's looking AT).
       Matches the confirmed bow-direction convention (verified
       against the pre-existing, working wake-trail formula): at
       heading h, the bow's real world direction is
       (-sin(h), -cos(h)), so converting a world direction back to a
       compass bearing needs atan2(-dx, -dz). */
    const dx = controls.target.x - camera.position.x;
    const dz = controls.target.z - camera.position.z;
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
    setLightState: setLightState,
    buildStationaryAIBoat: buildStationaryAIBoat,
    getScene: function () { return scene; },
    getUnitsPerFoot: function () { return UNITS_PER_FOOT; },
    /* Tears down and regenerates the boat with a new set of design
       parameters — used by the dev console's boat designer for a
       live preview as sliders change, and to apply a saved design
       to a real player's boat. Pass null/omit to rebuild with
       whatever DNA is already current (e.g. after a resize). */
    rebuildBoat: function (dna) {
      if (!scene) return;
      if (boatGroup) { scene.remove(boatGroup); }
      if (wakeTrailMesh) { scene.remove(wakeTrailMesh); wakeTrailMesh = null; wakeHistory = []; }
      importedModelRoot = null; /* old one is detached along with boatGroup above; clear the stale reference */
      buildBoat(dna || currentBoatDNA);
      buildWake();
    },
    getDefaultBoatDNA: defaultBoatDNA,
    getCurrentBoatDNA: function () { return currentBoatDNA; },
    resize: onResize
  };
})();
