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

    const boatIcon = L.divIcon({
      className: "osBoatIcon",
      html: "⛵",
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    boatMarker = L.marker([boat.lat, boat.lon], { icon: boatIcon }).addTo(map);

    if (boat.destination_lat != null) {
      showPendingPin(boat.destination_lat, boat.destination_lon, false);
    }

    map.on("click", (e) => {
      handleMapTap(e.latlng.lat, e.latlng.lng);
    });
  }

  function handleMapTap(lat, lon) {
    pendingDest = { lat, lon };
    showPendingPin(lat, lon, true);

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
      html: "📍",
      iconSize: [24, 24],
      iconAnchor: [12, 24]
    });
    pendingPinMarker = L.marker([lat, lon], { icon }).addTo(map);
  }

  function updateBoatMarkerPosition(boat) {
    if (!boatMarker) return;
    const estimated = OS.estimateLiveLatLon(boat, 4.5);
    boatMarker.setLatLng([estimated.lat, estimated.lon]);
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
