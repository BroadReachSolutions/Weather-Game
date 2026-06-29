/* ============================================================
   Oregon Sail — Marina (Docking Minigame)
   A standalone marina the player can warp to for docking practice,
   independent of their real sailing position. Phase 1: layout,
   collidable dock structures, and randomly-filled slips. Docking
   detection/collision counting and shore power are later phases.

   LAYOUT (real-world dimensions, using the same UNITS_PER_FOOT
   conversion as the rest of the scene):
   - A central navigation channel running along world Z
   - Slips (14ft wide x 35ft deep) branch off both sides at regular
     intervals, separated by finger piers
   - A fuel dock sits alongside the channel near the entrance, no
     finger piers — boats pull up alongside it directly
   - 2 rows x 10 slips per side = 40 slips total, 50-90% randomly
     occupied by stationary boats (reusing the existing AI boat
     visual generator, just parked instead of moving)
   ============================================================ */

(function () {
  const SLIP_WIDTH_FT = 14;
  const SLIP_DEPTH_FT = 35;
  const CHANNEL_WIDTH_FT = 60;
  const PIER_THICKNESS_FT = 3;
  const SLIPS_PER_SIDE = 10;
  const FUEL_DOCK_LENGTH_FT = 80;
  const FUEL_DOCK_WIDTH_FT = 10;

  let marinaGroup = null;
  let marinaSlips = []; /* { x, z, headingDeg, occupied, occupantGroup } */
  let marinaActive = false;
  let dockColliders = []; /* { x, z, halfWidth, halfLength } boxes, from Phase 1's dock structures */
  let collisionCount = 0;
  let lastCollisionTime = 0;
  const COLLISION_COOLDOWN_MS = 800; /* a sustained scrape against one piling shouldn't count as dozens of separate collisions */

  let dockedState = { isDocked: false, slipIndex: null, isFuelDock: false, alignedSinceMs: null };
  const DOCK_SPEED_THRESHOLD_KT = 0.5;
  const DOCK_HEADING_TOLERANCE_DEG = 30;
  const DOCK_SUSTAIN_MS = 2000; /* must hold position/speed/heading for this long before counting as actually docked */

  function ft(unitsPerFoot, feet) {
    return feet * unitsPerFoot;
  }

  /* Builds one finger pier — a simple flat-topped box, real
     collidable structure (used by a later phase for player-vs-dock
     collision), positioned at the given world X/Z running along Z. */
  function buildPier(unitsPerFoot, lengthFt, x, z) {
    const length = ft(unitsPerFoot, lengthFt);
    const width = ft(unitsPerFoot, PIER_THICKNESS_FT);
    const height = ft(unitsPerFoot, 2.5);
    const geo = new THREE.BoxGeometry(width, height, length);
    const mat = new THREE.MeshPhongMaterial({ color: 0x8a7355, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, height / 2, z);
    mesh.userData.isDock = true; /* flagged for the later collision-detection phase */
    dockColliders.push({ x, z, halfWidth: width / 2, halfLength: length / 2 });
    return mesh;
  }

  /* Builds the long dock spine each finger pier attaches to, running
     parallel to the channel. */
  function buildDockSpine(unitsPerFoot, lengthFt, x) {
    const length = ft(unitsPerFoot, lengthFt);
    const width = ft(unitsPerFoot, PIER_THICKNESS_FT * 1.3);
    const height = ft(unitsPerFoot, 2.5);
    const geo = new THREE.BoxGeometry(width, height, length);
    const mat = new THREE.MeshPhongMaterial({ color: 0x7a6248, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, height / 2, 0);
    mesh.userData.isDock = true;
    dockColliders.push({ x, z: 0, halfWidth: width / 2, halfLength: length / 2 });
    return mesh;
  }

  /* Builds the fuel dock — a single long dock alongside the channel
     near the entrance, no finger piers. */
  function buildFuelDock(unitsPerFoot, x, z) {
    const length = ft(unitsPerFoot, FUEL_DOCK_LENGTH_FT);
    const width = ft(unitsPerFoot, FUEL_DOCK_WIDTH_FT);
    const height = ft(unitsPerFoot, 2.5);
    const geo = new THREE.BoxGeometry(width, height, length);
    const mat = new THREE.MeshPhongMaterial({ color: 0x9a8362, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, height / 2, z);
    mesh.userData.isDock = true;
    mesh.userData.isFuelDock = true;
    dockColliders.push({ x, z, halfWidth: width / 2, halfLength: length / 2, isFuelDock: true });
    return mesh;
  }

  /* Generates the full marina layout and returns a THREE.Group ready
     to add to the scene. fillFraction (0-1) controls what portion of
     slips start occupied; defaults to a random value in the
     requested 50-90% range if not specified. */
  function buildMarina(unitsPerFoot, fillFraction) {
    const group = new THREE.Group();
    marinaSlips = [];
    dockColliders = [];
    collisionCount = 0;
    dockedState = { isDocked: false, slipIndex: null, isFuelDock: false, alignedSinceMs: null };

    const channelHalfWidth = ft(unitsPerFoot, CHANNEL_WIDTH_FT) / 2;
    const slipDepth = ft(unitsPerFoot, SLIP_DEPTH_FT);
    const slipWidth = ft(unitsPerFoot, SLIP_WIDTH_FT);
    const dockSpineX = channelHalfWidth + slipDepth; /* the spine sits at the far end of the slips, away from the channel */

    /* Water/seafloor placeholder beneath the marina — kept simple
       (flat, no real swell) since this is a sheltered standalone
       practice area, not open ocean. A later phase could reuse the
       real water shader here too if desired. */
    const totalZSpan = ft(unitsPerFoot, SLIP_WIDTH_FT * SLIPS_PER_SIDE + 40);
    const baseGeo = new THREE.PlaneGeometry(dockSpineX * 2 + 40, totalZSpan);
    const baseMat = new THREE.MeshPhongMaterial({ color: 0x2a6d9e, flatShading: true });
    const baseMesh = new THREE.Mesh(baseGeo, baseMat);
    baseMesh.rotation.x = -Math.PI / 2;
    baseMesh.position.y = -0.1;
    group.add(baseMesh);

    [-1, 1].forEach((side) => {
      /* Dock spine for this side, running the full length of its slip row */
      const spineLength = ft(unitsPerFoot, SLIP_WIDTH_FT * SLIPS_PER_SIDE);
      group.add(buildDockSpine(unitsPerFoot, spineLength, side * dockSpineX));

      for (let i = 0; i < SLIPS_PER_SIDE; i++) {
        const slipCenterZ = (i - (SLIPS_PER_SIDE - 1) / 2) * slipWidth;

        /* Finger pier on the near edge of this slip (shared with the
           previous slip's far edge, except for the very first one —
           simplest correct approach is one pier per slip boundary,
           so SLIPS_PER_SIDE+1 piers per side) */
        const pierZ = slipCenterZ - slipWidth / 2;
        group.add(buildPier(unitsPerFoot, SLIP_DEPTH_FT, side * (channelHalfWidth + slipDepth / 2), pierZ));

        const slipX = side * (channelHalfWidth + slipDepth / 2);
        const headingDeg = side === 1 ? 90 : 270; /* boats in slips face out toward the channel */
        marinaSlips.push({
          x: slipX,
          z: slipCenterZ,
          headingDeg,
          occupied: false,
          occupantGroup: null
        });
      }
      /* Final boundary pier for this side */
      const lastZ = ((SLIPS_PER_SIDE - 1) / 2) * slipWidth + slipWidth / 2;
      group.add(buildPier(unitsPerFoot, SLIP_DEPTH_FT, side * (channelHalfWidth + slipDepth / 2), lastZ));
    });

    /* Fuel dock near the channel entrance (one end of the Z span) */
    const entranceZ = -(totalZSpan / 2) + ft(unitsPerFoot, FUEL_DOCK_LENGTH_FT / 2 + 10);
    group.add(buildFuelDock(unitsPerFoot, channelHalfWidth + ft(unitsPerFoot, FUEL_DOCK_WIDTH_FT / 2), entranceZ));

    /* Randomly fill 50-90% of slips with stationary boats, reusing
       the existing AI boat visual generator (buildAIBoatMesh /
       randomBoatDNA from helm3d.js) but parked rather than moving. */
    const fill = fillFraction != null ? fillFraction : (0.5 + Math.random() * 0.4);
    const shuffled = [...marinaSlips].sort(() => Math.random() - 0.5);
    const occupyCount = Math.round(marinaSlips.length * fill);
    for (let i = 0; i < occupyCount; i++) {
      const slip = shuffled[i];
      if (typeof window.OSHelm3D !== "undefined" && window.OSHelm3D.buildStationaryAIBoat) {
        const occupant = window.OSHelm3D.buildStationaryAIBoat();
        occupant.position.set(slip.x, 0.3, slip.z);
        occupant.rotation.y = ((slip.headingDeg + 180) * Math.PI) / 180; /* matches the confirmed player-boat heading convention */
        group.add(occupant);
        slip.occupied = true;
        slip.occupantGroup = occupant;
      }
    }

    return group;
  }

  /* ---------------------------------------------------------------
     PUBLIC API
     --------------------------------------------------------------- */
  /* Circle-vs-box collision check between the player and one dock
     collider. Player approximated as a circle (same technique as the
     existing open-water AI boat collision check) since a precise
     hull-shaped check isn't necessary for "did you hit the dock." */
  function circleIntersectsBox(circleX, circleZ, circleRadius, box) {
    const closestX = Math.max(box.x - box.halfWidth, Math.min(circleX, box.x + box.halfWidth));
    const closestZ = Math.max(box.z - box.halfLength, Math.min(circleZ, box.z + box.halfLength));
    const dx = circleX - closestX;
    const dz = circleZ - closestZ;
    return (dx * dx + dz * dz) < (circleRadius * circleRadius);
  }

  /* Checks the player against every dock structure AND every
     occupied slip's stationary boat. On a NEW collision (not already
     touching as of last check), increments the counter once and
     starts a cooldown so a sustained scrape doesn't count dozens of
     times. Returns true if currently touching anything this frame
     (regardless of whether it was already counted), so callers can
     show a live "touching" indicator separately from the counter. */
  let wasTouchingLastFrame = false;
  function checkMarinaCollisions(playerX, playerZ, playerRadius) {
    let touching = false;

    for (const box of dockColliders) {
      if (circleIntersectsBox(playerX, playerZ, playerRadius, box)) {
        touching = true;
        break;
      }
    }
    if (!touching) {
      for (const slip of marinaSlips) {
        if (!slip.occupied) continue;
        const dx = playerX - slip.x;
        const dz = playerZ - slip.z;
        const occupantRadius = 4; /* approximate, matches the same rough-radius approach the open-water AI boat check uses */
        const combinedRadius = playerRadius + occupantRadius;
        if (dx * dx + dz * dz < combinedRadius * combinedRadius) {
          touching = true;
          break;
        }
      }
    }

    const now = Date.now();
    if (touching && !wasTouchingLastFrame && (now - lastCollisionTime) > COLLISION_COOLDOWN_MS) {
      collisionCount++;
      lastCollisionTime = now;
    }
    wasTouchingLastFrame = touching;
    return touching;
  }

  /* Docking detection: player must be within an empty slip's (or the
     fuel dock's) footprint, moving slowly, and roughly aligned with
     the slip's intended heading -- all sustained for DOCK_SUSTAIN_MS
     before actually counting as docked, so brief pass-throughs or
     momentary slow drifting don't flicker the docked state. */
  function checkDocking(playerX, playerZ, playerHeadingDeg, playerSpeedKt) {
    const now = Date.now();

    if (playerSpeedKt > DOCK_SPEED_THRESHOLD_KT) {
      dockedState = { isDocked: false, slipIndex: null, isFuelDock: false, alignedSinceMs: null };
      return dockedState;
    }

    /* Check empty slips first */
    for (let i = 0; i < marinaSlips.length; i++) {
      const slip = marinaSlips[i];
      if (slip.occupied) continue;
      const dx = Math.abs(playerX - slip.x);
      const dz = Math.abs(playerZ - slip.z);
      const withinFootprint = dx < 6 && dz < 8; /* generous margin within the slip's real footprint */
      if (!withinFootprint) continue;

      const headingDiff = Math.abs(((playerHeadingDeg - slip.headingDeg + 540) % 360) - 180);
      const aligned = headingDiff < DOCK_HEADING_TOLERANCE_DEG;
      if (!aligned) continue;

      if (dockedState.slipIndex !== i || dockedState.alignedSinceMs == null) {
        dockedState = { isDocked: false, slipIndex: i, isFuelDock: false, alignedSinceMs: now };
      } else if (now - dockedState.alignedSinceMs >= DOCK_SUSTAIN_MS) {
        dockedState.isDocked = true;
      }
      return dockedState;
    }

    /* Fuel dock check — alongside docking, so just needs to be near
       the dock's length, not a tight footprint match */
    const fuelDock = dockColliders.find(d => d.isFuelDock);
    if (fuelDock) {
      const dx = Math.abs(playerX - fuelDock.x);
      const dz = Math.abs(playerZ - fuelDock.z);
      if (dx < 10 && dz < fuelDock.halfLength) {
        if (!dockedState.isFuelDock || dockedState.alignedSinceMs == null) {
          dockedState = { isDocked: false, slipIndex: null, isFuelDock: true, alignedSinceMs: now };
        } else if (now - dockedState.alignedSinceMs >= DOCK_SUSTAIN_MS) {
          dockedState.isDocked = true;
        }
        return dockedState;
      }
    }

    dockedState = { isDocked: false, slipIndex: null, isFuelDock: false, alignedSinceMs: null };
    return dockedState;
  }

  /* Per-frame update, called from the main game tick while the
     marina is active. Runs both collision and docking checks
     together since they share the same player position/heading
     inputs. */
  function update(playerX, playerZ, playerHeadingDeg, playerSpeedKt, playerRadius) {
    if (!marinaActive) return null;
    const touching = checkMarinaCollisions(playerX, playerZ, playerRadius || 3);
    const docking = checkDocking(playerX, playerZ, playerHeadingDeg, playerSpeedKt);
    return {
      touching,
      collisionCount,
      docked: docking.isDocked,
      slipIndex: docking.slipIndex,
      isFuelDock: docking.isFuelDock
    };
  }

  /* Shared structure-building functions, exposed so terrain.js's
     custom-region rendering (Map Editor output) can place the same
     dock/pier/fuel-dock primitives the marina itself uses, rather
     than duplicating this geometry code. One small dispatch function
     keyed by type string, matching the structure type names the Map
     Editor's UI offers. */
  window.OSMarinaStructures = {
    build: function (type, unitsPerFoot, lengthFt, x, z, headingDeg) {
      let mesh;
      if (type === "pier") {
        mesh = buildPier(unitsPerFoot, lengthFt, x, z);
      } else if (type === "dock_spine") {
        mesh = buildDockSpine(unitsPerFoot, lengthFt, x);
        mesh.position.z = z; /* buildDockSpine assumes z=0 by default; override for arbitrary placement */
      } else if (type === "fuel_dock") {
        mesh = buildFuelDock(unitsPerFoot, x, z);
      } else {
        return null;
      }
      if (headingDeg) mesh.rotation.y = (headingDeg * Math.PI) / 180;
      return mesh;
    }
  };

  window.OSMarina = {
    /* Generates and shows the marina, hiding it from view until
       called. scene/unitsPerFoot are passed in by helm3d.js, which
       owns the actual THREE.Scene. */
    enter: function (scene, unitsPerFoot, fillFraction) {
      if (marinaGroup) {
        scene.remove(marinaGroup);
        marinaGroup.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) obj.material.dispose();
        });
      }
      marinaGroup = buildMarina(unitsPerFoot, fillFraction);
      scene.add(marinaGroup);
      marinaActive = true;
      return marinaGroup;
    },
    exit: function (scene) {
      if (marinaGroup) {
        scene.remove(marinaGroup);
        marinaGroup.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) obj.material.dispose();
        });
        marinaGroup = null;
      }
      marinaActive = false;
    },
    isActive: function () { return marinaActive; },
    getSlips: function () { return marinaSlips; },
    update: update,
    getCollisionCount: function () { return collisionCount; },
    getDockedState: function () { return dockedState; }
  };
})();
