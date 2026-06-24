/* ============================================================
   Oregon Sail — Game UI
   Wires up the Leaflet map, resource bars, and course-setting
   flow inside the game widget.
   ============================================================ */

(function () {
  let map = null;
  let boatMarker = null;
  let pendingPinMarker = null;
  let pendingDest = null; /* { lat, lon } picked but not yet confirmed */
  let liveUpdateInterval = null;

  let lastSyncedLat = null;
  let lastSyncedLon = null;
  const MIN_SYNC_DISTANCE_NM = 1; /* only re-fetch weather/stations if boat moved at least this far */

  /* ---------------------------------------------------------------
     BOAT-DRIVEN LOCATION SYNC
     The dashboard's weather, forecast, tide chart, and station list
     all read from the global userLat/userLon (defined in script.js).
     Once a boat exists, we override those with the boat's live
     position instead of phone GPS or a saved address — so every
     widget reflects conditions *at the boat*, not at the player.
     --------------------------------------------------------------- */
  async function syncLocationToBoat(boat, force) {
    if (!boat) return;
    /* The simulation loop keeps boat.lat/lon continuously accurate now,
       so we can use them directly instead of the old dead-reckoning
       estimate (which assumed constant speed/heading since the last
       server tick — no longer needed since the client IS the live sim). */
    const lat = boat.lat;
    const lon = boat.lon;

    if (!force && lastSyncedLat != null) {
      const movedNm = OS.haversineNm(lastSyncedLat, lastSyncedLon, lat, lon);
      if (movedNm < MIN_SYNC_DISTANCE_NM) return; /* hasn't moved far enough to matter */
    }

    lastSyncedLat = lat;
    lastSyncedLon = lon;

    /* script.js declares userLat/userLon/marineLocationLat/marineLocationLon
       with `let` at top-level script scope, which does NOT create real
       window properties — so we can't just assign window.userLat = x and
       expect script.js's own functions to see it. script.js exposes a
       real setter (window.setLocationFromBoat) that updates its actual
       lexical variables from inside its own scope. */
    if (typeof window.setLocationFromBoat === "function") {
      window.setLocationFromBoat(lat, lon);
    } else {
      console.warn("Oregon Sail: setLocationFromBoat not found — is script.js loaded before game-ui.js?");
    }

    if (typeof window.fetchAllNoaaStations === "function" && !window.allNoaaStations) {
      window.allNoaaStations = await window.fetchAllNoaaStations();
    }
    if (typeof window.updateNearbyStations === "function") {
      await window.updateNearbyStations(lat, lon);
    } else if (typeof window.refreshAll === "function") {
      await window.refreshAll();
    }
  }

  /* ---------------------------------------------------------------
     SPEED + WINDEX
     Speed over ground currently comes from the boat's last recorded
     speed_over_ground_kt (written by the backend tick). The windex
     needs that same speed plus heading and true wind to compute
     apparent wind via vector math (see instruments.js).
     --------------------------------------------------------------- */
  function updateSpeedAndWindex() {
    if (!OS.boat || typeof window.OSInstruments === "undefined") return;
    const sog = OS.boat.speed_over_ground_kt || 0;
    window.OSInstruments.setSpeedGauge(sog);

    const heading = OS.boat.course_bearing != null ? OS.boat.course_bearing : 0;
    const trueWindDeg = typeof window.getLastWindDeg === "function" ? window.getLastWindDeg() : 0;
    const trueWindKt = typeof window.getLastWindMph === "function" ? window.getLastWindMph() * 0.868976 : 0;
    window.OSInstruments.setWindexGauge(heading, sog, trueWindDeg, trueWindKt);
  }

  /* ---------------------------------------------------------------
     MAIN MENU
     Shown when no boat exists yet (first launch or fresh account).
     Player names their captain and vessel, picks a boat type, then
     we create the boat in Supabase and dismiss into normal gameplay.
     --------------------------------------------------------------- */

  /* Boat type presets — one for now, easily extended later.
     Stats here feed directly into the Supabase boat row on creation. */
  /* Fallback used only if the boat_presets table can't be reached
     (offline, first-ever load before any migration, etc) — keeps the
     main menu functional even when Supabase is briefly unavailable. */
  const FALLBACK_PRESET = {
    preset_key: "cruiser",
    display_name: "Island Packet 380",
    icon: "🛥",
    description: "A blue-water cruiser built for offshore passages. Stiff, seaworthy, forgiving in heavy weather.",
    hull_speed_kt: 7.2,
    rated_wind_mph: 15,
    reef_wind_limits_mph: [25, 30, 35],
    reef_speed_penalty: [1.0, 0.85, 0.65],
    boat_weight_class: "medium",
    main_sail_area_sqft: 245,
    jib_sail_area_sqft: 105
  };

  let loadedPresets = [];

  async function loadBoatPresets() {
    try {
      const { data, error } = await sbClient
        .from("boat_presets")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error || !data || data.length === 0) {
        loadedPresets = [FALLBACK_PRESET];
      } else {
        loadedPresets = data;
      }
    } catch (e) {
      loadedPresets = [FALLBACK_PRESET];
    }
    renderBoatCards();
  }

  function renderBoatCards() {
    const container = document.getElementById("osBoatCards");
    if (!container) return;
    container.innerHTML = "";

    loadedPresets.forEach((p, i) => {
      const card = document.createElement("div");
      card.className = "osBoatCard" + (i === 0 ? " selected" : "");
      card.dataset.presetKey = p.preset_key;
      const reefCount = (p.reef_wind_limits_mph || []).length;
      card.innerHTML = `
        <div class="osBoatCardIcon">${p.icon || "🛥"}</div>
        <div class="osBoatCardName">${p.display_name}</div>
        <div class="osBoatCardStats">
          <span>Hull speed ${p.hull_speed_kt} kt</span>
          <span>Rated wind ${p.rated_wind_mph} mph</span>
          <span>${reefCount} reef point${reefCount === 1 ? "" : "s"}</span>
        </div>
        <div class="osBoatCardDesc">${p.description || ""}</div>
      `;
      card.addEventListener("click", () => {
        document.querySelectorAll(".osBoatCard").forEach(c => c.classList.remove("selected"));
        card.classList.add("selected");
      });
      container.appendChild(card);
    });
  }

  function showMainMenu() {
    const menu = document.getElementById("osMainMenu");
    if (menu) menu.style.display = "flex";
    loadBoatPresets();
  }

  function hideMainMenu() {
    const menu = document.getElementById("osMainMenu");
    if (menu) menu.style.display = "none";
  }

  function wireMainMenu() {
    const beginBtn = document.getElementById("osBeginBtn");
    const errorEl = document.getElementById("osMenuError");
    if (!beginBtn) return;

    beginBtn.addEventListener("click", async () => {
      const captainName = document.getElementById("osCaptainName").value.trim();
      const vesselName = document.getElementById("osVesselName").value.trim();
      const selectedCard = document.querySelector(".osBoatCard.selected");
      const presetKey = selectedCard ? selectedCard.dataset.presetKey : (loadedPresets[0] && loadedPresets[0].preset_key);
      const preset = loadedPresets.find(p => p.preset_key === presetKey) || loadedPresets[0] || FALLBACK_PRESET;

      if (!captainName) { errorEl.textContent = "Please enter your captain's name."; return; }
      if (!vesselName)  { errorEl.textContent = "Please name your vessel."; return; }

      errorEl.textContent = "";
      beginBtn.textContent = "Setting sail…";
      beginBtn.disabled = true;

      const isDeveloper = captainName.toLowerCase() === "sonic" && vesselName.toLowerCase() === "sonic";
      const boat = await OS.createBoat({
        captain_name: captainName,
        vessel_name: vesselName,
        is_developer: isDeveloper,
        hull_speed_kt: preset.hull_speed_kt,
        rated_wind_mph: preset.rated_wind_mph,
        reef_wind_limits_mph: preset.reef_wind_limits_mph,
        reef_speed_penalty: preset.reef_speed_penalty,
        boat_weight_class: preset.boat_weight_class,
        main_sail_area_sqft: preset.main_sail_area_sqft,
        jib_sail_area_sqft: preset.jib_sail_area_sqft,
        hull_design: preset.hull_design || null
      });

      if (!boat) {
        errorEl.textContent = "Couldn't connect to the server — check your connection.";
        beginBtn.textContent = "Begin Voyage ⛵";
        beginBtn.disabled = false;
        return;
      }

      hideMainMenu();
      await initGameplay(boat);
    });
  }

  /* ---------------------------------------------------------------
     INIT
     --------------------------------------------------------------- */
  async function initOregonSail() {
    wireMainMenu();

    const statusLine = document.getElementById("osStatusLine");
    statusLine.textContent = "Loading your vessel…";

    /* Try to load an existing boat for this device */
    const boat = await OS.loadBoatOnly();

    if (!boat) {
      /* No boat yet — show the main menu so the player can set up */
      statusLine.textContent = "Welcome to Oregon Sail";
      showMainMenu();
      return;
    }

    hideMainMenu();
    await initGameplay(boat);
  }

  async function initGameplay(boat) {
    await syncLocationToBoat(boat, true);

    initMap(boat);
    initDivider();
    renderResourceBar(boat);
    renderStatusLine(boat);
    wireControls();
    updateSpeedAndWindex();
    initTrack();
    if (typeof updateRadarCenterBtnVisibility === "function") updateRadarCenterBtnVisibility();

    if (typeof window.OSHelm3D !== "undefined") {
      window.OSHelm3D.init();
      if (boat.hull_design) {
        /* init() builds the scene async (waits for the canvas/THREE
           to be ready), so give it a moment before rebuilding with
           the saved design — otherwise rebuildBoat() runs before
           there's a scene to rebuild into */
        setTimeout(() => window.OSHelm3D.rebuildBoat(boat.hull_design), 500);
      }
      /* Restore saved light switch states once the scene/boat exist */
      setTimeout(() => {
        if (!window.OSHelm3D.setLightState) return;
        ["anchor", "nav", "steaming", "deck", "cockpit"].forEach(key => {
          window.OSHelm3D.setLightState(key, !!boat["light_" + key]);
        });
      }, boat.hull_design ? 600 : 300);
    }

    startSimulationLoop();

    /* Developer mode — unlocked when captain/vessel are both "Sonic".
       Backfills the flag for boats created before this column existed
       too, so returning Sonic/Sonic players don't need to start over. */
    if (boat.is_developer ||
        ((boat.captain_name || "").toLowerCase() === "sonic" && (boat.vessel_name || "").toLowerCase() === "sonic")) {
      if (!boat.is_developer) await OS.setDeveloperFlag(true);
      if (typeof window.OSDevConsole !== "undefined") window.OSDevConsole.init();
    }

    /* Weather refresh — flat 10-minute timer now, matching the
       server tick interval, instead of the old distance-triggered
       check. The boat's position is whatever the simulation loop
       has advanced it to at that moment. */
    setInterval(async () => {
      if (!OS.boat) return;
      await syncLocationToBoat(OS.boat, true); /* force=true: always refresh on this timer */
    }, 10 * 60 * 1000);

    /* Push the client's simulated state to the server every 10 min,
       so the server's own tick (which keeps the boat moving while
       the app is closed) picks up from where the client left off
       instead of fighting it. */
    setInterval(syncStateToServer, 10 * 60 * 1000);
  }

  /* ---------------------------------------------------------------
     CLIENT SIMULATION LOOP
     Advances the boat's position and resource consumption smoothly
     in real time using the shared physics module (oregon-sail/physics.js
     — the same formulas the server tick uses), instead of jumping
     once every 10 minutes. The server's own cron tick keeps running
     independently so the voyage still progresses while the app is
     closed; syncStateToServer() periodically reconciles the two.
     --------------------------------------------------------------- */
  const SIM_TICK_MS = 250; /* advance the simulation 4x/sec — was 1000ms, which made the underlying heading/position jump in discrete once-per-second steps that even the 3D visual smoothing couldn't fully hide */
  let simIntervalId = null;
  let lastSimTime = null;

  function startSimulationLoop() {
    lastSimTime = Date.now();
    simIntervalId = setInterval(simulationStep, SIM_TICK_MS);
  }

  function simulationStep() {
    if (!OS.boat || typeof window.OSPhysics === "undefined") return;
    const now = Date.now();
    const elapsedHours = (now - lastSimTime) / 3600000;
    lastSimTime = now;
    if (elapsedHours <= 0 || elapsedHours > 0.1) return; /* skip absurd gaps (tab was backgrounded) */

    const boat = OS.boat;
    const isMoving = boat.sailing_active || boat.engine_on;
    if (!isMoving) {
      updateBoatMarkerPosition(boat);
      updateSpeedAndWindex();
      return;
    }

    const windDeg = typeof window.getLastWindDeg === "function" ? window.getLastWindDeg() : 0;
    const windKt = typeof window.getLastWindMph === "function" ? window.getLastWindMph() * 0.868976 : 0;

    const headingBeforeTick = boat.course_bearing; /* capture BEFORE advance() runs, since advance() mutates boat.course_bearing directly via reference */
    const result = window.OSPhysics.advance(boat, windKt, windDeg, elapsedHours);
    if (window.OS_DEBUG_STEERING) {
      console.log("[OS DEBUG] sim tick:", {
        autopilot: boat.autopilot_on, rudder: boat.rudder_angle,
        headingBefore: headingBeforeTick, headingAfter: result.heading,
        speedKt: result.speedKt, elapsedHours
      });
    }

    /* Mutate the in-memory boat state directly — this is the client
       simulation "moving" the boat between server syncs */
    boat.lat = result.lat;
    boat.lon = result.lon;
    boat.course_bearing = result.heading;
    boat.speed_over_ground_kt = result.speedKt;
    boat.fuel = Math.max(0, boat.fuel - result.fuelUsed);
    boat.food = Math.max(0, boat.food - result.foodUsed);
    boat.water = Math.max(0, boat.water - result.waterUsed);
    boat.total_nm_traveled = (boat.total_nm_traveled || 0) + Math.abs(result.nmMoved);

    /* Arrived at destination? */
    if (boat.destination_lat != null) {
      const distToDest = window.OSPhysics.haversineNm(boat.lat, boat.lon, boat.destination_lat, boat.destination_lon);
      if (distToDest < 2) {
        boat.sailing_active = false;
        renderStatusLine(boat);
      }
    }

    updateBoatMarkerPosition(boat);
    updateSpeedAndWindex();
    renderResourceBar(boat);

    if (window.OSInstruments) {
      window.OSInstruments.setWheelState(boat.rudder_angle || 0, boat.autopilot_on);
    }

    /* Track recording uses the same 1nm-sampling logic, fed by the
       simulated position now instead of only the server-confirmed one */
    maybeRecordTrackPoint(boat.lat, boat.lon);
  }

  /* ---------------------------------------------------------------
     SERVER SYNC
     Pushes the client's simulated state up to Supabase every 10 min
     so the server's own tick (for when the app is closed) continues
     from an accurate position instead of replaying from a stale one.
     --------------------------------------------------------------- */
  async function syncStateToServer() {
    if (!OS.boat) return;
    await OS.pushSimulatedState({
      lat: OS.boat.lat,
      lon: OS.boat.lon,
      course_bearing: OS.boat.course_bearing,
      rudder_angle: OS.boat.rudder_angle,
      autopilot_on: OS.boat.autopilot_on,
      fuel: OS.boat.fuel,
      food: OS.boat.food,
      water: OS.boat.water,
      hull_health: OS.boat.hull_health,
      sailing_active: OS.boat.sailing_active,
      speed_over_ground_kt: OS.boat.speed_over_ground_kt,
      total_nm_traveled: OS.boat.total_nm_traveled
    });
  }

  /* ---------------------------------------------------------------
     MAP
     --------------------------------------------------------------- */
  /* ---------------------------------------------------------------
     BOAT ICON SVG
     A top-down hull silhouette with a mast/boom/sail (rotatable for
     trim) and a small wind-direction arrow. All rotations are in
     degrees, 0° = pointing up (north) within the icon's own local
     space — Leaflet's divIcon doesn't rotate with the map, so we
     rotate the hull to match heading, and rotate the boom/arrow
     independently.
     --------------------------------------------------------------- */
  const BOAT_ICON_SIZE = 64;

  function buildBoatIconHtml(headingDeg, boomAngleDeg, windArrowDeg, windArrowOffset) {
    const s = BOAT_ICON_SIZE;
    const c = s / 2;
    const offset = windArrowOffset || { x: 0, y: -s * 0.85 };

    /* Sail is drawn as a thin triangle from the mast out to the boom
       tip, billowing to whichever side the boom is trimmed toward.
       The boom pivots near the mast base and swings aft (toward the
       stern, at the bottom of the icon) — at 0° it trails straight
       back along the centerline; positive boomAngleDeg = boom swung
       to starboard (right) as you'd see it from the cockpit. */
    const mastX = c, mastTopY = c - 13, mastBotY = c + 12;
    const boomPivotY = c - 11;
    const boomLen = 21;
    const boomRad = (boomAngleDeg * Math.PI) / 180;
    const boomTipX = mastX + Math.sin(boomRad) * boomLen;
    const boomTipY = boomPivotY + Math.cos(boomRad) * boomLen;
    /* Sail belly bulges away from the wind, perpendicular-ish to the boom */
    const bellyX = mastX + Math.sin(boomRad) * (boomLen * 0.45) + Math.cos(boomRad) * (boomAngleDeg >= 0 ? 4 : -4);
    const bellyY = boomPivotY + Math.cos(boomRad) * (boomLen * 0.45);

    return `
      <svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" style="overflow:visible;">
        <g transform="rotate(${headingDeg} ${c} ${c})">
          <path d="M ${c} ${c - 20}
                   L ${c + 9} ${c - 5}
                   L ${c + 8} ${c + 17}
                   Q ${c} ${c + 22} ${c - 8} ${c + 17}
                   L ${c - 9} ${c - 5}
                   Z"
                fill="#e8e4da" stroke="#1a2a35" stroke-width="1.4"/>
          <path d="M ${mastX} ${boomPivotY} Q ${bellyX} ${bellyY} ${boomTipX} ${boomTipY} Z"
                fill="#dfeaf2" stroke="#9fb8c8" stroke-width="0.8" opacity="0.92"/>
          <line x1="${mastX}" y1="${mastTopY}" x2="${mastX}" y2="${mastBotY}"
                stroke="#5a4632" stroke-width="1.8"/>
          <line x1="${mastX}" y1="${boomPivotY}" x2="${boomTipX}" y2="${boomTipY}"
                stroke="#cfd8df" stroke-width="2.6" stroke-linecap="round"
                class="osBoomLine" style="cursor:grab;"/>
        </g>
        <g class="osWindArrowGroup" data-base-x="${offset.x}" data-base-y="${offset.y}"
           transform="translate(${c + offset.x} ${c + offset.y}) rotate(${windArrowDeg})">
          <line x1="0" y1="10" x2="0" y2="-10" stroke="#4fc3f7" stroke-width="2.2" stroke-linecap="round"/>
          <path d="M -5 -5 L 0 -12 L 5 -5 Z" fill="#4fc3f7"/>
        </g>
      </svg>
    `;
  }

  function loadWindArrowOffset() {
    const raw = localStorage.getItem("osWindArrowOffset");
    if (!raw) return { x: 0, y: -BOAT_ICON_SIZE * 0.85 };
    try { return JSON.parse(raw); } catch (e) { return { x: 0, y: -BOAT_ICON_SIZE * 0.85 }; }
  }

  function saveWindArrowOffset(offset) {
    localStorage.setItem("osWindArrowOffset", JSON.stringify(offset));
  }

  function loadBoomAngle() {
    const raw = localStorage.getItem("osBoomAngle");
    const val = raw != null ? parseFloat(raw) : 25;
    return isNaN(val) ? 25 : val;
  }

  function saveBoomAngle(angle) {
    localStorage.setItem("osBoomAngle", String(angle));
  }

  let currentBoomAngle = loadBoomAngle(); /* relative to boat centerline, -90..90 degrees */
  let currentWindArrowOffset = loadWindArrowOffset();

  /* ---------------------------------------------------------------
     POINT OF SAIL
     Calculates the angle between the boat's heading and the true
     wind, classifies it into a named point of sail, and judges how
     well the current boom trim matches the ideal trim for that
     point of sail. windAngle is 0-180, where 0 = wind dead ahead
     (head to wind) and 180 = wind dead behind (dead run).
     --------------------------------------------------------------- */
  const POINTS_OF_SAIL = [
    { max: 45,  name: "No-Go Zone",   idealBoom: null, color: "#ff6b6b" },
    { max: 60,  name: "Close-Hauled", idealBoom: 15,   color: "#69f0ae" },
    { max: 80,  name: "Close Reach",  idealBoom: 28,   color: "#69f0ae" },
    { max: 120, name: "Beam Reach",   idealBoom: 45,   color: "#69f0ae" },
    { max: 150, name: "Broad Reach",  idealBoom: 65,   color: "#69f0ae" },
    { max: 181, name: "Running",      idealBoom: 85,   color: "#69f0ae" }
  ];

  function angleDiff180(a, b) {
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function calculatePointOfSail(headingDeg, windFromDeg) {
    /* windFromDeg is the compass direction the wind is COMING FROM.
       The angle relevant to point-of-sail is how far that is from
       directly behind the boat's heading. */
    const windAngle = angleDiff180(headingDeg, windFromDeg);
    const pos = POINTS_OF_SAIL.find(p => windAngle <= p.max) || POINTS_OF_SAIL[POINTS_OF_SAIL.length - 1];

    /* Which side is the wind coming over? Determines which way the
       boom should be let out (boom swings away from the wind). */
    let relative = ((windFromDeg - headingDeg) + 360) % 360; /* 0-360, 0=ahead, 180=behind */
    const windOnPort = relative > 180; /* wind from the left = boom goes right (starboard) */
    const idealBoomSigned = pos.idealBoom == null ? 0 : (windOnPort ? pos.idealBoom : -pos.idealBoom);

    return { windAngle, ...pos, idealBoomSigned, windOnPort };
  }

  function trimQuality(actualBoomAngle, idealBoomSigned, isNoGoZone) {
    if (isNoGoZone) return { label: "Can't sail this close to the wind", pct: 0 };
    const diff = Math.abs(actualBoomAngle - idealBoomSigned);
    if (diff <= 6)  return { label: "Perfectly trimmed",  pct: 100 };
    if (diff <= 14) return { label: "Well trimmed",       pct: 80 };
    if (diff <= 25) return { label: "Loosely trimmed",    pct: 55 };
    if (diff <= 40) return { label: "Poorly trimmed",     pct: 30 };
    return { label: "Stalled / luffing", pct: 10 };
  }

  function refreshBoatIcon() {
    if (!boatMarker) return;
    const heading = (OS.boat && OS.boat.course_bearing != null) ? OS.boat.course_bearing : 0;
    const windDeg = typeof window.getLastWindDeg === "function" ? window.getLastWindDeg() : 0;
    /* Wind arrow shows TRUE wind direction in world space, so we
       counter-rotate by the icon's heading rotation (since the whole
       divIcon doesn't rotate with the map, but the hull <g> inside it
       does — the arrow group is a sibling, untouched by that rotation,
       so it already reflects world-relative direction directly). */
    const html = buildBoatIconHtml(heading, currentBoomAngle, windDeg, currentWindArrowOffset);
    const icon = L.divIcon({
      className: "osBoatIcon",
      html,
      iconSize: [BOAT_ICON_SIZE, BOAT_ICON_SIZE],
      iconAnchor: [BOAT_ICON_SIZE / 2, BOAT_ICON_SIZE / 2]
    });
    boatMarker.setIcon(icon);
    renderSailingInfo(heading, windDeg);
  }

  function renderSailingInfo(heading, windDeg) {
    const pos = calculatePointOfSail(heading, windDeg);
    const trim = trimQuality(currentBoomAngle, pos.idealBoomSigned, pos.name === "No-Go Zone");

    const posLabel = document.getElementById("osPointOfSail");
    const trimLabel = document.getElementById("osTrimQuality");
    const trimBar = document.getElementById("osTrimQualityFill");

    if (posLabel) {
      posLabel.textContent = pos.name;
      posLabel.style.color = pos.name === "No-Go Zone" ? "#ff6b6b" : "#9fc2d9";
    }
    if (trimLabel) trimLabel.textContent = trim.label;
    if (trimBar) {
      trimBar.style.width = trim.pct + "%";
      trimBar.style.background = trim.pct >= 80 ? "linear-gradient(90deg,#4fc3f7,#69f0ae)" :
                                  trim.pct >= 50 ? "linear-gradient(90deg,#ffca4f,#ffb84f)" :
                                  "linear-gradient(90deg,#ff6b6b,#ff8a80)";
    }

    feed3DState(heading, windDeg, pos, trim);
  }

  /* ---------------------------------------------------------------
     3D HELM VIEW — feed live physics state so the boat heels,
     pitches, and trims its sail to match real conditions. Uses the
     exact same point-of-sail/trim-quality math the rest of the game
     already computes — this is a renderer for existing data, not a
     second physics system.
     --------------------------------------------------------------- */
  let pointOfSailFactorMap = {
    "No-Go Zone": 0, "Close-Hauled": 0.7, "Close Reach": 0.9,
    "Beam Reach": 1.0, "Broad Reach": 0.9, "Running": 0.75
  };

  function feed3DState(heading, windDeg, pos, trim) {
    if (typeof window.OSHelm3D === "undefined") return;
    const windSpeedKt = typeof window.getLastWindMph === "function"
      ? window.getLastWindMph() * 0.868976 : 0;
    const isSailing = !!(OS.boat && OS.boat.sailing_active);
    const boatSpeedKt = OS.boat ? (OS.boat.speed_over_ground_kt || 0) : 0;

    /* Apparent wind as a TRUE COMPASS direction/speed (not relative
       to the bow) — the wind streak field needs this to actually
       move correctly relative to the world, not just relative to
       the boat's heading the way the windex gauge uses it. */
    let apparentWindDeg = windDeg;
    let apparentWindSpeedKt = windSpeedKt;
    if (window.OSInstruments && window.OSInstruments.calculateApparentWind) {
      const toRad = d => (d * Math.PI) / 180;
      const twToward = (windDeg + 180) % 360;
      const twX = windSpeedKt * Math.sin(toRad(twToward));
      const twY = windSpeedKt * Math.cos(toRad(twToward));
      const boatX = boatSpeedKt * Math.sin(toRad(heading));
      const boatY = boatSpeedKt * Math.cos(toRad(heading));
      const awX = twX - boatX;
      const awY = twY - boatY;
      apparentWindSpeedKt = Math.sqrt(awX * awX + awY * awY);
      const awToward = (Math.atan2(awX, awY) * 180) / Math.PI;
      apparentWindDeg = (awToward + 180 + 360) % 360; /* compass "from" direction */
    }

    window.OSHelm3D.setState({
      heading,
      windDeg,
      windSpeedKt,
      apparentWindDeg,
      apparentWindSpeedKt,
      trimFactor: trim.pct / 100,
      pointOfSailFactor: pointOfSailFactorMap[pos.name] != null ? pointOfSailFactorMap[pos.name] : 0,
      boomAngleDeg: currentBoomAngle,
      isSailing,
      reefLevel: OS.boat ? (OS.boat.reef_level || 0) : 0,
      jibFurlPct: OS.boat ? (OS.boat.jib_furl_pct != null ? OS.boat.jib_furl_pct : 100) : 100,
      spinnakerFurlPct: OS.boat ? (OS.boat.spinnaker_furl_pct || 0) : 0,
      isDownwind: pos.name === "Broad Reach" || pos.name === "Running",
      speedKt: boatSpeedKt,
      /* Simple estimate matching the same formula the tick function
         uses server-side, since we don't have a live wave-height
         feed on the client -- unless the dev console has an active
         swell-height override, in which case that wins outright for
         testing/tuning purposes. */
      waveHeightFt: (window.OSDevSwellOverride && window.OSDevSwellOverride.active)
        ? window.OSDevSwellOverride.heightFt
        : Math.max(0.5, (windSpeedKt / 10) * 1.8)
    });
  }

  /* ---------------------------------------------------------------
     NAUTICAL SCALE BAR (bottom-left of the map)
     Leaflet's built-in scale control only does metric/imperial miles,
     not nautical miles — sailors think in nm, so we build a small
     custom control that picks a "nice" round nm distance and renders
     a bar matching its real pixel width at the current zoom/latitude.
     --------------------------------------------------------------- */
  function addNauticalScaleControl(mapInstance) {
    const ScaleControl = L.Control.extend({
      options: { position: "bottomleft" },
      onAdd: function () {
        const div = L.DomUtil.create("div", "osNauticalScale");
        div.innerHTML = `<div class="osNauticalScaleBar"></div><div class="osNauticalScaleLabel">—</div>`;
        return div;
      }
    });
    const control = new ScaleControl();
    control.addTo(mapInstance);

    /* "Nice" round nm steps to choose from at any zoom level */
    const NICE_STEPS_NM = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const MAX_BAR_PX = 90;

    function updateScale() {
      const el = mapInstance.getContainer().querySelector(".osNauticalScale");
      if (!el) return;
      const bar = el.querySelector(".osNauticalScaleBar");
      const label = el.querySelector(".osNauticalScaleLabel");

      /* Real-world nm spanned by MAX_BAR_PX pixels at the map's current
         view (measuring along a horizontal line near the map's center) */
      const centerPt = mapInstance.latLngToContainerPoint(mapInstance.getCenter());
      const p1 = mapInstance.containerPointToLatLng([centerPt.x, centerPt.y]);
      const p2 = mapInstance.containerPointToLatLng([centerPt.x + MAX_BAR_PX, centerPt.y]);
      const nmAtMaxWidth = OS.haversineNm(p1.lat, p1.lng, p2.lat, p2.lng);

      /* Pick the largest "nice" step that still fits within MAX_BAR_PX */
      let chosenNm = NICE_STEPS_NM[0];
      for (const step of NICE_STEPS_NM) {
        if (step <= nmAtMaxWidth) chosenNm = step;
        else break;
      }
      const barPx = MAX_BAR_PX * (chosenNm / nmAtMaxWidth);

      bar.style.width = Math.max(20, barPx) + "px";
      label.textContent = chosenNm >= 1 ? `${chosenNm} nm` : `${(chosenNm * 1852).toFixed(0)} m`;
    }

    mapInstance.on("zoom move", updateScale);
    updateScale();
  }

  function initMap(boat) {
    const mapEl = document.getElementById("osMap");
    if (!mapEl || map) return;

    map = L.map(mapEl, {
      zoomControl: true,
      attributionControl: false
    }).setView([boat.lat, boat.lon], 7);

    /* Same ArcGIS World Imagery satellite tiles as the compass widget,
       just served through Leaflet's tile-pyramid loader instead of
       manual canvas math — same visual style, full pan/zoom/tap. */
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 17, minZoom: 3 }
    ).addTo(map);

    addNauticalScaleControl(map);

    const initialIcon = L.divIcon({
      className: "osBoatIcon",
      html: buildBoatIconHtml(boat.course_bearing || 0, currentBoomAngle, 0, currentWindArrowOffset),
      iconSize: [BOAT_ICON_SIZE, BOAT_ICON_SIZE],
      iconAnchor: [BOAT_ICON_SIZE / 2, BOAT_ICON_SIZE / 2]
    });

    boatMarker = L.marker([boat.lat, boat.lon], { icon: initialIcon }).addTo(map);
    setupWindArrowDrag();

    if (boat.destination_lat != null) {
      showPendingPin(boat.destination_lat, boat.destination_lon, false);
      if (boat.sailing_active || boat.engine_on) drawCourseLine(boat.destination_lat, boat.destination_lon);
    }

    map.on("click", (e) => {
      handleMapTap(e.latlng.lat, e.latlng.lng);
    });
  }

  /* ---------------------------------------------------------------
     WIND ARROW DRAG (edit mode only)
     The arrow's position relative to the boat icon can be dragged
     when the dashboard is in Edit Layout mode. Direction always
     reflects real wind — only the placement is adjustable.
     --------------------------------------------------------------- */
  function setupWindArrowDrag() {
    if (!map) return;
    let dragging = false;
    let dragStartPx = null;
    let dragStartOffset = null;

    map.on("mousedown touchstart", (e) => {
      if (!document.body.classList.contains("layout-edit")) return;
      const target = e.originalEvent.target;
      if (!target.closest(".osWindArrowGroup")) return;

      dragging = true;
      dragStartPx = map.mouseEventToContainerPoint(e.originalEvent.touches ? e.originalEvent.touches[0] : e.originalEvent);
      dragStartOffset = { ...currentWindArrowOffset };
      map.dragging.disable(); /* don't pan the map while dragging the arrow */
      if (e.originalEvent.preventDefault) e.originalEvent.preventDefault();
    });

    map.on("mousemove touchmove", (e) => {
      if (!dragging) return;
      const ev = e.originalEvent.touches ? e.originalEvent.touches[0] : e.originalEvent;
      const pt = map.mouseEventToContainerPoint(ev);
      const dx = pt.x - dragStartPx.x;
      const dy = pt.y - dragStartPx.y;
      currentWindArrowOffset = { x: dragStartOffset.x + dx, y: dragStartOffset.y + dy };
      refreshBoatIcon();
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      map.dragging.enable();
      saveWindArrowOffset(currentWindArrowOffset);
    }
    map.on("mouseup touchend", endDrag);
  }

  let courseLine = null;
  let courseDistanceLabel = null;

  /* ---------------------------------------------------------------
     DRAGGABLE DIVIDER
     A thin grab-handle between the map and the tab content area.
     Dragging it up/down adjusts the map's flex-basis (height) and
     persists the split so it survives page reloads.
     --------------------------------------------------------------- */
  const DIVIDER_STORAGE_KEY = "osMapSplitPct";
  const MAP_MIN_PCT = 15;   /* map can't shrink below 15% of container */
  const MAP_MAX_PCT = 85;   /* map can't grow above 85% */

  function loadSplit() {
    const raw = localStorage.getItem(DIVIDER_STORAGE_KEY);
    const val = raw != null ? parseFloat(raw) : 50;
    return isNaN(val) ? 50 : Math.max(MAP_MIN_PCT, Math.min(MAP_MAX_PCT, val));
  }

  function applySplit(pct) {
    const helmWrap = document.querySelector(".osHelmViewWrap");
    if (helmWrap) helmWrap.style.flex = `0 0 ${pct}%`;
    if (typeof window.OSHelm3D !== "undefined") {
      setTimeout(() => window.OSHelm3D.resize(), 50);
    }
  }

  function initDivider() {
    const divider = document.getElementById("osDivider");
    const box = document.getElementById("gameWidgetBox");
    if (!divider || !box) return;

    /* Restore saved split */
    applySplit(loadSplit());

    let dragging = false;
    let startY = 0;
    let startPct = 0;

    function getY(e) {
      return e.touches ? e.touches[0].clientY : e.clientY;
    }

    function onDown(e) {
      e.preventDefault();
      dragging = true;
      startY = getY(e);
      startPct = loadSplit();
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
    }

    function onMove(e) {
      if (!dragging) return;
      e.preventDefault();
      const boxRect = box.getBoundingClientRect();
      const dy = getY(e) - startY;
      const deltaPct = (dy / boxRect.height) * 100;
      const newPct = Math.max(MAP_MIN_PCT, Math.min(MAP_MAX_PCT, startPct + deltaPct));
      applySplit(newPct);
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      /* Save the final split as percentage */
      const mapWrap = document.querySelector(".osMapWrap");
      if (mapWrap) {
        const pct = parseFloat(mapWrap.style.flex.split(" ")[2]) || 50;
        localStorage.setItem(DIVIDER_STORAGE_KEY, String(pct));
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    }

    divider.addEventListener("mousedown", onDown);
    divider.addEventListener("touchstart", onDown, { passive: false });
  }

  function handleMapTap(lat, lon) {
    pendingDest = { lat, lon };
    showPendingPin(lat, lon, true);
    drawCourseLine(lat, lon);

    document.getElementById("osSetCourseBtn").style.display = "";
    document.getElementById("osCancelCourseBtn").style.display = "";
  }

  function showPendingPin(lat, lon, isPending) {
    if (pendingPinMarker) {
      map.removeLayer(pendingPinMarker);
      pendingPinMarker = null;
    }
    const icon = L.divIcon({
      className: isPending ? "osPinIconPending" : "osPinIcon",
      html: '<div class="osDiamondMarker"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    pendingPinMarker = L.marker([lat, lon], { icon }).addTo(map);
  }

  /* ---------------------------------------------------------------
     COURSE LINE
     A thin blue line from the boat's current (live-estimated)
     position to the destination marker, with a small label showing
     the distance in nautical miles — updates whenever the boat
     moves or a new destination is picked.
     --------------------------------------------------------------- */
  function drawCourseLine(destLat, destLon) {
    if (!map || !OS.boat) return;
    clearCourseLine();

    const boatPos = { lat: OS.boat.lat, lon: OS.boat.lon };
    const nm = OS.haversineNm(boatPos.lat, boatPos.lon, destLat, destLon);

    courseLine = L.polyline(
      [[boatPos.lat, boatPos.lon], [destLat, destLon]],
      { color: "#4fc3f7", weight: 2, opacity: 0.85, dashArray: "4,5" }
    ).addTo(map);

    const midLat = (boatPos.lat + destLat) / 2;
    const midLon = (boatPos.lon + destLon) / 2;
    courseDistanceLabel = L.marker([midLat, midLon], {
      icon: L.divIcon({
        className: "osCourseDistanceLabel",
        html: `${nm.toFixed(1)} nm`,
        iconSize: [60, 18],
        iconAnchor: [30, 9]
      }),
      interactive: false
    }).addTo(map);
  }

  function clearCourseLine() {
    if (courseLine) { map.removeLayer(courseLine); courseLine = null; }
    if (courseDistanceLabel) { map.removeLayer(courseDistanceLabel); courseDistanceLabel = null; }
  }

  /* ---------------------------------------------------------------
     TRACK LINE
     Records a breadcrumb trail of where the boat has been.
     Points are sampled from the server-confirmed position (not
     the client-interpolated one) so the track reflects actual
     ticks, not animation frames. A new point is only stored when
     the boat has moved at least MIN_TRACK_NM from the last one.
     Stored in localStorage per-boat so it survives page reloads.
     --------------------------------------------------------------- */
  const MIN_TRACK_NM = 1;
  let trackLine = null;      /* Leaflet polyline */
  let trackVisible = true;

  function trackKey() {
    return OS.boat ? "osTrack_" + OS.boat.id : null;
  }

  function loadTrackPoints() {
    const key = trackKey();
    if (!key) return [];
    try { return JSON.parse(localStorage.getItem(key) || "[]"); }
    catch (e) { return []; }
  }

  function saveTrackPoints(pts) {
    const key = trackKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(pts));
  }

  function maybeRecordTrackPoint(lat, lon) {
    const pts = loadTrackPoints();
    if (pts.length > 0) {
      const last = pts[pts.length - 1];
      const dist = OS.haversineNm(last[0], last[1], lat, lon);
      if (dist < MIN_TRACK_NM) return; /* hasn't moved far enough */
    }
    pts.push([lat, lon]);
    saveTrackPoints(pts);
    renderTrackLine(pts);
  }

  function renderTrackLine(pts) {
    if (!map) return;
    if (trackLine) { map.removeLayer(trackLine); trackLine = null; }
    if (pts.length < 2 || !trackVisible) return;
    trackLine = L.polyline(pts, {
      color: "#e53935",
      weight: 2.5,
      opacity: 0.75,
      lineJoin: "round"
    }).addTo(map);
  }

  function initTrack() {
    const pts = loadTrackPoints();
    if (pts.length > 0) renderTrackLine(pts);

    /* Record the boat's current confirmed position immediately,
       then again whenever the server state refreshes (every 30s) */
    if (OS.boat) maybeRecordTrackPoint(OS.boat.lat, OS.boat.lon);

    const toggleBtn = document.getElementById("osTrackToggleBtn");
    const toggleLabel = document.getElementById("osTrackToggleLabel");
    const clearBtn = document.getElementById("osClearTrackBtn");

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        trackVisible = !trackVisible;
        toggleLabel.textContent = trackVisible ? "Hide Track" : "Show Track";
        toggleBtn.classList.toggle("active", trackVisible);
        const pts = loadTrackPoints();
        renderTrackLine(pts);
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        if (!confirm("Clear your entire track history?")) return;
        saveTrackPoints([]);
        if (trackLine) { map.removeLayer(trackLine); trackLine = null; }
      });
    }
  }

  function updateBoatMarkerPosition(boat) {
    if (!boatMarker) return;
    boatMarker.setLatLng([boat.lat, boat.lon]);
    refreshBoatIcon();

    /* Keep the course line current as the boat moves */
    const destLat = pendingDest ? pendingDest.lat : boat.destination_lat;
    const destLon = pendingDest ? pendingDest.lon : boat.destination_lon;
    if (destLat != null && destLon != null && (boat.sailing_active || boat.engine_on)) {
      drawCourseLine(destLat, destLon);
    } else {
      clearCourseLine();
    }
  }

  /* ---------------------------------------------------------------
     RESOURCE GAUGES (water/fuel/food/hull) — feeds the instrument
     panel's percent-ring gauges instead of the old fill bars.
     --------------------------------------------------------------- */
  function renderResourceBar(boat) {
    if (!boat || typeof window.OSInstruments === "undefined") return;
    window.OSInstruments.setPercentGauge("food", boat.food);
    window.OSInstruments.setPercentGauge("water", boat.water);
    window.OSInstruments.setPercentGauge("fuel", boat.fuel);
    window.OSInstruments.setPercentGauge("hull", boat.hull_health);
  }

  /* ---------------------------------------------------------------
     STATUS LINE
     --------------------------------------------------------------- */
  function renderStatusLine(boat) {
    const el = document.getElementById("osStatusLine");
    if (!boat) return;

    const parts = [];
    if (boat.sailing_active) parts.push("⛵ Sailing");
    if (boat.engine_on) parts.push(`🛥 Engine ${Math.round(boat.throttle_rpm || 800)} RPM`);
    if (!boat.sailing_active && !boat.engine_on) parts.push("⚓ Idle — set sails or start the engine");

    if (boat.destination_lat != null) {
      const dist = OS.haversineNm(boat.lat, boat.lon, boat.destination_lat, boat.destination_lon);
      parts.push(`${dist.toFixed(1)} nm to destination`);
    }

    el.textContent = parts.join(" · ");
  }

  /* ---------------------------------------------------------------
     CONTROLS
     --------------------------------------------------------------- */
  function wireControls() {
    /* Tab switching is now handled by tabsystem.js (the dynamic
       two-level tab system) — see oregon-sail/tabsystem.js. That
       module calls window.OSGameUI.onChartPlotterShown() whenever
       the chart plotter widget becomes visible, which is where the
       map.invalidateSize() call below now lives instead. */

    document.getElementById("osSetCourseBtn").addEventListener("click", async () => {
      if (!pendingDest) return;
      const { error } = await OS.setCourse(pendingDest.lat, pendingDest.lon, "sailing");
      if (!error) {
        showPendingPin(pendingDest.lat, pendingDest.lon, false);
        renderStatusLine(OS.boat);
        refreshBoatIcon();
        document.getElementById("osSetCourseBtn").style.display = "none";
        document.getElementById("osCancelCourseBtn").style.display = "none";
      }
      pendingDest = null;
    });

    document.getElementById("osCancelCourseBtn").addEventListener("click", () => {
      pendingDest = null;
      if (pendingPinMarker) {
        map.removeLayer(pendingPinMarker);
        pendingPinMarker = null;
      }
      clearCourseLine();
      /* Restore the existing confirmed course's pin/line, if any */
      if (OS.boat && OS.boat.destination_lat != null) {
        showPendingPin(OS.boat.destination_lat, OS.boat.destination_lon, false);
        drawCourseLine(OS.boat.destination_lat, OS.boat.destination_lon);
      }
      document.getElementById("osSetCourseBtn").style.display = "none";
      document.getElementById("osCancelCourseBtn").style.display = "none";
    });

    document.getElementById("osCenterBtn").addEventListener("click", () => {
      if (!map || !OS.boat) return;
      map.setView([OS.boat.lat, OS.boat.lon], map.getZoom(), { animate: true });
    });

    /* The gauges (boom slider, engine controls, wheel, sails toggle)
       live inside the instrument panel, which instruments.js builds
       on its own async DOMContentLoaded + retry timer — not
       coordinated with this function's call timing. Wiring them here
       directly can run before that DOM exists, so retry until it does
       rather than silently failing. */
    wireGaugeDependentControls();
    wireLightPanel();
  }

  /* ---------------------------------------------------------------
     DC LIGHTING PANEL
     A widget the player can place on any Nav Station sub-tab (per
     the tab system) with 5 toggle switches: Anchor, Nav Lights,
     Steaming, Deck, Cockpit. Each one persists to a light_<key>
     column and immediately turns the corresponding 3D light on/off
     in the Helm view, regardless of which tab is currently active.
     Retries like the gauge wiring above, since this widget can be
     freely added/removed by the player and may not exist in the DOM
     yet (or ever, if they've removed it) when this first runs.
     --------------------------------------------------------------- */
  function wireLightPanel(attemptsLeft) {
    const panel = document.getElementById("osLightPanel");
    if (!panel) {
      if (attemptsLeft == null) attemptsLeft = 20;
      if (attemptsLeft > 0) setTimeout(() => wireLightPanel(attemptsLeft - 1), 300);
      return;
    }
    if (panel.dataset.wired === "1") return; /* already wired, e.g. after a tab switch re-render */
    panel.dataset.wired = "1";

    const LIGHT_KEYS = ["anchor", "nav", "steaming", "deck", "cockpit"];
    LIGHT_KEYS.forEach(key => {
      const btn = panel.querySelector(`.osLightSwitch[data-light="${key}"]`);
      if (!btn) return;
      const isOn = !!(OS.boat && OS.boat["light_" + key]);
      updateLightSwitchUI(btn, isOn);

      btn.addEventListener("click", async () => {
        if (!OS.boat) return;
        const newState = !OS.boat["light_" + key];
        await OS.setLight(key, newState);
        updateLightSwitchUI(btn, newState);
        if (typeof window.OSHelm3D !== "undefined" && window.OSHelm3D.setLightState) {
          window.OSHelm3D.setLightState(key, newState);
        }
      });
    });
  }

  function updateLightSwitchUI(btn, isOn) {
    btn.textContent = isOn ? "ON" : "OFF";
    btn.classList.toggle("on", isOn);
  }

  function wireGaugeDependentControls(attemptsLeft) {
    const boomSlider = document.getElementById("osBoomSlider");
    const sailsToggle = document.getElementById("osSailsToggle");
    const wheelFace = document.getElementById("osWheelFace");
    const engineToggle = document.getElementById("osEngineToggle");
    const jibSlider = document.getElementById("osJibFurlSlider");
    const spinnakerSlider = document.getElementById("osSpinnakerSlider");

    if (!boomSlider || !sailsToggle || !wheelFace || !engineToggle || !jibSlider || !spinnakerSlider) {
      if (attemptsLeft == null) attemptsLeft = 20;
      if (attemptsLeft > 0) setTimeout(() => wireGaugeDependentControls(attemptsLeft - 1), 200);
      return;
    }

    boomSlider.value = currentBoomAngle;
    boomSlider.addEventListener("input", () => {
      currentBoomAngle = parseInt(boomSlider.value, 10);
      refreshBoatIcon(); /* live preview while dragging */
      if (window.OSInstruments) window.OSInstruments.setBoomLabel(currentBoomAngle);
    });
    boomSlider.addEventListener("change", async () => {
      saveBoomAngle(currentBoomAngle);
      await OS.setBoomAngle(currentBoomAngle);
    });

    wireEngineControls();
    wireWheelControls();

    const isUp = !!(OS.boat && OS.boat.sailing_active);
    if (window.OSInstruments) window.OSInstruments.setSailsState(isUp);
    sailsToggle.addEventListener("click", async () => {
      const newState = !(OS.boat && OS.boat.sailing_active);
      await OS.setSailingActive(newState);
      if (window.OSInstruments) window.OSInstruments.setSailsState(newState);
      renderStatusLine(OS.boat);
    });

    /* Main reef buttons — 3 discrete states (full / reef 1 / reef 2) */
    if (window.OSInstruments) window.OSInstruments.setReefButtons(OS.boat ? (OS.boat.reef_level || 0) : 0);
    document.querySelectorAll(".osReefBtn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const level = parseInt(btn.dataset.reef, 10);
        await OS.setReefLevel(level);
        if (window.OSInstruments) window.OSInstruments.setReefButtons(level);
        updateSailAreaReadout();
      });
    });

    /* Jib furl — continuous scroll/slider, 0 (furled) to 100 (full out) */
    jibSlider.value = OS.boat ? (OS.boat.jib_furl_pct != null ? OS.boat.jib_furl_pct : 100) : 100;
    if (window.OSInstruments) window.OSInstruments.setJibFurlLabel(parseFloat(jibSlider.value));
    jibSlider.addEventListener("input", () => {
      const pct = parseFloat(jibSlider.value);
      if (OS.boat) OS.boat.jib_furl_pct = pct; /* live in-memory, smooth dragging */
      if (window.OSInstruments) window.OSInstruments.setJibFurlLabel(pct);
      updateSailAreaReadout();
    });
    jibSlider.addEventListener("change", async () => {
      await OS.setJibFurl(parseFloat(jibSlider.value));
    });

    /* Spinnaker furl — same continuous pattern as the jib, but only
       actually contributes speed downwind (Broad Reach/Running) */
    spinnakerSlider.value = OS.boat ? (OS.boat.spinnaker_furl_pct || 0) : 0;
    if (window.OSInstruments) window.OSInstruments.setSpinnakerLabel(parseFloat(spinnakerSlider.value));
    spinnakerSlider.addEventListener("input", () => {
      const pct = parseFloat(spinnakerSlider.value);
      if (OS.boat) OS.boat.spinnaker_furl_pct = pct; /* live in-memory, smooth dragging */
      if (window.OSInstruments) window.OSInstruments.setSpinnakerLabel(pct);
      updateSailAreaReadout();
    });
    spinnakerSlider.addEventListener("change", async () => {
      await OS.setSpinnakerFurl(parseFloat(spinnakerSlider.value));
    });

    updateSailAreaReadout();
  }

  /* Shows how much sail area is actually exposed right now (main
     reef factor + jib furl + spinnaker when downwind) against the
     boat's full area — this is the same ratio the speed formula
     uses, made visible so the player can see why reefing/furling
     slows them down. */
  function updateSailAreaReadout() {
    if (!OS.boat || typeof window.OSInstruments === "undefined") return;
    const mainArea = OS.boat.main_sail_area_sqft ?? 245;
    const jibArea = OS.boat.jib_sail_area_sqft ?? 105;
    const spinnakerArea = OS.boat.spinnaker_sail_area_sqft ?? 0;
    const totalArea = mainArea + jibArea + spinnakerArea;
    const reefPenalties = OS.boat.reef_speed_penalty ?? [1.0, 0.85, 0.65];
    const mainFactor = reefPenalties[OS.boat.reef_level || 0] ?? 1.0;
    const jibFactor = Math.max(0, Math.min(100, OS.boat.jib_furl_pct ?? 100)) / 100;
    const spinnakerFactor = Math.max(0, Math.min(100, OS.boat.spinnaker_furl_pct ?? 0)) / 100;

    const heading = OS.boat.course_bearing ?? 0;
    const windDeg = typeof window.getLastWindDeg === "function" ? window.getLastWindDeg() : 0;
    const pos = calculatePointOfSail(heading, windDeg);
    const isDownwind = pos.name === "Broad Reach" || pos.name === "Running";

    const exposed = mainArea * mainFactor + jibArea * jibFactor + (isDownwind ? spinnakerArea * spinnakerFactor : 0);
    window.OSInstruments.setSailAreaReadout(exposed, totalArea);
    if (window.OSInstruments.setSpinnakerHint) {
      window.OSInstruments.setSpinnakerHint(isDownwind, OS.boat.spinnaker_furl_pct ?? 0);
    }
  }

  /* ---------------------------------------------------------------
     WHEEL / RUDDER CONTROLS
     Dragging the wheel left/right sets rudder_angle directly and
     disengages autopilot (grabbing the helm takes manual control).
     Tapping the AUTO badge re-engages autopilot, steering back
     toward the destination instead of following the rudder.
     --------------------------------------------------------------- */
  function wireWheelControls() {
    const face = document.getElementById("osWheelFace");
    const manualBtn = document.getElementById("osManualBtn");
    const autoBtn = document.getElementById("osAutoBtn");
    if (!face) return; /* caller (wireGaugeDependentControls) already confirmed it exists */

    if (window.OSInstruments) {
      window.OSInstruments.setWheelState(OS.boat ? OS.boat.rudder_angle || 0 : 0, OS.boat ? OS.boat.autopilot_on : true);
    }

    let dragging = false;
    let startX = 0;
    let startRudder = 0;

    function getX(e) {
      return e.touches ? e.touches[0].clientX : e.clientX;
    }

    function onDown(e) {
      e.preventDefault();
      dragging = true;
      startX = getX(e);
      startRudder = (OS.boat && OS.boat.rudder_angle) || 0;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
    }

    function onMove(e) {
      if (!dragging || !OS.boat) return;
      e.preventDefault();
      const dx = getX(e) - startX;
      /* ~2px of drag per degree of rudder, clamped to -45..45 */
      const newRudder = Math.max(-45, Math.min(45, startRudder + dx / 2));
      OS.boat.rudder_angle = newRudder;
      OS.boat.autopilot_on = false; /* grabbing the wheel takes manual control */
      if (window.OSInstruments) window.OSInstruments.setWheelState(newRudder, false);
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
      if (OS.boat) {
        OS.setAutopilot(false); /* persist the disengage; rudder angle syncs on the 10-min timer */
      }
    }

    face.addEventListener("mousedown", onDown);
    face.addEventListener("touchstart", onDown, { passive: false });

    if (manualBtn) {
      manualBtn.addEventListener("click", async () => {
        if (!OS.boat) return;
        await OS.setAutopilot(false);
        if (window.OSInstruments) window.OSInstruments.setWheelState(OS.boat.rudder_angle || 0, false);
      });
    }

    if (autoBtn) {
      autoBtn.addEventListener("click", async () => {
        if (!OS.boat) return;
        await OS.setAutopilot(true);
        OS.boat.rudder_angle = 0;
        if (window.OSInstruments) window.OSInstruments.setWheelState(0, true);
      });
    }
  }

  /* ---------------------------------------------------------------
     ENGINE CONTROLS
     RPM range 800 (idle) – 3200 (max), independent of sailing.
     Throttle slider is -1..1: negative = reverse, 0 = idle/neutral
     forward boundary, positive = forward throttle up to max RPM.
     --------------------------------------------------------------- */
  function rpmFromThrottleValue(val) {
    /* val 0..1 maps idle(800)..max(3200) for forward;
       val -1..0 maps idle(800)..max(3200) for reverse (same RPM range,
       direction comes from engine_gear, not RPM sign) */
    const mag = Math.abs(val);
    return 800 + mag * (3200 - 800);
  }

  function wireEngineControls() {
    const toggle = document.getElementById("osEngineToggle");
    const throttle = document.getElementById("osThrottleSlider");
    if (!toggle || !throttle) return;

    let engineOn = !!(OS.boat && OS.boat.engine_on);
    if (window.OSInstruments) window.OSInstruments.setEngineState(engineOn, OS.boat?.throttle_rpm || 800);
    throttle.disabled = !engineOn;

    toggle.addEventListener("click", async () => {
      engineOn = !engineOn;
      const gear = engineOn ? "forward" : "neutral";
      const rpm = engineOn ? 800 : 800;
      await OS.setEngine(engineOn, rpm, gear);
      throttle.value = 0;
      throttle.disabled = !engineOn;
      if (window.OSInstruments) window.OSInstruments.setEngineState(engineOn, rpm);
      renderStatusLine(OS.boat);
    });

    throttle.addEventListener("input", () => {
      if (!engineOn) return;
      const val = parseFloat(throttle.value);
      const rpm = rpmFromThrottleValue(val);
      if (window.OSInstruments) window.OSInstruments.setEngineState(true, rpm);
    });

    throttle.addEventListener("change", async () => {
      if (!engineOn) return;
      const val = parseFloat(throttle.value);
      const rpm = rpmFromThrottleValue(val);
      const gear = val < -0.02 ? "reverse" : val > 0.02 ? "forward" : "neutral";
      await OS.setEngine(true, rpm, gear);
    });
  }

  /* ---------------------------------------------------------------
     BOOT — wait for the game widget to exist in the DOM, then init.
     The dashboard builds widgets dynamically, so we poll briefly.
     --------------------------------------------------------------- */
  function waitForGameWidget(attempts) {
    const mapEl = document.getElementById("osMap");
    if (mapEl) {
      initOregonSail();
      return;
    }
    if (attempts > 0) {
      setTimeout(() => waitForGameWidget(attempts - 1), 300);
    }
  }

  document.addEventListener("DOMContentLoaded", () => waitForGameWidget(20));

  /* Public hook for tabsystem.js — called whenever the chart plotter
     widget is moved into a now-visible sub-tab, since Leaflet renders
     incorrectly if sized while its container was display:none. */
  window.OSGameUI = {
    onChartPlotterShown: () => {
      if (map) setTimeout(() => map.invalidateSize(), 50);
    }
  };
})();
