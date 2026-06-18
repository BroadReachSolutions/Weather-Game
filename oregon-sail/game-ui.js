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
    const estimated = OS.estimateLiveLatLon(boat, 4.5);

    if (!force && lastSyncedLat != null) {
      const movedNm = OS.haversineNm(lastSyncedLat, lastSyncedLon, estimated.lat, estimated.lon);
      if (movedNm < MIN_SYNC_DISTANCE_NM) return; /* hasn't moved far enough to matter */
    }

    lastSyncedLat = estimated.lat;
    lastSyncedLon = estimated.lon;

    /* script.js declares userLat/userLon/marineLocationLat/marineLocationLon
       with `let` at top-level script scope, which does NOT create real
       window properties — so we can't just assign window.userLat = x and
       expect script.js's own functions to see it. script.js exposes a
       real setter (window.setLocationFromBoat) that updates its actual
       lexical variables from inside its own scope. */
    if (typeof window.setLocationFromBoat === "function") {
      window.setLocationFromBoat(estimated.lat, estimated.lon);
    } else {
      console.warn("Oregon Sail: setLocationFromBoat not found — is script.js loaded before game-ui.js?");
    }

    if (typeof window.fetchAllNoaaStations === "function" && !window.allNoaaStations) {
      window.allNoaaStations = await window.fetchAllNoaaStations();
    }
    if (typeof window.updateNearbyStations === "function") {
      await window.updateNearbyStations(estimated.lat, estimated.lon);
    } else if (typeof window.refreshAll === "function") {
      await window.refreshAll();
    }
  }

  /* ---------------------------------------------------------------
     INIT
     --------------------------------------------------------------- */
  async function initOregonSail() {
    const statusLine = document.getElementById("osStatusLine");
    statusLine.textContent = "Loading your vessel…";

    const boat = await OS.loadOrCreateBoat();
    if (!boat) {
      statusLine.textContent = "Couldn't connect — check your connection and reload.";
      return;
    }

    await syncLocationToBoat(boat, true); /* force initial sync regardless of distance */

    initMap(boat);
    renderResourceBar(boat);
    renderStatusLine(boat);
    wireControls();
    if (typeof updateRadarCenterBtnVisibility === "function") updateRadarCenterBtnVisibility();

    /* Smoothly re-render position + status every few seconds using
       client-side interpolation between server ticks */
    liveUpdateInterval = setInterval(() => {
      if (!OS.boat) return;
      updateBoatMarkerPosition(OS.boat);
    }, 4000);

    /* Pull the true server state periodically in case another
       device/tab or the backend tick changed it, and keep the
       dashboard's weather/tide/station data following the boat */
    setInterval(async () => {
      await OS.refreshBoat();
      renderResourceBar(OS.boat);
      renderStatusLine(OS.boat);
      updateBoatMarkerPosition(OS.boat);
      await syncLocationToBoat(OS.boat, false);
    }, 30000);
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
      if (boat.course_mode !== "idle") drawCourseLine(boat.destination_lat, boat.destination_lon);
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

    const boatPos = OS.estimateLiveLatLon(OS.boat, 4.5);
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

  function updateBoatMarkerPosition(boat) {
    if (!boatMarker) return;
    const estimated = OS.estimateLiveLatLon(boat, 4.5);
    boatMarker.setLatLng([estimated.lat, estimated.lon]);
    refreshBoatIcon();

    /* Keep the course line current as the boat moves — covers both
       an unconfirmed pending pick and an already-set destination */
    const destLat = pendingDest ? pendingDest.lat : boat.destination_lat;
    const destLon = pendingDest ? pendingDest.lon : boat.destination_lon;
    if (destLat != null && destLon != null && boat.course_mode !== "idle") {
      drawCourseLine(destLat, destLon);
    } else {
      clearCourseLine();
    }
  }

  /* ---------------------------------------------------------------
     RESOURCE BAR
     --------------------------------------------------------------- */
  function renderResourceBar(boat) {
    if (!boat) return;
    setFill("osFoodFill", boat.food);
    setFill("osWaterFill", boat.water);
    setFill("osFuelFill", boat.fuel);
    setFill("osHullFill", boat.hull_health);
    document.getElementById("osMoney").textContent = "$" + Math.round(boat.money);
  }

  function setFill(id, pct) {
    const el = document.getElementById(id);
    if (!el) return;
    const clamped = Math.max(0, Math.min(100, pct));
    el.style.width = clamped + "%";
    el.classList.toggle("osLow", clamped <= 20);
  }

  /* ---------------------------------------------------------------
     STATUS LINE
     --------------------------------------------------------------- */
  function renderStatusLine(boat) {
    const el = document.getElementById("osStatusLine");
    if (!boat) return;

    const modeLabels = {
      idle: "Anchored at port — set a course to begin",
      sailing: "⛵ Sailing toward destination",
      motoring: "🛥 Motoring toward destination",
      anchored: "⚓ Anchored"
    };

    el.textContent = modeLabels[boat.course_mode] || boat.course_mode;

    const controls = document.getElementById("osCourseControls");
    controls.style.display = (boat.course_mode === "idle") ? "none" : "flex";

    const trimPanel = document.getElementById("osSailTrimPanel");
    if (trimPanel) trimPanel.style.display = (boat.course_mode === "sailing") ? "block" : "none";

    document.querySelectorAll(".osModeBtn[data-mode]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.mode === boat.course_mode);
    });
  }

  /* ---------------------------------------------------------------
     CONTROLS
     --------------------------------------------------------------- */
  function wireControls() {
    document.getElementById("osSetCourseBtn").addEventListener("click", async () => {
      if (!pendingDest) return;
      const mode = document.querySelector(".osModeBtn[data-mode].active")?.dataset.mode || "sailing";
      const { error } = await OS.setCourse(pendingDest.lat, pendingDest.lon, mode);
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
      if (OS.boat && OS.boat.destination_lat != null && OS.boat.course_mode !== "idle") {
        showPendingPin(OS.boat.destination_lat, OS.boat.destination_lon, false);
        drawCourseLine(OS.boat.destination_lat, OS.boat.destination_lon);
      }
      document.getElementById("osSetCourseBtn").style.display = "none";
      document.getElementById("osCancelCourseBtn").style.display = "none";
    });

    document.getElementById("osModeSail").addEventListener("click", () => switchMode("sailing"));
    document.getElementById("osModeMotor").addEventListener("click", () => switchMode("motoring"));
    document.getElementById("osModeAnchor").addEventListener("click", async () => {
      await OS.dropAnchor();
      renderStatusLine(OS.boat);
    });

    document.getElementById("osCenterBtn").addEventListener("click", () => {
      if (!map || !OS.boat) return;
      const estimated = OS.estimateLiveLatLon(OS.boat, 4.5);
      map.setView([estimated.lat, estimated.lon], map.getZoom(), { animate: true });
    });

    const boomSlider = document.getElementById("osBoomSlider");
    if (boomSlider) {
      boomSlider.value = currentBoomAngle;
      boomSlider.addEventListener("input", () => {
        currentBoomAngle = parseInt(boomSlider.value, 10);
        refreshBoatIcon(); /* live preview while dragging */
      });
      boomSlider.addEventListener("change", () => {
        saveBoomAngle(currentBoomAngle);
      });
    }
  }

  async function switchMode(mode) {
    if (!OS.boat || OS.boat.destination_lat == null) return;
    await OS.setCourse(OS.boat.destination_lat, OS.boat.destination_lon, mode);
    renderStatusLine(OS.boat);
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
})();
