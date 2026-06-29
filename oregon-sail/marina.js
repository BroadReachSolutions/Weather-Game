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
    return mesh;
  }

  /* Generates the full marina layout and returns a THREE.Group ready
     to add to the scene. fillFraction (0-1) controls what portion of
     slips start occupied; defaults to a random value in the
     requested 50-90% range if not specified. */
  function buildMarina(unitsPerFoot, fillFraction) {
    const group = new THREE.Group();
    marinaSlips = [];

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
    getSlips: function () { return marinaSlips; }
  };
})();
