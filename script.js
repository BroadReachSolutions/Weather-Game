/* ==========================================================================
   Marine Dashboard - Enhanced Script
   Full replacement for script.js
   ========================================================================== */

const DASHBOARD_WIDTH = 1920;
const MOBILE_DASHBOARD_WIDTH = 400; /* close to real phone width so scale ≈ 1, text renders near its literal size */

/* Default layout for the mobile canvas (400px virtual width).
   This is the user's custom-tuned layout, captured from their live
   localStorage settings and baked in as the new default. */
const DEFAULT_MOBILE_LAYOUT = {
  "layout":     { "left": "0px",  "top": "1170px", "width": "390px", "height": "130px" },
  "wind":       { "left": "5px",  "top": "390px",  "width": "390px", "height": "340px" },
  "forecast":   { "left": "5px",  "top": "735px",  "width": "390px", "height": "195px" },
  "tideChart":  { "left": "-5px", "top": "940px",  "width": "395px", "height": "210px" },
  "game":       { "left": "0px",  "top": "0px",    "width": "395px", "height": "380px" }
};
const DASHBOARD_HEIGHT = 1080;

/* storage keys */
const STORAGE_KEY = "marineDashboardLayoutV2";
const MOBILE_STORAGE_KEY = STORAGE_KEY + "_mobile_v2";

const DEFAULT_MOBILE_SIZES = {
  forecast:  { h: "203px" },
  wind:      { h: "270px" },
  tideChart: { h: "225px" }
};
const NOAA_PROXY = "https://noaa-proxy.lanceburkin.workers.dev";
const SETTINGS_KEY = "marineDashboardWidgetSettingsV2";

const DEFAULT_LAYOUT = {"layout":{"left":"10px","top":"10px","width":"620px","height":"120px"},"wind":{"left":"1254px","top":"5px","width":"653px","height":"392px"},"temp":{"left":"758px","top":"11px","width":"313px","height":"112px"},"tideStatus":{"left":"433px","top":"316px","width":"981px","height":"91px"},"forecast":{"left":"10px","top":"391px","width":"1900px","height":"270px"},"tideChart":{"left":"-8px","top":"661px","width":"1919px","height":"278px"}};

const DEFAULT_SETTINGS = {"widgetSettings":{"layout":{},"wind":{"theme":"clean"},"temp":{"theme":"clean"},"tideStatus":{"theme":"clean"},"forecast":{"theme":"clean"},"tideChart":{"theme":"clean"},"game":{}},"dashboardSettings":{"backgroundColor":"#07131c","backgroundHue":0},"heroTitle":"","heroSubtitle":""};


/* location defaults */
let userLat = 29.938;
let userLon = -81.302;

/* marine location for satellite compass */
let marineLocationLat = null;
let marineLocationLon = null;
let compassZoom = parseInt(localStorage.getItem("compassZoom") || "6");
let compassMapMode = "radar";
let compassSize = 190;
let compassStyle = "none";

/* ---------------------------------------------------------------
   Oregon Sail integration hook.
   `let` variables at top-level script scope do NOT become window
   properties, so external scripts (game-ui.js) can't just assign
   window.userLat = x and expect loadWeather()/updateNearbyStations()
   to see it — those functions close over the real lexical bindings
   above. This setter runs *inside* this script's scope so it
   actually updates the variables those functions read.
   --------------------------------------------------------------- */
window.setLocationFromBoat = function (lat, lon) {
  userLat = lat;
  userLon = lon;
  marineLocationLat = null;
  marineLocationLon = null;
};

/* Same window-binding problem as above — lastWindDeg/lastWindMph are
   `let` at top level, so external scripts need a real getter rather
   than reading window.lastWindDeg directly (which would be undefined). */
window.getLastWindDeg = function () { return lastWindDeg; };
window.getLastWindMph = function () { return lastWindMph; };
let cardinalOffset = 20;
let showWindMph = true;
let showWindKph = false;
let showWindKnots = false;
let showWindDir = true;
let lastWindMph = 0;
let lastWindDeg = 0;
let windTopOffset = 0;
let windBotOffset = 0;

/* ---- Radar ---- */
let radarFrames     = [];
let radarFrameIdx   = 0;
let radarAnimTimer  = null;
let radarSpeed      = parseInt(localStorage.getItem("radarSpeed") || "5");
const _radarImgCache = {};

/* NOAA full station list cache */
let allNoaaStations = null;

/* stations — fallback used only if NOAA station API fails */
const LOCAL_STATIONS = [
  { id: "8720554", name: "Vilano Beach ICWW", state: "FL", lat: 29.938, lon: -81.302 },
  { id: "8720576", name: "St. Augustine", state: "FL", lat: 29.894, lon: -81.313 },
  { id: "8720587", name: "St. Augustine Beach", state: "FL", lat: 29.857, lon: -81.264 },
  { id: "8720582", name: "State Road 312, Matanzas River", state: "FL", lat: 29.876, lon: -81.294 }
];

const DEFAULT_STATION = LOCAL_STATIONS[0];
let selectedStation = DEFAULT_STATION;
let nearbyStations = [...LOCAL_STATIONS];
const WEATHER_HOURS = 12;

/* ---- Mobile detection ---- */
/* isMobile: matches the CSS @media query exactly */
function isMobile() {
  return window.matchMedia("(max-width: 767px), (max-width: 1400px) and (pointer: coarse)").matches;
}

/* Forecast: show 3 cards on mobile (draggable), 12 on desktop */
function getForecastVisibleHours() {
  return isMobile() ? 3 : WEATHER_HOURS;
}

/* Tide chart: show 3-hour window on mobile (draggable), full 24h on desktop */
function getTideVisibleHours() {
  return isMobile() ? 3 : 24;
}

let forecastDragOffset    = 0;   /* hour offset for mobile forecast drag */
let forecastDragStartX    = null;
let forecastDragStartOffset = null;
let tideViewOffsetMs      = 0;   /* ms offset for mobile tide drag */

const TIDE_WINDOW_HOURS = 24;
const LIVE_LINE_OFFSET_MINUTES = 30;
/* Alert thresholds — now user-configurable, these are defaults */
let LOW_TIDE_ALERT_FT  = 0.4;
let HIGH_TIDE_ALERT_FT = 5.0;
let WIND_ALERT_MPH     = 25;
let HEAT_ALERT_F       = 95;
let COLD_ALERT_F       = 40;

/* Feature flags */
let tempShowTemp         = true;
let tempShowHumidity     = true;
let tempShowCelsius      = false;
let tempHeatAlertOn      = true;
let tempColdAlertOn      = false;

let fcShowTemp           = true;
let fcShowHumidity       = true;
let fcShowRain           = true;
let fcShowWind           = true;
let fcShowCondition      = true;
let fcHeatAlertOn        = true;
let fcColdAlertOn        = false;
let fcColdAlertVal       = 40;
let fcRainAlertOn        = true;
let fcRainAlertVal       = 70;
let fcWindAlertOn        = true;

let tideStatusColorAlert = true;
let tideChartLowAlertOn  = true;
let tideChartHighAlertOn = false;

let tidePredictions = [];
let layoutEditMode = false;
let snapEnabled = true; /* widgets snap to grid + to each other's edges while editing layout */

let tideViewMode = "live";
let selectedTideDate = null;

let tideScrubTimeMs = null;
let tideDragging = false;

let weatherViewMode = "hourly";

/* widget settings state */
let widgetSettings = {};
let dashboardSettings = {
  backgroundColor: "#07131c",
  backgroundHue: 0
};

/* Visit ?reset to wipe all stored layout/settings data */
if (window.location.search.includes("reset")) {
  localStorage.clear();
  window.location.href = window.location.pathname;
}

init();

/* ==========================================================================
   INIT
   ========================================================================== */
async function init() {
  setupDashboardScale();
  setupLayoutEditor();
  setupDateControls();
  setupTideInteraction();
  setupWidgetSettingsSystem();

  updateClockAndDate();
  attachEvents();
  populateStationDropdown();
  initializeDatePicker();

  loadAllSettings();
  loadNewWidgetSettings();
  applyAllWidgetSettings();

  attachCompassSettingsEvents();
  makeSettingsPanelsDraggable();

  /* Apply mobile overrides BEFORE first data load so layout is correct */
  if (isMobile()) {
    applyMobileWidgetOverrides();
  }

  /* Resize listener to re-apply on orientation change */
  window.addEventListener("resize", () => {
    if (isMobile() && !document.body.classList.contains("is-mobile")) {
      applyMobileWidgetOverrides();
    }
  });

  /* Load location first so weather/tide fetch uses correct coords */
  await loadMarineLocation();
  if (!marineLocationLat || !marineLocationLon) {
    await getLocation();
  }

  /* Now fetch all data — awaited so widgets populate before user sees them */
  await refreshAll();
  /* Force forecast to re-render after initial load (clears stale cache key) */
  const fcWrap = document.getElementById("forecast");
  if (fcWrap) fcWrap.dataset.renderedKey = "";
  renderWeather(null);

  setInterval(updateClockAndDate, 1000);

  setInterval(() => {
    loadWeather();
    if (tideViewMode === "live") loadTides();
  }, 60000);

  /* orientation change handler */
  window.addEventListener("orientationchange", () => {
    setTimeout(() => {
      if (isMobile()) applyMobileWidgetOverrides();
    }, 300);
  });


}

/* Hide widgets that clutter the mobile view.
   Uses a CSS class so we never touch localStorage settings. */
function applyMobileWidgetOverrides() {
  document.body.classList.add("is-mobile");

  ["clockWidget", "dividerWidget", "logoWidget", "heroTextWidget"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add("mobile-hidden");
  });

  /* The fixed top header bar (temp/humidity readout + Edit button)
     has been removed to reclaim vertical space for the game widget.
     The Edit button now lives in the game widget's own top-right
     corner instead — see #osGameEditBtn in index.html, wired below. */
  const gameEditBtn = document.getElementById("osGameEditBtn");
  const desktopToggle = document.getElementById("layoutToggle");
  if (gameEditBtn && desktopToggle) {
    gameEditBtn.addEventListener("click", () => desktopToggle.click());
  }
}

function removeMobileWidgetOverrides() {
  document.body.classList.remove("is-mobile");
  ["clockWidget", "dividerWidget", "logoWidget", "heroTextWidget"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("mobile-hidden");
  });
}

/* ==========================================================================
   SCALE
   This build always uses the free-form absolute-position canvas that
   scales as a whole — same system on mobile and desktop, just a
   different virtual canvas width. This keeps drag/resize behavior
   identical everywhere.
   ========================================================================== */
function setupDashboardScale() {
  const stage = document.getElementById("dashboardStage");
  const dashboard = document.getElementById("dashboard");

  function applyScale() {
    const vw = window.innerWidth;
    const canvasWidth = isMobile() ? MOBILE_DASHBOARD_WIDTH : DASHBOARD_WIDTH;
    const scale = vw / canvasWidth;

    stage.style.width = "100vw";
    stage.style.overflow = isMobile() ? "auto" : "visible";

    dashboard.style.position = "absolute";
    dashboard.style.left = "0px";
    dashboard.style.top = "0px";
    dashboard.style.width = canvasWidth + "px";
    dashboard.style.transformOrigin = "top left";
    dashboard.style.transform = `scale(${scale})`;

    /* Transforms don't expand scroll bounds, and since every .widget is
       absolutely positioned, #dashboard's own scrollHeight doesn't
       reliably include them. Calculate the true bottom edge by checking
       every widget's top+height instead. */
    let maxBottom = 0;
    document.querySelectorAll(".widget").forEach(w => {
      const top    = parseFloat(w.style.top)    || w.offsetTop;
      const height = parseFloat(w.style.height) || w.offsetHeight;
      maxBottom = Math.max(maxBottom, top + height);
    });
    const naturalHeight = Math.max(maxBottom + 160, dashboard.scrollHeight);
    const spacer = document.getElementById("dashboardScrollSpacer");
    if (spacer) spacer.style.height = (naturalHeight * scale) + "px";
  }

  /* Expose globally so other functions (loadLayout, resize handlers) can
     trigger a re-measure without re-running the whole setup */
  window.remeasureDashboardScale = applyScale;

  window.addEventListener("resize", () => {
    applyScale();
    if (tidePredictions.length) drawTide(tidePredictions);
  });

  applyScale();
  /* Re-measure after widgets finish loading content (images, fonts) */
  setTimeout(applyScale, 400);
  setTimeout(applyScale, 1200);
}

function getDashboardScale() {
  const dashboard = document.getElementById("dashboard");
  if (!dashboard) return 1;

  const style = window.getComputedStyle(dashboard);
  const transform = style.transform;

  if (!transform || transform === "none") return 1;

  const match = transform.match(/matrix\(([^)]+)\)/);
  if (match) {
    const values = match[1].split(",").map(Number);
    return values[0] || 1;
  }

  const match3d = transform.match(/matrix3d\(([^)]+)\)/);
  if (match3d) {
    const values = match3d[1].split(",").map(Number);
    return values[0] || 1;
  }

  return 1;
}

/* ==========================================================================
   LAYOUT EDITOR
   ========================================================================== */
function setupLayoutEditor() {
  const toggle     = document.getElementById("layoutToggle");
  const snapToggle = document.getElementById("snapToggle");
  const widgets    = [...document.querySelectorAll(".widget")];

  loadLayout();
  /* Re-measure scaled height now that widgets have their real positions */
  if (typeof remeasureDashboardScale === "function") remeasureDashboardScale();

  toggle.addEventListener("click", () => {
    layoutEditMode = !layoutEditMode;

    document.body.classList.toggle("layout-edit", layoutEditMode);
    toggle.classList.toggle("active", layoutEditMode);
    toggle.textContent = layoutEditMode ? "Done Editing" : "Edit Layout";

    if (snapToggle) snapToggle.style.display = layoutEditMode ? "" : "none";

    applyAllWidgetSettings();

    /* sync mobile header edit button label */
    const mobileEditBtn = document.getElementById("mobileEditBtn");
    if (mobileEditBtn) {
      mobileEditBtn.textContent = layoutEditMode ? "Done" : "Edit";
      mobileEditBtn.classList.toggle("active", layoutEditMode);
    }

    if (!layoutEditMode) {
      closeAllSettingsPanels();
      saveLayout();
      saveAllSettings();
    }
  });

  if (snapToggle) {
    snapToggle.addEventListener("click", () => {
      snapEnabled = !snapEnabled;
      snapToggle.classList.toggle("active", snapEnabled);
      snapToggle.textContent = snapEnabled ? "Snap: On" : "Snap: Off";
    });
  }

  widgets.forEach(makeWidgetInteractive);
}

function makeWidgetInteractive(widget) {
  const handle = widget.querySelector(".widgetHandle");
  const resize = widget.querySelector(".widgetResize");

  if (!handle || !resize) return;

  let dragStart   = null;
  let resizeStart = null;

  const SNAP_GRID = 10;        /* base grid snap, in canvas px */
  const SNAP_EDGE = 14;        /* snap threshold for aligning to other widgets, in canvas px */

  /* ---- shared move/end handlers ---- */
  function getClientXY(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  /* Collect the left/right/top/bottom edges of every other widget,
     used as snap targets while dragging/resizing this one. */
  function getSnapEdges() {
    const xs = [];
    const ys = [];
    document.querySelectorAll(".widget").forEach(w => {
      if (w === widget) return;
      const left   = parseFloat(w.style.left)   || w.offsetLeft;
      const top    = parseFloat(w.style.top)    || w.offsetTop;
      const width  = parseFloat(w.style.width)  || w.offsetWidth;
      const height = parseFloat(w.style.height) || w.offsetHeight;
      xs.push(left, left + width);
      ys.push(top, top + height);
    });
    return { xs, ys };
  }

  function snapValue(value, candidates, threshold) {
    let best = Math.round(value / SNAP_GRID) * SNAP_GRID; /* grid snap fallback */
    let bestDist = Math.abs(value - best);
    candidates.forEach(c => {
      const d = Math.abs(value - c);
      if (d < threshold && d < bestDist) {
        best = c;
        bestDist = d;
      }
    });
    return best;
  }

  function onDragMove(e) {
    if (!dragStart) return;
    const { x, y } = getClientXY(e);
    const dx = (x - dragStart.startX) / dragStart.scale;
    const dy = (y - dragStart.startY) / dragStart.scale;

    let newLeft = dragStart.left + dx;
    let newTop  = dragStart.top  + dy;

    if (snapEnabled) {
      const { xs, ys } = getSnapEdges();
      const width  = widget.offsetWidth;
      const height = widget.offsetHeight;
      /* Try snapping both the left edge and the right edge of this
         widget against other widgets' edges, same for top/bottom */
      const snappedLeft  = snapValue(newLeft,            xs, SNAP_EDGE);
      const snappedRight = snapValue(newLeft + width,     xs, SNAP_EDGE) - width;
      const snappedTop   = snapValue(newTop,              ys, SNAP_EDGE);
      const snappedBot   = snapValue(newTop + height,     ys, SNAP_EDGE) - height;

      newLeft = Math.abs(snappedLeft - newLeft) <= Math.abs(snappedRight - newLeft) ? snappedLeft : snappedRight;
      newTop  = Math.abs(snappedTop  - newTop)  <= Math.abs(snappedBot  - newTop)   ? snappedTop  : snappedBot;
    }

    widget.style.left = `${newLeft}px`;
    widget.style.top  = `${newTop}px`;
  }

  function onDragEnd() {
    dragStart = null;
    saveLayout();
    if (typeof remeasureDashboardScale === "function") remeasureDashboardScale();
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup",   onDragEnd);
    window.removeEventListener("touchmove", onDragMove);
    window.removeEventListener("touchend",  onDragEnd);
  }

  function onResizeMove(e) {
    if (!resizeStart) return;
    const { x, y } = getClientXY(e);
    const dx = (x - resizeStart.startX) / resizeStart.scale;
    const dy = (y - resizeStart.startY) / resizeStart.scale;
    let newW = Math.max(120, resizeStart.width  + dx);
    let newH = Math.max(60,  resizeStart.height + dy);

    if (snapEnabled) {
      const { xs, ys } = getSnapEdges();
      const left = parseFloat(widget.style.left) || widget.offsetLeft;
      const top  = parseFloat(widget.style.top)  || widget.offsetTop;
      /* Snap the moving (right/bottom) edge against other widgets' edges */
      const snappedRight  = snapValue(left + newW, xs, SNAP_EDGE);
      const snappedBottom = snapValue(top  + newH, ys, SNAP_EDGE);
      newW = Math.max(120, snappedRight  - left);
      newH = Math.max(60,  snappedBottom - top);
    }

    widget.style.width  = `${newW}px`;
    widget.style.height = `${newH}px`;
    if (widget.dataset.widget === "tideChart" && tidePredictions.length) drawTide(tidePredictions);
  }

  function onResizeEnd() {
    resizeStart = null;
    saveLayout();
    if (typeof remeasureDashboardScale === "function") remeasureDashboardScale();
    if (widget.dataset.widget === "tideChart" && tidePredictions.length) drawTide(tidePredictions);
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup",   onResizeEnd);
    window.removeEventListener("touchmove", onResizeMove);
    window.removeEventListener("touchend",  onResizeEnd);
  }

  /* ---- drag handle: mouse + touch ---- */
  function startDrag(e) {
    if (!layoutEditMode) return;
    if (e.target.closest(".widgetSettingsBtn")) return;
    if (e.target.closest(".widgetHideBtn")) return;
    if (e.target.closest(".widgetSettingsPanel")) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = getClientXY(e);
    dragStart = {
      startX: x, startY: y,
      left:  parseFloat(widget.style.left  || widget.offsetLeft),
      top:   parseFloat(widget.style.top   || widget.offsetTop),
      scale: getDashboardScale()
    };
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup",   onDragEnd);
    window.addEventListener("touchmove", onDragMove, { passive: false });
    window.addEventListener("touchend",  onDragEnd);
  }

  handle.addEventListener("mousedown", startDrag);
  handle.addEventListener("touchstart", startDrag, { passive: false });

  /* ---- resize handle: mouse + touch ---- */
  function startResize(e) {
    if (!layoutEditMode) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = getClientXY(e);
    resizeStart = {
      startX: x, startY: y,
      width:  widget.offsetWidth,
      height: widget.offsetHeight,
      scale:  getDashboardScale()
    };
    window.addEventListener("mousemove", onResizeMove);
    window.addEventListener("mouseup",   onResizeEnd);
    window.addEventListener("touchmove", onResizeMove, { passive: false });
    window.addEventListener("touchend",  onResizeEnd);
  }

  resize.addEventListener("mousedown", startResize);
  resize.addEventListener("touchstart", startResize, { passive: false });
}

/* ==========================================================================
   SAVE / LOAD LAYOUT
   ========================================================================== */
function saveLayout() {
  const key = isMobile() ? MOBILE_STORAGE_KEY : STORAGE_KEY;
  const layout = {};
  document.querySelectorAll(".widget").forEach(widget => {
    layout[widget.dataset.widget] = {
      left: widget.style.left || `${widget.offsetLeft}px`,
      top: widget.style.top || `${widget.offsetTop}px`,
      width: widget.style.width || `${widget.offsetWidth}px`,
      height: widget.style.height || `${widget.offsetHeight}px`
    };
  });
  localStorage.setItem(key, JSON.stringify(layout));
}

function loadLayout() {
  const key = isMobile() ? MOBILE_STORAGE_KEY : STORAGE_KEY;
  const fallback = isMobile() ? DEFAULT_MOBILE_LAYOUT : DEFAULT_LAYOUT;
  const raw = localStorage.getItem(key);
  const layout = raw ? JSON.parse(raw) : fallback;

  try {
    Object.entries(layout).forEach(([key, value]) => {
      const widget = document.querySelector(`.widget[data-widget="${key}"]`);
      if (!widget) return;

      if (value.left) widget.style.left = value.left;
      if (value.top) widget.style.top = value.top;
      if (value.width) widget.style.width = value.width;
      if (value.height) widget.style.height = value.height;
    });
  } catch (err) {
    console.error(err);
  }
}

/* ==========================================================================
   SETTINGS SYSTEM
   ========================================================================== */
function setupWidgetSettingsSystem() {
  const widgets = [...document.querySelectorAll(".widget")];

  widgets.forEach(widget => {
    const key = widget.dataset.widget;

    /* open settings */
    const settingsBtn = widget.querySelector(".widgetSettingsBtn");
    if (settingsBtn) {
      settingsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!layoutEditMode) return;

        /* Check if this widget's panel is currently detached and open */
        const existingPanel = document.querySelector(`.widgetSettingsPanel.is-detached[data-settings-for="${widget.dataset.widget}"]`);
        const isOpen = widget.classList.contains("show-settings") || !!existingPanel;
        closeAllSettingsPanels();

        if (!isOpen) {
          widget.classList.add("show-settings");

          /* Always detach immediately — no inline open step */
          const settingsPanelForDetach = widget.querySelector(".widgetSettingsPanel");
          if (settingsPanelForDetach && !settingsPanelForDetach.classList.contains("is-detached")) {
            const rect = settingsPanelForDetach.getBoundingClientRect();
            const wRect = widget.getBoundingClientRect();
            document.body.appendChild(settingsPanelForDetach);
            settingsPanelForDetach.style.position  = "fixed";
            settingsPanelForDetach.style.left      = Math.min(wRect.right + 8, window.innerWidth - 280) + "px";
            settingsPanelForDetach.style.top       = Math.max(wRect.top, 10) + "px";
            settingsPanelForDetach.style.right     = "auto";
            settingsPanelForDetach.style.width     = "260px";
            settingsPanelForDetach.style.maxHeight = "80vh";
            settingsPanelForDetach.style.zIndex    = "99999";
            settingsPanelForDetach.style.display   = "block";
            settingsPanelForDetach.classList.add("is-detached");
          }

          /* On mobile: make the settings panel draggable by its header */
          if (isMobile() && settingsPanel) {
            /* Reset position each time it opens */
            settingsPanel.style.left       = "16px";
            settingsPanel.style.top        = "68px";
            settingsPanel.style.right      = "16px";
            settingsPanel.style.transition = "";

            const pHeader = settingsPanel.querySelector(".settingsHeader");
            if (pHeader && !pHeader._panelDragAttached) {
              pHeader._panelDragAttached = true;
              let pdStart = null, pdLeft = 16, pdTop = 68;

              /* Long-press anywhere in panel to drag it */
              let panelHoldTimer = null;
              let panelDragActive = false;

              settingsPanel.addEventListener("touchstart", (ev) => {
                if (ev.target.closest(".closeSettingsBtn")) return;
                if (ev.target.closest("input, select, button")) return;
                const r = settingsPanel.getBoundingClientRect();
                pdLeft = r.left; pdTop = r.top;
                pdStart = { x: ev.touches[0].clientX, y: ev.touches[0].clientY };
                panelDragActive = false;
                panelHoldTimer = setTimeout(() => {
                  panelDragActive = true;
                  settingsPanel.style.transition = "none";
                  settingsPanel.style.touchAction = "none";
                }, 400);
              }, { passive: true });

              settingsPanel.addEventListener("touchmove", (ev) => {
                if (!pdStart) return;
                const dx = ev.touches[0].clientX - pdStart.x;
                const dy = ev.touches[0].clientY - pdStart.y;
                /* cancel hold if moved too much before timer fires */
                if (!panelDragActive && Math.abs(dy) > 10) {
                  clearTimeout(panelHoldTimer);
                  panelHoldTimer = null;
                  pdStart = null;
                  return;
                }
                if (!panelDragActive) return;
                ev.preventDefault();
                ev.stopPropagation();
                const nLeft = Math.max(0, Math.min(window.innerWidth  - settingsPanel.offsetWidth,  pdLeft + dx));
                const nTop  = Math.max(0, Math.min(window.innerHeight - 100, pdTop  + dy));
                settingsPanel.style.left  = `${nLeft}px`;
                settingsPanel.style.top   = `${nTop}px`;
                settingsPanel.style.right = "auto";
              }, { passive: false });

              settingsPanel.addEventListener("touchend", () => {
                clearTimeout(panelHoldTimer);
                panelHoldTimer = null;
                panelDragActive = false;
                pdStart = null;
                settingsPanel.style.touchAction = "";
              });
            }
          }
        }
      });
    }

  /* close settings */
    const settingsPanel = widget.querySelector(".widgetSettingsPanel");
    const closeBtn = settingsPanel
      ? settingsPanel.querySelector(".closeSettingsBtn")
      : widget.querySelector(".closeSettingsBtn");
    if (closeBtn) {
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        widget.classList.remove("show-settings");
        if (settingsPanel) {
          settingsPanel.style.display = "";
          settingsPanel.classList.remove("is-detached");
          /* move back into widget if it was detached to body */
          if (settingsPanel.parentElement === document.body) {
            widget.appendChild(settingsPanel);
          }
        }
      });
    }

    /* hide widget */
    const hideBtn = widget.querySelector(".widgetHideBtn");
    if (hideBtn) {
      hideBtn.addEventListener("click", () => {
        const state = getWidgetSettings(key);
        state.hidden = !state.hidden;

        applyWidgetSettings(widget, state);
        saveAllSettings();
      });
    }

    /* theme selects */
    widget.querySelectorAll(".themeSelect").forEach(el => {
      el.addEventListener("change", () => {
        const state = getWidgetSettings(key);
        state.theme = el.value;
        applyWidgetSettings(widget, state);
        saveAllSettings();
      });
    });

    /* bg color */
    widget.querySelectorAll(".widgetBgColorInput").forEach(el => {
      el.addEventListener("input", () => {
        const state = getWidgetSettings(key);
        state.backgroundColor = el.value;
        applyWidgetSettings(widget, state);
        saveAllSettings();
      });
    });

    /* font selects */
    widget.querySelectorAll(".fontSelect").forEach(el => {
      el.addEventListener("change", () => {
        const state = getWidgetSettings(key);
        state[el.dataset.target] = el.value;
        applyWidgetSettings(widget, state);
        saveAllSettings();
      });
    });

    /* font colors */
    widget.querySelectorAll(".fontColorInput").forEach(el => {
      el.addEventListener("input", () => {
        const state = getWidgetSettings(key);
        state[el.dataset.target] = el.value;
        applyWidgetSettings(widget, state);
        saveAllSettings();
      });
    });

    /* alert colors */
    widget.querySelectorAll(".alertColorInput").forEach(el => {
      el.addEventListener("input", () => {
        const state = getWidgetSettings(key);
        state[el.dataset.target] = el.value;
        applyWidgetSettings(widget, state);
        saveAllSettings();
      });
    });

    /* title text edits */
    const heroTitleInput = widget.querySelector("#heroTitleInput");
    if (heroTitleInput) {
      heroTitleInput.addEventListener("input", () => {
        document.getElementById("heroTitleText").textContent = heroTitleInput.value;
      });
    }

    const heroSubtitleInput = widget.querySelector("#heroSubtitleInput");
    if (heroSubtitleInput) {
      heroSubtitleInput.addEventListener("input", () => {
        document.getElementById("heroSubtitleText").textContent = heroSubtitleInput.value;
      });
    }

    /* reset */
    widget.querySelectorAll(".resetWidgetBtn").forEach(btn => {
      btn.addEventListener("click", () => {
        widgetSettings[key] = {};
        applyWidgetSettings(widget, getWidgetSettings(key));
        syncControlsFromState(widget, getWidgetSettings(key));
        saveAllSettings();
      });
    });
  });

  /* dashboard settings */
  const bgColor = document.getElementById("dashboardBackgroundColor");
  const bgHue = document.getElementById("dashboardBackgroundHue");
  const bgReset = document.getElementById("dashboardResetBtn");

  if (bgColor) {
    bgColor.addEventListener("input", () => {
      dashboardSettings.backgroundColor = bgColor.value;
      applyDashboardSettings();
      saveAllSettings();
    });
  }

  if (bgHue) {
    bgHue.addEventListener("input", () => {
      dashboardSettings.backgroundHue = Number(bgHue.value);
      applyDashboardSettings();
      saveAllSettings();
    });
  }

  if (bgReset) {
    bgReset.addEventListener("click", () => {
      dashboardSettings = {
        backgroundColor: "#07131c",
        backgroundHue: 0
      };

      applyDashboardSettings();

      if (bgColor) bgColor.value = dashboardSettings.backgroundColor;
      if (bgHue) bgHue.value = dashboardSettings.backgroundHue;

      saveAllSettings();
    });
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".widgetSettingsPanel") &&
        !e.target.closest(".widgetSettingsBtn")) {
      closeAllSettingsPanels();
    }
  });
}

function closeAllSettingsPanels() {
  document.querySelectorAll(".widget").forEach(w => {
    w.classList.remove("show-settings");
  });
  /* Move detached panels back into their widgets so they can be reopened */
  document.querySelectorAll(".widgetSettingsPanel.is-detached").forEach(p => {
    const key    = p.dataset.settingsFor;
    const widget = key ? document.querySelector(`.widget[data-widget="${key}"]`) : null;
    p.classList.remove("is-detached");
    p.style.display  = "";
    p.style.position = "";
    p.style.left     = "";
    p.style.top      = "";
    p.style.right    = "";
    p.style.width    = "";
    p.style.maxHeight = "";
    p.style.zIndex   = "";
    if (widget) widget.appendChild(p);
  });
}

/* Close settings when tapping/clicking outside — works for both detached and inline panels */
function handleOutsideSettingsClose(e) {
  /* Check for any open detached panel */
  const detachedPanel = document.querySelector(".widgetSettingsPanel.is-detached[style*='block'], .widgetSettingsPanel.is-detached:not([style*='none'])");
  const openWidget    = document.querySelector(".widget.show-settings");

  if (!detachedPanel && !openWidget) return;

  /* If tap/click was inside any settings panel or any settings button — ignore */
  if (e.target.closest(".widgetSettingsPanel")) return;
  if (e.target.closest(".widgetSettingsBtn")) return;

  saveAllSettings();
  closeAllSettingsPanels();
}

document.addEventListener("touchstart", handleOutsideSettingsClose, { passive: true });
document.addEventListener("click",      handleOutsideSettingsClose);

function getWidgetSettings(key) {
  if (!widgetSettings[key]) widgetSettings[key] = {};
  return widgetSettings[key];
}

function applyAllWidgetSettings() {
  document.querySelectorAll(".widget").forEach(widget => {
    const key = widget.dataset.widget;
    applyWidgetSettings(widget, getWidgetSettings(key));
    syncControlsFromState(widget, getWidgetSettings(key));
  });

  applyDashboardSettings();
}

function applyWidgetSettings(widget, state) {
  const hideBtn = widget.querySelector(".widgetHideBtn");

  /* Hidden widgets show while editing; on mobile respects hidden state when not editing */
  widget.classList.toggle("hidden-widget", !!state.hidden && !layoutEditMode);

  if (hideBtn) {
    hideBtn.classList.toggle("is-hidden", !!state.hidden);
  }

  widget.classList.remove(
    "theme-default",
    "theme-clean",
    "theme-glass",
    "theme-ocean",
    "theme-sunset",
    "theme-dynamic"
  );

  widget.classList.add(`theme-${state.theme || "default"}`);

  if (state.backgroundColor) {
    widget.style.setProperty("--widget-local-bg", state.backgroundColor);
  } else {
    widget.style.removeProperty("--widget-local-bg");
  }

  setIf(state.row1Font, "--row1-font", widget);
  setIf(state.row2Font, "--row2-font", widget);

  setIf(state.row1Color, "--row1-color", widget);
  setIf(state.row2Color, "--row2-color", widget);

  setIf(state.row1AlertColor, "--row1-alert-color", widget);
  setIf(state.row2AlertColor, "--row2-alert-color", widget);
}

function setIf(value, prop, el) {
  if (value) el.style.setProperty(prop, value);
  else el.style.removeProperty(prop);
}

function syncControlsFromState(widget, state) {
  widget.querySelectorAll(".themeSelect").forEach(el => {
    el.value = state.theme || "default";
  });

  widget.querySelectorAll(".widgetBgColorInput").forEach(el => {
    el.value = state.backgroundColor || "#0a1924";
  });

  widget.querySelectorAll(".fontSelect").forEach(el => {
    el.value = state[el.dataset.target] || "Segoe UI";
  });

  widget.querySelectorAll(".fontColorInput").forEach(el => {
    el.value = state[el.dataset.target] || "#eef7ff";
  });

  widget.querySelectorAll(".alertColorInput").forEach(el => {
    el.value = state[el.dataset.target] || "#ff7c7c";
  });
}

function applyDashboardSettings() {
  const color = dashboardSettings.backgroundColor || "#07131c";
  const hue = dashboardSettings.backgroundHue || 0;

  const shifted = shiftHue(color, hue);
  const darker1 = shadeColor(shifted, -18);
  const darker2 = shadeColor(shifted, -34);

  document.documentElement.style.setProperty("--dashboard-bg-1", shifted);
  document.documentElement.style.setProperty("--dashboard-bg-2", darker1);
  document.documentElement.style.setProperty("--dashboard-bg-3", darker2);

  document.body.style.background = `
    radial-gradient(circle at top, rgba(255,255,255,0.08), transparent 35%),
    linear-gradient(to bottom, ${shifted} 0%, ${darker1} 45%, ${darker2} 100%)
  `;
}

function saveAllSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      widgetSettings,
      dashboardSettings,
      heroTitle: document.getElementById("heroTitleText")?.textContent || "",
      heroSubtitle: document.getElementById("heroSubtitleText")?.textContent || ""
    })
  );
}

function loadAllSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  const parsed = raw ? JSON.parse(raw) : DEFAULT_SETTINGS;

  try {
    widgetSettings = parsed.widgetSettings || {};
    dashboardSettings = parsed.dashboardSettings || dashboardSettings;

    if (parsed.heroTitle) {
      const el = document.getElementById("heroTitleText");
      if (el) el.textContent = parsed.heroTitle;
    }
    if (parsed.heroSubtitle) {
      const el = document.getElementById("heroSubtitleText");
      if (el) el.textContent = parsed.heroSubtitle;
    }
  } catch (err) {
    console.error(err);
  }
}

/* ==========================================================================
   DATE CONTROLS
   ========================================================================== */
function setupDateControls() {
  const viewBtn = document.getElementById("viewDateBtn");
  const liveBtn = document.getElementById("liveViewBtn");

  if (viewBtn) {
    viewBtn.addEventListener("click", async () => {
      const value = document.getElementById("tideDateSelect").value;
      if (!value) return;

      tideViewMode = "date";
      selectedTideDate = value;
      tideScrubTimeMs = null;

      await loadTides();
    });
  }

  if (liveBtn) {
    liveBtn.addEventListener("click", async () => {
      tideViewMode = "live";
      selectedTideDate = null;
      tideScrubTimeMs = null;

      await loadTides();
    });
  }
}

function initializeDatePicker() {
  const dateInput = document.getElementById("tideDateSelect");
  if (!dateInput) return;

  const today = new Date();
  const oneYear = new Date();
  oneYear.setFullYear(today.getFullYear() + 1);

  dateInput.min = formatDateInput(today);
  dateInput.max = formatDateInput(oneYear);
  dateInput.value = formatDateInput(today);
}

function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

/* ==========================================================================
   EVENTS
   ========================================================================== */
function attachEvents() {
  const select = document.getElementById("stationSelect");

  if (select) {
    select.addEventListener("change", async (e) => {
      const stationId = e.target.value;
      const match = nearbyStations.find(s => s.id === stationId);
      if (!match) return;
      selectedStation = match;
      tideScrubTimeMs = null;
      tideViewOffsetMs = 0;
      await refreshAll();
    });
  }

  const forecastWidget = document.getElementById("forecastWidget");
  if (forecastWidget) {
    if (isMobile()) {
      /* ---- Mobile: smooth translateX scroll with momentum ---- */
      let touchStartX      = null;
      let touchLastX       = 0;
      let touchStartScroll = 0;
      let touchVelocity    = 0;
      let touchMoved       = false;
      let momentumRAF      = null;
      const DRAG_THRESHOLD = 6;

      function getForecastMaxPx() {
        const wrap = document.getElementById("forecast");
        if (!wrap || !_lastWeatherData) return 0;
        /* total strip width minus visible window width */
        return Math.max(0, wrap.scrollWidth - forecastWidget.offsetWidth);
      }

      function applyForecastScroll(px) {
        _forecastScrollPx = Math.max(0, Math.min(px, getForecastMaxPx()));
        setForecastTranslate(_forecastScrollPx);
      }

      function startMomentum() {
        if (momentumRAF) cancelAnimationFrame(momentumRAF);
        function step() {
          if (Math.abs(touchVelocity) < 0.3) { momentumRAF = null; return; }
          touchVelocity    *= 0.90;
          applyForecastScroll(_forecastScrollPx + touchVelocity);
          momentumRAF = requestAnimationFrame(step);
        }
        momentumRAF = requestAnimationFrame(step);
      }

      forecastWidget.addEventListener("touchstart", (e) => {
        if (layoutEditMode) return;
        if (momentumRAF) { cancelAnimationFrame(momentumRAF); momentumRAF = null; }
        touchStartX      = e.touches[0].clientX;
        touchLastX       = touchStartX;
        touchStartScroll = _forecastScrollPx;
        touchVelocity    = 0;
        touchMoved       = false;
      }, { passive: true });

      forecastWidget.addEventListener("touchmove", (e) => {
        if (touchStartX === null || layoutEditMode) return;
        const dx = e.touches[0].clientX - touchStartX;
        /* track velocity on every move */
        touchVelocity = (e.touches[0].clientX - touchLastX);
        touchLastX    = e.touches[0].clientX;
        if (Math.abs(dx) > DRAG_THRESHOLD) {
          touchMoved = true;
          applyForecastScroll(touchStartScroll - dx);
        }
      }, { passive: true });

      forecastWidget.addEventListener("touchend", async () => {
        if (!touchMoved && touchStartX !== null) {
          if (_forecastScrollPx < 5) {
            /* tap at start — toggle hourly/weekly */
            _forecastScrollPx = 0;
            weatherViewMode   = weatherViewMode === "hourly" ? "weekly" : "hourly";
            await loadWeather();
          } else {
            /* tap while scrolled — snap back to start */
            _forecastScrollPx = 0;
            setForecastTranslate(0);
          }
        } else {
          /* release with momentum */
          touchVelocity = -touchVelocity; /* invert: swipe left = scroll right */
          startMomentum();
        }
        touchStartX = null;
      });

    } else {
      /* ---- Desktop: click to toggle hourly/weekly (unchanged) ---- */
      forecastWidget.addEventListener("click", async (e) => {
        if (layoutEditMode) return;
        if (e.target.closest(".widgetControls")) return;
        if (e.target.closest(".widgetSettingsPanel")) return;
        weatherViewMode = weatherViewMode === "hourly" ? "weekly" : "hourly";
        await loadWeather();
      });
    }
  }

  const marineBtn = document.getElementById("marineAddressBtn");
  if (marineBtn) {
    marineBtn.addEventListener("click", () => {
      const input = document.getElementById("marineAddressInput");
      if (input && input.value.trim()) {
        geocodeMarineAddress(input.value.trim());
      }
    });
    const input = document.getElementById("marineAddressInput");
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && input.value.trim()) {
          geocodeMarineAddress(input.value.trim());
        }
      });
    }
  }

  /* ── New settings controls ── */
  function _chk(id, setter) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => { setter(el.checked); localStorage.setItem(id, el.checked ? "1" : "0"); });
  }
  function _num(id, setter) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => { const v = parseFloat(el.value) || 0; setter(v); localStorage.setItem(id, el.value); });
  }

  /* Temperature */
  _chk("tempShowTemp",     v => { tempShowTemp     = v; if (_lastWeatherData) renderCurrentConditions(_lastWeatherData); });
  _chk("tempShowHumidity", v => { tempShowHumidity = v; if (_lastWeatherData) renderCurrentConditions(_lastWeatherData); });
  _chk("tempShowCelsius",  v => { tempShowCelsius  = v; if (_lastWeatherData) renderCurrentConditions(_lastWeatherData); });
  _chk("tempHeatAlertOn",  v => { tempHeatAlertOn  = v; if (_lastWeatherData) renderCurrentConditions(_lastWeatherData); });
  _chk("tempColdAlertOn",  v => { tempColdAlertOn  = v; if (_lastWeatherData) renderCurrentConditions(_lastWeatherData); });
  _num("tempHeatAlertVal", v => { HEAT_ALERT_F     = v; if (_lastWeatherData) renderCurrentConditions(_lastWeatherData); });
  _num("tempColdAlertVal", v => { COLD_ALERT_F     = v; if (_lastWeatherData) renderCurrentConditions(_lastWeatherData); });

  /* Forecast */
  function reRenderForecast() {
    /* Force re-render by clearing the cached key */
    const wrap = document.getElementById("forecast");
    if (wrap) wrap.dataset.renderedKey = "";
    renderWeather(null);
  }
  _chk("fcShowTemp",      v => { fcShowTemp      = v; reRenderForecast(); });
  _chk("fcShowHumidity",  v => { fcShowHumidity  = v; reRenderForecast(); });
  _chk("fcShowRain",      v => { fcShowRain      = v; reRenderForecast(); });
  _chk("fcShowWind",      v => { fcShowWind      = v; reRenderForecast(); });
  _chk("fcShowCondition", v => { fcShowCondition = v; reRenderForecast(); });
  _chk("fcHeatAlertOn",   v => { fcHeatAlertOn   = v; reRenderForecast(); });
  _chk("fcColdAlertOn",   v => { fcColdAlertOn   = v; reRenderForecast(); });
  _chk("fcRainAlertOn",   v => { fcRainAlertOn   = v; reRenderForecast(); });
  _chk("fcWindAlertOn",   v => { fcWindAlertOn   = v; reRenderForecast(); });
  _num("fcHeatAlertVal",  v => { HEAT_ALERT_F    = v; renderWeather(null); });
  _num("fcColdAlertVal",  v => { fcColdAlertVal  = v; renderWeather(null); });
  _num("fcRainAlertVal",  v => { fcRainAlertVal  = v; renderWeather(null); });
  _num("fcWindAlertVal",  v => { WIND_ALERT_MPH  = v; renderWeather(null); });

  /* Tide status */
  _chk("tideStatusColorAlert", v => { tideStatusColorAlert = v; if (tidePredictions.length) drawTide(tidePredictions); });

  /* Tide chart */
  _chk("tideChartLowAlertOn",   v => { tideChartLowAlertOn  = v; if (tidePredictions.length) drawTide(tidePredictions); });
  _chk("tideChartHighAlertOn",  v => { tideChartHighAlertOn = v; if (tidePredictions.length) drawTide(tidePredictions); });
  _num("tideChartLowAlertVal",  v => { LOW_TIDE_ALERT_FT    = v; if (tidePredictions.length) drawTide(tidePredictions); });
  _num("tideChartHighAlertVal", v => { HIGH_TIDE_ALERT_FT   = v; if (tidePredictions.length) drawTide(tidePredictions); });

}

/* ==========================================================================
   CLOCK
   ========================================================================== */
function updateClockAndDate() {
  const now = new Date();

  const clock = document.getElementById("clock");
  const date = document.getElementById("date");

  if (clock) {
    clock.textContent = now.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
  }

  if (date) {
    date.textContent = now.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  }
}

/* ==========================================================================
   LOCATION
   ========================================================================== */
function getLocation() {
  if (!("geolocation" in navigator)) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      userLat = pos.coords.latitude;
      userLon = pos.coords.longitude;

      /* marina address takes priority over GPS */
      if (marineLocationLat && marineLocationLon) return;

      const select = document.getElementById("stationSelect");
      if (select) select.innerHTML = "<option>Finding nearby stations...</option>";

      if (!allNoaaStations) {
        allNoaaStations = await fetchAllNoaaStations();
      }

      await updateNearbyStations(userLat, userLon);
    },
    () => {},
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 }
  );
}

async function updateNearbyStations(lat, lon) {
  const stations = allNoaaStations || LOCAL_STATIONS;

  nearbyStations = stations
    .map(s => ({
      ...s,
      distance: haversineMiles(lat, lon, s.lat, s.lon)
    }))
    .filter(s => !isNaN(s.distance))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 5);

  if (nearbyStations.length === 0) nearbyStations = [...LOCAL_STATIONS];

  populateStationDropdown();

  const existing = nearbyStations.find(s => s.id === selectedStation.id);
  selectedStation = existing || nearbyStations[0];

  const select = document.getElementById("stationSelect");
  if (select) select.value = selectedStation.id;

  await refreshAll();
}

async function fetchAllNoaaStations() {
  /* check localStorage cache first — valid for 24 hours */
  const cached = localStorage.getItem("noaaStationsCache");
  const cachedTime = localStorage.getItem("noaaStationsCacheTime");

  if (cached && cachedTime) {
    const age = Date.now() - parseInt(cachedTime);
    if (age < 86400000) { /* 24 hours */
      try {
        return JSON.parse(cached);
      } catch(e) {}
    }
  }

  try {
    const res = await fetch(`${NOAA_PROXY}/stations`);
    if (!res.ok) throw new Error("Station list fetch failed");

    const data = await res.json();

    /* NOAA returns stations in data.stations array
       filter to only tide prediction stations (type "R" = water level) */
    const stations = (data.stations || [])
      .filter(s =>
        s.lat != null &&
        s.lng != null
      )
      .map(s => ({
        id: s.id,
        name: s.name,
        state: s.state || "",
        lat: parseFloat(s.lat),
        lon: parseFloat(s.lng)
      }));

    /* cache to localStorage */
    localStorage.setItem("noaaStationsCache", JSON.stringify(stations));
    localStorage.setItem("noaaStationsCacheTime", Date.now().toString());

    return stations;
  } catch (err) {
    console.warn("Could not fetch NOAA stations, using local fallback:", err);
    return null;
  }
}

function populateStationDropdown() {
  const select = document.getElementById("stationSelect");
  if (!select) return;

  select.innerHTML = "";

  nearbyStations.forEach((station) => {
    const opt = document.createElement("option");

    opt.value = station.id;
    opt.textContent =
      typeof station.distance === "number"
        ? `${station.name}, ${station.state} • ${station.distance.toFixed(1)} mi`
        : `${station.name}, ${station.state}`;

    select.appendChild(opt);
  });

  select.value = selectedStation.id;
}

/* ==========================================================================
   WEATHER
   ========================================================================== */
async function loadWeather() {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${userLat}&longitude=${userLon}` +
      `&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,windspeed_10m,winddirection_10m,weathercode` +
      `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max` +
      `&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto`;

    const res = await fetch(url);
    const data = await res.json();

    renderWeather(data);
    renderCurrentConditions(data);
  } catch (err) {
    console.error(err);
  }
}

function renderCurrentConditions(data) {
  const now2 = new Date();
  const padZ2 = n => String(n).padStart(2, "0");
  const localNowStr2 = `${now2.getFullYear()}-${padZ2(now2.getMonth()+1)}-${padZ2(now2.getDate())}T${padZ2(now2.getHours())}`;
  let idx = data.hourly.time.findIndex(t => t >= localNowStr2);
  if (idx < 0) idx = 0;
  const i = idx;

  const temp     = Math.round(data.hourly.temperature_2m[i]);
  const humidity = Math.round(data.hourly.relative_humidity_2m[i]);
  const tempC    = Math.round((temp - 32) * 5 / 9);
  lastWindMph    = Math.round(data.hourly.windspeed_10m[i]);
  lastWindDeg    = Math.round(data.hourly.winddirection_10m[i]);

  const tempMain    = document.getElementById("tempMain");
  const tempSub     = document.getElementById("tempSub");
  const tempCelsius = document.getElementById("tempCelsius");

  /* Apply heat/cold alert color */
  let tempColor = "";
  if (tempHeatAlertOn && temp >= HEAT_ALERT_F) tempColor = "#ff6b6b";
  else if (tempColdAlertOn && temp <= COLD_ALERT_F) tempColor = "#74c0fc";

  if (tempMain) {
    tempMain.style.display = tempShowTemp ? "" : "none";
    tempMain.textContent   = `${temp}°`;
    if (tempColor) tempMain.style.color = tempColor;
    else tempMain.style.color = "";
  }
  if (tempSub) {
    tempSub.style.display = tempShowHumidity ? "" : "none";
    tempSub.textContent   = `${humidity}% Humidity`;
  }
  if (tempCelsius) {
    tempCelsius.style.display = tempShowCelsius ? "" : "none";
    tempCelsius.textContent   = `${tempC}°C`;
  }

  /* Mobile header */
  const headerTemp   = document.getElementById("mobileHeaderTempVal");
  const headerHumPct = document.getElementById("mobileHeaderHumPct");
  if (headerTemp)   headerTemp.textContent   = `${temp}°`;
  if (headerHumPct) headerHumPct.textContent = `${humidity}%`;

  renderWindReadings();
  renderCompass();
  updateCompassMap();
}
function renderWindReadings() {
  const topEl = document.getElementById("windReadings");
  const botEl = document.getElementById("windDir");

  const mph = lastWindMph;
  const kph = Math.round(mph * 1.60934);
  const knots = Math.round(mph * 0.868976);

  const parts = [];
  if (showWindMph) parts.push(`${mph} mph`);
  if (showWindKph) parts.push(`${kph} kph`);
  if (showWindKnots) parts.push(`${knots} kts`);

  if (topEl) {
    topEl.innerHTML = parts.length
      ? `<div class="windReadingLine">${parts.join(' <span class="windSep">|</span> ')}</div>`
      : "";
    topEl.style.transform = `translateY(${windTopOffset}px)`;
  }

  let botHtml = "";
  if (showWindDir) botHtml = `<div class="windReadingDir">${degToCompass(lastWindDeg)} ${lastWindDeg}°</div>`;
  if (botEl) {
    botEl.innerHTML = botHtml;
    botEl.style.transform = `translateY(${windBotOffset}px)`;
  }

  /* Temp/humidity is now shown in the mobile header — nothing to inject here */
}

function renderCompass() {
  const compassEl = document.getElementById("compassWidget");
  const outer = document.getElementById("compassOuter");
  const arrow = document.getElementById("windArrow");
  const cardinals = document.getElementById("compassCardinals");
  if (!compassEl) return;

  const size = compassSize;

  /* size the compass circle */
  compassEl.style.width = `${size}px`;
  compassEl.style.height = `${size}px`;
if (outer) {
    outer.style.width = `${size}px`;
    outer.style.height = `${size}px`;
  }

  /* size the arrow proportionally */
  if (arrow) {
    const arrowH = Math.round(size * 0.42);
    arrow.style.height = `${arrowH}px`;
    arrow.style.top = `${Math.round(size * 0.08)}px`;
    arrow.style.transform = `translateX(-50%) rotate(${lastWindDeg}deg)`;
  }

  /* apply compass style class */
  if (compassEl) {
    compassEl.className = `compass compassStyle-${compassStyle}`;
    compassEl.id = "compassWidget";
  }

  /* position cardinals based on offset */
  if (cardinals) {
    const r = size / 2 + cardinalOffset;
    const n = document.getElementById("cardinalN");
    const s = document.getElementById("cardinalS");
    const e = document.getElementById("cardinalE");
    const w = document.getElementById("cardinalW");

    if (n) { n.style.left = "50%"; n.style.top = `calc(50% - ${r}px)`; }
    if (s) { s.style.left = "50%"; s.style.top = `calc(50% + ${r}px)`; }
    if (e) { e.style.left = `calc(50% + ${r}px)`; e.style.top = "50%"; }
    if (w) { w.style.left = `calc(50% - ${r}px)`; w.style.top = "50%"; }
  }
}

/* ==========================================================================
   SATELLITE COMPASS
   ========================================================================== */
function updateCompassMap() {
  const canvas = document.getElementById("compassMapCanvas");
  const compassEl = document.getElementById("compassWidget");
  const widgetFrame = document.querySelector("#windWidget .widgetFrame");
  if (!canvas || !marineLocationLat || !marineLocationLon) return;

  const size = compassSize;

  if (compassMapMode === "none") {
    canvas.style.display = "none";
    return;
  }
  canvas.style.display = "block";

  if (compassMapMode === "widget" && widgetFrame) {
    const w2 = widgetFrame.offsetWidth;
    const h2 = widgetFrame.offsetHeight;
    canvas.width = w2;
    canvas.height = h2;
    canvas.style.width = w2 + "px";
    canvas.style.height = h2 + "px";
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.borderRadius = "8px";

    /* move canvas to widgetFrame level */
    if (canvas.parentElement !== widgetFrame) {
      widgetFrame.insertBefore(canvas, widgetFrame.firstChild);
    }
    canvas.classList.add("fillWidget");
  } else {
    /* compass mode — canvas stays inside .compass */
    if (canvas.parentElement !== compassEl) {
      compassEl.insertBefore(canvas, compassEl.firstChild);
    }
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.borderRadius = "50%";
    canvas.classList.remove("fillWidget");
  }

  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const zoom = compassZoom;
  const lat = marineLocationLat;
  const lon = marineLocationLon;

  const n = Math.pow(2, zoom);
  const tileX = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  const pixelX = Math.floor(((lon + 180) / 360 * n - tileX) * 256);
  const pixelY = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - tileY) * 256);

  ctx.save();
  ctx.beginPath();
  if (compassMapMode === "compass") {
    ctx.roundRect(0, 0, w, h, 8);
  } else {
    ctx.roundRect(0, 0, w, h, 8);
  }
  ctx.clip();
  ctx.fillStyle = "#0a1924";
  ctx.fillRect(0, 0, w, h);

  [-1, 0, 1].forEach(dy => {
    [-1, 0, 1].forEach(dx => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${tileY + dy}/${tileX + dx}`;
      img.onload = () => {
        const drawX = (w / 2 - pixelX) + dx * 256;
        const drawY = (h / 2 - pixelY) + dy * 256;
        ctx.drawImage(img, drawX, drawY, 256, 256);
      };
    });
  });

  ctx.restore();
}


/* Load all new widget settings from localStorage */
function loadNewWidgetSettings() {
  const _n = (k, def) => parseFloat(localStorage.getItem(k) || def);

  tempShowTemp         = localStorage.getItem("tempShowTemp")    !== "0";
  tempShowHumidity     = localStorage.getItem("tempShowHumidity") !== "0";
  tempShowCelsius      = localStorage.getItem("tempShowCelsius")  === "1";
  tempHeatAlertOn      = localStorage.getItem("tempHeatAlertOn")  !== "0";
  tempColdAlertOn      = localStorage.getItem("tempColdAlertOn")  === "1";
  HEAT_ALERT_F         = _n("tempHeatAlertVal", 95);
  COLD_ALERT_F         = _n("tempColdAlertVal", 40);

  fcShowTemp           = localStorage.getItem("fcShowTemp")      !== "0";
  fcShowHumidity       = localStorage.getItem("fcShowHumidity")  !== "0";
  fcShowRain           = localStorage.getItem("fcShowRain")      !== "0";
  fcShowWind           = localStorage.getItem("fcShowWind")      !== "0";
  fcShowCondition      = localStorage.getItem("fcShowCondition") !== "0";
  fcHeatAlertOn        = localStorage.getItem("fcHeatAlertOn")   !== "0";
  fcColdAlertOn        = localStorage.getItem("fcColdAlertOn")   === "1";
  fcColdAlertVal       = _n("fcColdAlertVal", 40);
  fcRainAlertOn        = localStorage.getItem("fcRainAlertOn")   !== "0";
  fcRainAlertVal       = _n("fcRainAlertVal", 70);
  fcWindAlertOn        = localStorage.getItem("fcWindAlertOn")   !== "0";
  WIND_ALERT_MPH       = _n("fcWindAlertVal", 25);

  tideStatusColorAlert = localStorage.getItem("tideStatusColorAlert") !== "0";
  tideChartLowAlertOn  = localStorage.getItem("tideChartLowAlertOn")  !== "0";
  tideChartHighAlertOn = localStorage.getItem("tideChartHighAlertOn") === "1";
  LOW_TIDE_ALERT_FT    = _n("tideChartLowAlertVal",  0.4);
  HIGH_TIDE_ALERT_FT   = _n("tideChartHighAlertVal", 5.0);

  /* Sync checkbox controls */
  [
    ["tempShowTemp", tempShowTemp], ["tempShowHumidity", tempShowHumidity],
    ["tempShowCelsius", tempShowCelsius], ["tempHeatAlertOn", tempHeatAlertOn],
    ["tempColdAlertOn", tempColdAlertOn],
    ["fcShowTemp", fcShowTemp], ["fcShowHumidity", fcShowHumidity],
    ["fcShowRain", fcShowRain], ["fcShowWind", fcShowWind],
    ["fcShowCondition", fcShowCondition], ["fcHeatAlertOn", fcHeatAlertOn],
    ["fcColdAlertOn", fcColdAlertOn], ["fcRainAlertOn", fcRainAlertOn],
    ["fcWindAlertOn", fcWindAlertOn], ["tideStatusColorAlert", tideStatusColorAlert],
    ["tideChartLowAlertOn", tideChartLowAlertOn], ["tideChartHighAlertOn", tideChartHighAlertOn],
  ].forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.checked = val; });

  /* Sync number inputs */
  [
    ["tempHeatAlertVal", HEAT_ALERT_F], ["tempColdAlertVal", COLD_ALERT_F],
    ["fcHeatAlertVal", HEAT_ALERT_F], ["fcColdAlertVal", fcColdAlertVal],
    ["fcRainAlertVal", fcRainAlertVal], ["fcWindAlertVal", WIND_ALERT_MPH],
    ["tideChartLowAlertVal", LOW_TIDE_ALERT_FT], ["tideChartHighAlertVal", HIGH_TIDE_ALERT_FT],
  ].forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.value = val; });
}

async function loadMarineLocation() {
  const lat = localStorage.getItem("marineLocationLat");
  const lon = localStorage.getItem("marineLocationLon");
  const address = localStorage.getItem("marineLocationAddress");
  const savedZoom = localStorage.getItem("compassZoom");
  const savedMode = localStorage.getItem("compassMapMode");
  const savedSize = localStorage.getItem("compassSize");
  const savedStyle = localStorage.getItem("compassStyle");
  const savedCardinalOffset = localStorage.getItem("cardinalOffset");
  const savedShowMph = localStorage.getItem("showWindMph");
  const savedShowKph = localStorage.getItem("showWindKph");
  const savedShowKnots = localStorage.getItem("showWindKnots");
  const savedShowDir = localStorage.getItem("showWindDir");
  const savedTopOffset = localStorage.getItem("windTopOffset");
  const savedBotOffset = localStorage.getItem("windBotOffset");

  if (savedZoom) {
    compassZoom = parseInt(savedZoom);
    const el = document.getElementById("compassZoom");
    const label = document.getElementById("compassZoomLabel");
    if (el) el.value = compassZoom;
    if (label) label.textContent = compassZoom;
  }
  if (savedMode) {
    compassMapMode = savedMode;
    const el = document.getElementById("compassMapMode");
    if (el) el.value = compassMapMode;
  }
  if (savedSize) {
    compassSize = parseInt(savedSize);
    const el = document.getElementById("compassSizeSlider");
    const label = document.getElementById("compassSizeLabel");
    if (el) el.value = compassSize;
    if (label) label.textContent = compassSize + "px";
  }
  if (savedStyle) {
    compassStyle = savedStyle;
    const el = document.getElementById("compassStyle");
    if (el) el.value = compassStyle;
  }
  if (savedCardinalOffset) {
    cardinalOffset = parseInt(savedCardinalOffset);
    const el = document.getElementById("cardinalOffset");
    const label = document.getElementById("cardinalOffsetLabel");
    if (el) el.value = cardinalOffset;
    if (label) label.textContent = cardinalOffset + "px";
  }
  if (savedShowMph !== null) {
    showWindMph = savedShowMph === "1";
    const el = document.getElementById("showWindMph");
    if (el) el.checked = showWindMph;
  }
  if (savedShowKph !== null) {
    showWindKph = savedShowKph === "1";
    const el = document.getElementById("showWindKph");
    if (el) el.checked = showWindKph;
  }
  if (savedShowKnots !== null) {
    showWindKnots = savedShowKnots === "1";
    const el = document.getElementById("showWindKnots");
    if (el) el.checked = showWindKnots;
  }
  if (savedShowDir !== null) {
    showWindDir = savedShowDir === "1";
    const el = document.getElementById("showWindDir");
    if (el) el.checked = showWindDir;
  }
  if (savedTopOffset !== null) {
    windTopOffset = parseInt(savedTopOffset);
    const el = document.getElementById("windTopOffset");
    const label = document.getElementById("windTopOffsetLabel");
    if (el) el.value = windTopOffset;
    if (label) label.textContent = windTopOffset + "px";
  }
  if (savedBotOffset !== null) {
    windBotOffset = parseInt(savedBotOffset);
    const el = document.getElementById("windBotOffset");
    const label = document.getElementById("windBotOffsetLabel");
    if (el) el.value = windBotOffset;
    if (label) label.textContent = windBotOffset + "px";
  }

  if (lat && lon) {
    marineLocationLat = parseFloat(lat);
    marineLocationLon = parseFloat(lon);
    /* Force radar iframe to reload with new location */
    if (compassMapMode === "radar") {
      const iframeEl = document.getElementById("radarIframe");
      if (iframeEl) iframeEl.src = "";
      setTimeout(updateCompassMap, 100);
    }
    userLat = marineLocationLat;
    userLon = marineLocationLon;
    const input = document.getElementById("marineAddressInput");
    if (input && address) input.value = address;
    updateCompassMap();
    await fetchAllNoaaStations().then(stations => {
      allNoaaStations = stations;
      return updateNearbyStations(marineLocationLat, marineLocationLon);
    });
  }
  renderCompass();
  renderWindReadings();

  return Promise.resolve();
}

function attachCompassSettingsEvents() {
  const marineBtn = document.getElementById("marineAddressBtn");
  if (marineBtn) {
    marineBtn.addEventListener("click", () => {
      const input = document.getElementById("marineAddressInput");
      if (input && input.value.trim()) geocodeMarineAddress(input.value.trim());
    });
  }

  const addressInput = document.getElementById("marineAddressInput");
  if (addressInput) {
    addressInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && addressInput.value.trim()) geocodeMarineAddress(addressInput.value.trim());
    });
  }

  const zoomSlider = document.getElementById("compassZoom");
  if (zoomSlider) {
    zoomSlider.addEventListener("input", () => {
      compassZoom = parseInt(zoomSlider.value);
      document.getElementById("compassZoomLabel").textContent = compassZoom;
      localStorage.setItem("compassZoom", compassZoom);
      if (compassMapMode === "radar") {
        const ifrZ = document.getElementById("radarIframe");
        if (ifrZ) ifrZ.src = "";
        setTimeout(refreshRadarOverlay, 100);
      }
      updateCompassMap();
    });
  }

  const modeSelect = document.getElementById("compassMapMode");
  if (modeSelect) {
    const updateRadarRow = () => {
      const row = document.getElementById("radarSpeedRow");
      if (row) row.style.display = modeSelect.value === "radar" ? "" : "none";
    };
    modeSelect.addEventListener("change", () => {
      compassMapMode = modeSelect.value;
      localStorage.setItem("compassMapMode", compassMapMode);
      updateRadarRow();
      /* If switching away from radar, clean up overlay */
      if (compassMapMode !== "radar") {
        const ov = document.getElementById("radarOverlayCanvas");
        if (ov) ov.style.display = "none";
        stopRadarAnimation();
      }
      updateCompassMap();
      updateRadarCenterBtnVisibility();
      /* Immediately draw overlay if switching to radar */
      if (compassMapMode === "radar") {
        setTimeout(refreshRadarOverlay, 100);
      }
    });
    updateRadarRow();
    updateRadarCenterBtnVisibility();
  }

  /* Radar speed slider */
  const radarSpeedSlider = document.getElementById("radarSpeed");
  if (radarSpeedSlider) {
    radarSpeedSlider.value = radarSpeed;
    const radarSpeedLabel = document.getElementById("radarSpeedLabel");
    if (radarSpeedLabel) radarSpeedLabel.textContent = radarSpeed;
    radarSpeedSlider.addEventListener("input", () => {
      radarSpeed = parseInt(radarSpeedSlider.value);
      if (radarSpeedLabel) radarSpeedLabel.textContent = radarSpeed;
      localStorage.setItem("radarSpeed", radarSpeed);
      if (compassMapMode === "radar") {
        stopRadarAnimation();
        const canvas = document.getElementById("compassMapCanvas");
        if (canvas) startRadarAnimation(canvas, canvas.width, canvas.height);
      }
    });
  }

  const sizeSlider = document.getElementById("compassSizeSlider");
  if (sizeSlider) {
    sizeSlider.addEventListener("input", () => {
      compassSize = parseInt(sizeSlider.value);
      document.getElementById("compassSizeLabel").textContent = compassSize + "px";
      localStorage.setItem("compassSize", compassSize);
      renderCompass();
      updateCompassMap();
    });
  }

  const styleSelect = document.getElementById("compassStyle");
  if (styleSelect) {
    styleSelect.addEventListener("change", () => {
      compassStyle = styleSelect.value;
      localStorage.setItem("compassStyle", compassStyle);
      renderCompass();
    });
  }

  const cardinalSlider = document.getElementById("cardinalOffset");
  if (cardinalSlider) {
    cardinalSlider.addEventListener("input", () => {
      cardinalOffset = parseInt(cardinalSlider.value);
      document.getElementById("cardinalOffsetLabel").textContent = cardinalOffset + "px";
      localStorage.setItem("cardinalOffset", cardinalOffset);
      renderCompass();
    });
  }

  const topOffsetSlider = document.getElementById("windTopOffset");
  if (topOffsetSlider) {
    topOffsetSlider.addEventListener("input", () => {
      windTopOffset = parseInt(topOffsetSlider.value);
      document.getElementById("windTopOffsetLabel").textContent = windTopOffset + "px";
      localStorage.setItem("windTopOffset", windTopOffset);
      renderWindReadings();
    });
  }

  const botOffsetSlider = document.getElementById("windBotOffset");
  if (botOffsetSlider) {
    botOffsetSlider.addEventListener("input", () => {
      windBotOffset = parseInt(botOffsetSlider.value);
      document.getElementById("windBotOffsetLabel").textContent = windBotOffset + "px";
      localStorage.setItem("windBotOffset", windBotOffset);
      renderWindReadings();
    });
  }

  const checks = [
    ["showWindMph",   v => showWindMph = v,   "showWindMph"],
    ["showWindKph",   v => showWindKph = v,   "showWindKph"],
    ["showWindKnots", v => showWindKnots = v, "showWindKnots"],
    ["showWindDir",   v => showWindDir = v,   "showWindDir"],
  ];
  checks.forEach(([id, setter, key]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => {
      setter(el.checked);
      localStorage.setItem(key, el.checked ? "1" : "0");
      renderWindReadings();
      refreshRadarOverlay();
    });
  });
}

function makeSettingsPanelsDraggable() {
  document.querySelectorAll(".widgetSettingsPanel").forEach(panel => {
    const header = panel.querySelector(".settingsHeader");
    if (!header) return;

    const btn = document.createElement("button");
    btn.className = "settingsDragBtn";
    btn.title = "Pop out / dock";
    btn.textContent = "⎋";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const detaching = !panel.classList.contains("is-detached");

      if (detaching) {
        /* move panel to body so it escapes widget stacking context */
        const rect = panel.getBoundingClientRect();
        document.body.appendChild(panel);
        panel.style.position = "fixed";
        panel.style.left = rect.left + "px";
        panel.style.top = rect.top + "px";
        panel.style.right = "auto";
        panel.style.width = "260px";
        panel.style.maxHeight = "80vh";
        panel.style.zIndex = "99999";
        panel.style.display = "block";
        panel.classList.add("is-detached");
        btn.textContent = "⊡";
      } else {
        /* dock it back — find its widget and re-attach */
        const widgetId = panel.dataset.settingsFor;
        const widget = document.querySelector(`[data-widget="${widgetId}"]`);
        if (widget) {
          widget.appendChild(panel);
          panel.style.position = "";
          panel.style.left = "";
          panel.style.top = "";
          panel.style.right = "";
          panel.style.width = "";
          panel.style.maxHeight = "";
          panel.style.zIndex = "";
        }
        panel.classList.remove("is-detached");
        btn.textContent = "⎋";
      }
    });
    header.appendChild(btn);

    /* drag logic */
    let dragging = false;
    let ox = 0, oy = 0;

    header.addEventListener("mousedown", (e) => {
      if (!panel.classList.contains("is-detached")) return;
      if (e.target === btn) return;
      dragging = true;
      ox = e.clientX - panel.getBoundingClientRect().left;
      oy = e.clientY - panel.getBoundingClientRect().top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - ox) + "px";
      panel.style.top = (e.clientY - oy) + "px";
    });

    document.addEventListener("mouseup", () => { dragging = false; });
  });
}




/* Draw compass ring, arrow and wind info onto the radar overlay canvas */
function refreshRadarOverlay() {
  if (compassMapMode !== "radar") return;
  const canvas = document.getElementById("radarOverlayCanvas");
  if (canvas) drawRadarCompassOverlay(canvas);
}

function drawRadarCompassOverlay(canvas) {
  if (!canvas) return;
  const W   = canvas.width;
  const H   = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const cx  = W / 2;
  const cy  = H / 2;
  const r   = Math.min(W, H) * 0.28;  /* smaller ring */
  const deg = lastWindDeg || 0;
  const rad = (deg - 90) * Math.PI / 180;

  /* ── Ring ── */
  if (compassStyle !== "none") {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(10, 25, 40, 0.85)";
    ctx.lineWidth   = 9;
    ctx.stroke();
    ctx.strokeStyle = "rgba(160, 220, 255, 0.90)";
    ctx.lineWidth   = 3;
    ctx.stroke();
    ctx.restore();

    if (compassStyle === "crosshair") {
      ctx.save();
      ctx.strokeStyle = "rgba(160,220,255,0.4)";
      ctx.lineWidth   = 1.5;
      ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
      ctx.restore();
    }

    /* Cardinal letters just outside the ring */
    const cardinals = [["N",0],["E",90],["S",180],["W",270]];
    ctx.save();
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    cardinals.forEach(([ltr, a]) => {
      const cr  = (a - 90) * Math.PI / 180;
      const lx  = cx + Math.cos(cr) * (r + 16);
      const ly  = cy + Math.sin(cr) * (r + 16);
      ctx.shadowColor = "rgba(0,0,0,0.95)";
      ctx.shadowBlur  = 5;
      ctx.fillStyle   = "#ffffff";
      ctx.fillText(ltr, lx, ly);
    });
    ctx.restore();
  }

  /* ── Arrow: starts at center, arrowhead at tip ── */
  const arrowColor = "#ff8060";
  const arrowLen   = r * 0.88;
  const tipX  = cx + Math.cos(rad) * arrowLen;
  const tipY  = cy + Math.sin(rad) * arrowLen;
  const hLen  = 16;
  const hAng  = 0.40;

  ctx.save();
  ctx.shadowColor = "rgba(255,110,70,0.7)";
  ctx.shadowBlur  = 10;

  /* Shaft — stop short of tip so arrowhead sits cleanly at end */
  ctx.strokeStyle = arrowColor;
  ctx.lineWidth   = 4;
  ctx.lineCap     = "round";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(tipX - Math.cos(rad) * hLen * 0.6, tipY - Math.sin(rad) * hLen * 0.6);
  ctx.stroke();

  /* Arrowhead at the very tip — same color as shaft */
  ctx.fillStyle = arrowColor;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - hLen*Math.cos(rad-hAng), tipY - hLen*Math.sin(rad-hAng));
  ctx.lineTo(tipX - hLen*Math.cos(rad+hAng), tipY - hLen*Math.sin(rad+hAng));
  ctx.closePath();
  ctx.fill();

  /* Center dot */
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI*2);
  ctx.fillStyle = arrowColor;
  ctx.fill();
  ctx.restore();

  /* ── Wind info pill — bottom left of widget ── */
  const mph   = lastWindMph || 0;
  const kph   = Math.round(mph * 1.60934);
  const knots = Math.round(mph * 0.868976);
  const dir   = degToCompass(deg);

  const parts = [];
  if (showWindMph)   parts.push(mph + " mph");
  if (showWindKph)   parts.push(kph + " kph");
  if (showWindKnots) parts.push(knots + " kts");
  if (showWindDir)   parts.push(dir + "  " + deg + "°");

  if (parts.length) {
    ctx.save();
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    const lineH = 24;
    const padX  = 12;
    const padY  = 8;
    const boxW  = Math.max(...parts.map(p => ctx.measureText(p).width)) + padX * 2;
    const boxH  = parts.length * lineH + padY * 2;
    const boxX  = 12;
    const boxY  = H - boxH - 12;

    ctx.fillStyle = "rgba(5,15,25,0.82)";
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(160,220,255,0.3)";
    ctx.lineWidth   = 1;
    ctx.stroke();

    ctx.fillStyle = "#d0ecff";
    parts.forEach((p, i) => {
      ctx.fillText(p, boxX + padX, boxY + padY + lineH * (i + 0.5));
    });
    ctx.restore();
  }
}

async function geocodeMarineAddress(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;

    const res = await fetch(url, {
      headers: { "Accept-Language": "en" }
    });
    const data = await res.json();

    if (data && data.length > 0) {
      marineLocationLat = parseFloat(data[0].lat);
      marineLocationLon = parseFloat(data[0].lon);

      localStorage.setItem("marineLocationLat", marineLocationLat);
      localStorage.setItem("marineLocationLon", marineLocationLon);
      localStorage.setItem("marineLocationAddress", address);

      updateCompassMap();
    } else {
      alert("Address not found — try being more specific, e.g. '111 Avenida Menendez, St Augustine FL'");
    }
  } catch (err) {
    console.error("Geocode error:", err);
  }
}


/* cache last weather data so mobile drag can re-render without a fetch */
let _lastWeatherData = null;

/* Mobile weekly drag offset (index into daily array) */
let weeklyDragOffset = 0;
const WEEKLY_VISIBLE_DAYS = 3;

/* forecastScrollPx is managed by touch handler; expose so renderWeather can use it */
let _forecastScrollPx = 0;

function setForecastTranslate(px) {
  const wrap = document.getElementById("forecast");
  if (wrap) wrap.style.transform = `translateX(${-px}px)`;
}

function renderWeather(data) {
  if (data) _lastWeatherData = data;
  const d = _lastWeatherData;
  const wrap = document.getElementById("forecast");
  if (!wrap || !d) return;

  /* Only rebuild the DOM when data actually changes, not on every scroll */
  const dataKey = weatherViewMode + JSON.stringify(d.daily?.time?.slice(0,3));
  if (wrap.dataset.renderedKey === dataKey && data === null) {
    /* Just update the translate — no DOM rebuild needed */
    setForecastTranslate(_forecastScrollPx);
    return;
  }
  wrap.dataset.renderedKey = dataKey;
  wrap.innerHTML = "";
  _forecastScrollPx = 0;
  wrap.style.transform = "translateX(0)";

  if (weatherViewMode === "weekly") {
    const totalDays = d.daily.time.length;
    const now2 = new Date();
    const localToday = `${now2.getFullYear()}-${String(now2.getMonth()+1).padStart(2,"0")}-${String(now2.getDate()).padStart(2,"0")}`;
    const todayIdx = Math.max(0, d.daily.time.findIndex(t => t >= localToday));

    /* Render ALL days from today */
    for (let n = 0; n < totalDays - todayIdx; n++) {
      const i = todayIdx + n;
      if (i >= totalDays) break;
      const card = document.createElement("div");
      card.className = "card weekly";
      const code = d.daily.weathercode[i];
      card.classList.add(getWeatherClass(code, false));
      card.innerHTML = `
        <div class="hour">${formatWeekday(d.daily.time[i])}</div>
        <div class="tempF">${Math.round(d.daily.temperature_2m_max[i])}°</div>
        <div class="tempC">Low ${Math.round(d.daily.temperature_2m_min[i])}°</div>
        <div class="rain">${Math.round(d.daily.precipitation_probability_max[i])}% Rain</div>
        <div class="windMini">${Math.round(d.daily.windspeed_10m_max[i])} mph</div>
      `;
      wrap.appendChild(card);
    }
    return;
  }

  /* --- Hourly: render ALL hours from current hour forward --- */
  const now = new Date();
  /* Build a local datetime string to compare (avoids UTC offset issues) */
  const padZ = n => String(n).padStart(2, "0");
  const localNowStr = `${now.getFullYear()}-${padZ(now.getMonth()+1)}-${padZ(now.getDate())}T${padZ(now.getHours())}`;
  /* Find first slot whose time string starts with today or later at this hour */
  let startIndex = d.hourly.time.findIndex(t => t >= localNowStr);
  if (startIndex < 0) startIndex = 0;

  for (let n = 0; n < WEATHER_HOURS; n++) {
    const i = startIndex + n;
    if (i >= d.hourly.time.length) break;
    const code     = d.hourly.weathercode[i];
    const hourText = formatHour(d.hourly.time[i]);
    const rain  = Math.round(d.hourly.precipitation_probability[i]);
    const wind  = Math.round(d.hourly.windspeed_10m[i]);
    const temp  = Math.round(d.hourly.temperature_2m[i]);
    const humid = Math.round(d.hourly.relative_humidity_2m[i]);

    /* Per-field alerts */
    const heatAlert = fcHeatAlertOn && temp >= HEAT_ALERT_F;
    const coldAlert = fcColdAlertOn && temp <= fcColdAlertVal;
    const rainAlert = fcRainAlertOn && rain >= fcRainAlertVal;
    const windAlert = fcWindAlertOn && wind >= WIND_ALERT_MPH;
    const anyAlert  = heatAlert || coldAlert || rainAlert || windAlert;

    let tempClass = "";
    if (heatAlert) tempClass = "danger";
    else if (coldAlert) tempClass = "cold-alert";

    const card = document.createElement("div");
    card.className = "card";
    card.classList.add(getWeatherClass(code, isNightHour(d.hourly.time[i])));

    const tempEl      = fcShowTemp      ? `<div class="tempF ${tempClass}">${temp}°${coldAlert ? " ❄" : ""}</div>` : "";
    const humidEl     = fcShowHumidity  ? `<div class="humidity">${humid}% Humidity</div>` : "";
    const rainEl      = fcShowRain      ? `<div class="rain ${rainAlert ? "danger" : ""}">${rain}% Rain</div>` : "";
    const windEl      = fcShowWind      ? `<div class="windMini ${windAlert ? "danger" : ""}">${wind} mph</div>` : "";
    const conditionEl = fcShowCondition ? `<div class="dirMini">${weatherText(code)}</div>` : "";
    const alertEl     = anyAlert        ? `<div class="boxAlert">!</div>` : "";

    card.innerHTML = `
      <div class="hour">${hourText}</div>
      ${tempEl}${humidEl}${rainEl}${windEl}${conditionEl}${alertEl}
    `;
    wrap.appendChild(card);
  }
}

function getWeatherClass(code, night) {
  if (night) return "weather-night";

  if ([95, 96, 99].includes(code)) return "weather-stormy";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "weather-rainy";
  if ([1, 2].includes(code)) return "weather-partly";
  if ([3, 45, 48].includes(code)) return "weather-cloudy";

  return "weather-sunny";
}

function weatherText(code) {
  if ([95, 96, 99].includes(code)) return "Storm";
  if ([51,53,55,61,63,65,80,81,82].includes(code)) return "Rain";
  if ([3,45,48].includes(code)) return "Cloudy";
  if ([1,2].includes(code)) return "Partly";
  return "Clear";
}

function isNightHour(iso) {
  const h = new Date(iso).getHours();
  return h < 6 || h > 19;
}

/* ==========================================================================
   TIDES
   ========================================================================== */
async function loadTides() {
  if (!selectedStation) return;

  try {
    let queryParams;

    if (tideViewMode === "live") {
      const now = new Date();
      const start = new Date(now.getTime() - LIVE_LINE_OFFSET_MINUTES * 60 * 1000);

      queryParams =
        `?product=predictions` +
        `&application=marine_dashboard` +
        `&begin_date=${encodeURIComponent(formatNoaaDate(start))}` +
        `&range=${TIDE_WINDOW_HOURS}` +
        `&station=${selectedStation.id}` +
        `&datum=MLLW` +
        `&time_zone=lst_ldt` +
        `&interval=6` +
        `&units=english` +
        `&format=json`;
    } else {
      const start = new Date(`${selectedTideDate}T00:00:00`);

      queryParams =
        `?product=predictions` +
        `&application=marine_dashboard` +
        `&begin_date=${encodeURIComponent(formatNoaaDate(start))}` +
        `&range=24` +
        `&station=${selectedStation.id}` +
        `&datum=MLLW` +
        `&time_zone=lst_ldt` +
        `&interval=6` +
        `&units=english` +
        `&format=json`;
    }

    const url = `${NOAA_PROXY}${queryParams}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tide request failed: ${res.status}`);

    const data = await res.json();
    if (!data.predictions || !data.predictions.length) return;

    tidePredictions = data.predictions.map((p) => ({
      time: p.t,
      timeMs: new Date(p.t.replace(" ", "T")).getTime(),
      value: parseFloat(p.v)
    }));

    drawTide(tidePredictions);
  } catch (err) {
    console.error("Tide error:", err);
  }
}

function updateTideStatus() {
  const current = document.getElementById("currentTide");
  const alert = document.getElementById("lowTideAlert");

  if (!current || !alert || !tidePredictions.length) return;

  const now = Date.now();
  const nearest = tidePredictions.reduce((a, b) =>
    Math.abs(a.timeMs - now) < Math.abs(b.timeMs - now) ? a : b
  );

  current.textContent =
    `${nearest.type === "H" ? "High" : "Low"} Tide ${nearest.value.toFixed(1)} ft at ${formatHour(nearest.time)}`;

  if (nearest.type === "L" && nearest.value <= LOW_TIDE_ALERT_FT) {
    alert.textContent = "LOW WATER ALERT";
  } else {
    alert.textContent = "";
  }
}

function drawTide(series) {
  const c            = document.getElementById("tideChart");
  const htmlLine     = document.getElementById("tideLine");
  const currentTideEl   = document.getElementById("currentTide");
  const lowTideAlertEl  = document.getElementById("lowTideAlert");

  if (!c || !series.length) return;

  /* On mobile the canvas may not be laid out yet — retry after a frame */
  const cW = c.offsetWidth  || c.parentElement?.offsetWidth  || 360;
  const cH = c.offsetHeight || c.parentElement?.offsetHeight || 200;
  if (cW < 10 || cH < 10) {
    setTimeout(() => drawTide(series), 100);
    return;
  }

  const ctx = c.getContext("2d");
  c.width  = cW;
  c.height = cH;
  ctx.clearRect(0, 0, c.width, c.height);

  const metrics = getTideChartMetrics(c);
  const { startMs, endMs, leftPad, rightPad, topPad, bottomPad, chartW, chartH } = metrics;

  /* The "now" line always tracks real current time */
  const nowMs      = getDefaultTideLineTime();
  const nowValue   = getTideAtTime(series, nowMs);

  /* Pre-compute value range across ALL series data (not just visible)
     so the y-scale stays stable while dragging */
  const allValues  = series.map(d => d.value);
  const rawMin     = Math.min(...allValues);
  const rawMax     = Math.max(...allValues);
  const rawRange   = Math.max(0.1, rawMax - rawMin);
  const paddedMin  = rawMin - rawRange * 0.12;
  const paddedMax  = rawMax + rawRange * 0.12;
  const range      = Math.max(0.1, paddedMax - paddedMin);

  const xForTime = (ms) => leftPad + clamp((ms - startMs) / (endMs - startMs), 0, 1) * chartW;
  const yForVal  = (v)  => topPad + chartH - ((v - paddedMin) / range) * chartH;

  /* ── CLIP everything to chart area ───────────────────────────────── */
  ctx.save();
  ctx.beginPath();
  ctx.rect(leftPad, 0, chartW, c.height);
  ctx.clip();

  /* Grid lines */
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = topPad + (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(leftPad, y);
    ctx.lineTo(leftPad + chartW, y);
    ctx.stroke();
  }

  /* Tide curve — only draw points near/within the visible window.
     Include one point before startMs and one after endMs so the curve
     enters/exits the clip region smoothly rather than starting abruptly. */
  const margin = (endMs - startMs) * 0.15; /* 15% buffer outside window */
  const visibleSeries = series.filter(pt =>
    pt.timeMs >= startMs - margin && pt.timeMs <= endMs + margin
  );

  if (visibleSeries.length > 1) {
    ctx.beginPath();
    visibleSeries.forEach((pt, i) => {
      const x = leftPad + ((pt.timeMs - startMs) / (endMs - startMs)) * chartW;
      const y = yForVal(pt.value);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = "#7be8ff";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  /* Hour tick labels and ft values — only for points in visible window */
  let lastLabeledHour = null;
  ctx.font = "13px Arial";

  for (const pt of series) {
    if (pt.timeMs < startMs || pt.timeMs > endMs) continue;
    const dt  = new Date(pt.timeMs);
    const key = `${dt.getMonth()}-${dt.getDate()}-${dt.getHours()}`;
    if (dt.getMinutes() !== 0 || key === lastLabeledHour) continue;
    lastLabeledHour = key;

    const x = xForTime(pt.timeMs);
    const y = yForVal(pt.value);

    /* time label at bottom */
    ctx.fillStyle   = "rgba(255,255,255,0.80)";
    ctx.textAlign   = "center";
    ctx.fillText(
      dt.toLocaleTimeString([], { hour: "numeric", hour12: true }),
      x, c.height - 6
    );

    /* ft value near the curve */
    ctx.fillStyle = "#9ee8ff";
    ctx.fillText(`${pt.value.toFixed(1)}ft`, x, y - 10);
  }

  /* Slack point labels (High / Low) — clipped, centered */
  const rawSlackPoints = findSlackPoints(series);
  const slackPoints    = [];
  const minGapMs       = 90 * 60 * 1000;
  for (const pt of rawSlackPoints) {
    const prev = slackPoints[slackPoints.length - 1];
    if (!prev || prev.kind !== pt.kind || Math.abs(pt.timeMs - prev.timeMs) > minGapMs) {
      slackPoints.push(pt);
    } else {
      if (pt.kind === "high" && pt.value > prev.value) slackPoints[slackPoints.length - 1] = pt;
      if (pt.kind === "low"  && pt.value < prev.value) slackPoints[slackPoints.length - 1] = pt;
    }
  }

  ctx.textAlign = "center";
  slackPoints.forEach(pt => {
    if (pt.timeMs < startMs || pt.timeMs > endMs) return;
    const x = xForTime(pt.timeMs);
    const y = yForVal(pt.value);

    /* tick mark */
    ctx.strokeStyle = "#ff8a8a";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(x - 10, y);
    ctx.lineTo(x + 10, y);
    ctx.stroke();

    /* label */
    ctx.fillStyle = "#ff9a9a";
    ctx.font      = "bold 12px Arial";
    ctx.fillText(pt.kind === "high" ? "High" : "Low", x, y - 18);

    ctx.fillStyle = "#ffffff";
    ctx.font      = "11px Arial";
    ctx.fillText(
      new Date(pt.timeMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }),
      x, y + 14
    );
  });

  ctx.restore(); /* end clip region */

  /* ── NOW LINE — always drawn, always visible ─────────────────────── */
  const nowX = xForTime(nowMs);
  /* only draw if current time is within visible window */
  const nowInView = nowMs >= startMs && nowMs <= endMs;

  if (nowInView && nowValue != null) {
    const nowY = yForVal(nowValue);

    /* vertical red line */
    ctx.save();
    ctx.strokeStyle = "#ff6f61";
    ctx.lineWidth   = 2;
    ctx.shadowColor = "rgba(255,111,97,0.5)";
    ctx.shadowBlur  = 6;
    ctx.beginPath();
    ctx.moveTo(nowX, topPad);
    ctx.lineTo(nowX, topPad + chartH);
    ctx.stroke();
    ctx.restore();

    /* dot on the curve */
    ctx.beginPath();
    ctx.arc(nowX, nowY, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ff6f61";
    ctx.fill();

    /* readout pill above the line */
    const label    = formatTideReadout(nowMs, nowValue);
    ctx.font       = "bold 13px Arial";
    const tw       = ctx.measureText(label).width;
    const pillW    = tw + 16;
    const pillH    = 22;
    const pillX    = clamp(nowX - pillW / 2, leftPad + 2, leftPad + chartW - pillW - 2);
    const pillY    = topPad + 4;

    ctx.fillStyle  = "rgba(20,40,55,0.92)";
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, 6);
    ctx.fill();

    ctx.strokeStyle = "rgba(255,111,97,0.7)";
    ctx.lineWidth   = 1;
    ctx.stroke();

    ctx.fillStyle  = "#ff9a8a";
    ctx.textAlign  = "center";
    ctx.fillText(label, pillX + pillW / 2, pillY + 15);
  }

  /* ── SCRUB LINE — shown during long-press drag ───────────────────── */
  if (tideDragging && tideScrubTimeMs != null) {
    const scrubValue = getTideAtTime(series, tideScrubTimeMs);
    const scrubX     = xForTime(tideScrubTimeMs);
    const scrubY     = scrubValue != null ? yForVal(scrubValue) : topPad + chartH / 2;

    /* yellow vertical line */
    ctx.save();
    ctx.strokeStyle = "#ffd166";
    ctx.lineWidth   = 2;
    ctx.shadowColor = "rgba(255,209,102,0.5)";
    ctx.shadowBlur  = 6;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(scrubX, topPad);
    ctx.lineTo(scrubX, topPad + chartH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    /* dot */
    ctx.beginPath();
    ctx.arc(scrubX, scrubY, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd166";
    ctx.fill();

    /* readout pill */
    if (scrubValue != null) {
      const scrubLabel = formatTideReadout(tideScrubTimeMs, scrubValue);
      ctx.font         = "bold 13px Arial";
      const stw        = ctx.measureText(scrubLabel).width;
      const spW        = stw + 16;
      const spH        = 22;
      const spX        = clamp(scrubX - spW / 2, leftPad + 2, leftPad + chartW - spW - 2);
      const spY        = topPad + 30; /* below the now-line pill */

      ctx.fillStyle    = "rgba(20,40,55,0.95)";
      ctx.beginPath();
      ctx.roundRect(spX, spY, spW, spH, 6);
      ctx.fill();

      ctx.strokeStyle  = "rgba(255,209,102,0.7)";
      ctx.lineWidth    = 1;
      ctx.stroke();

      ctx.fillStyle    = "#ffd166";
      ctx.textAlign    = "center";
      ctx.fillText(scrubLabel, spX + spW / 2, spY + 15);
    }
  }

  /* Hide the HTML line element — we draw on canvas */
  if (htmlLine) htmlLine.style.display = "none";

  /* Hide old readout div */
  const readoutEl = document.getElementById("tideReadout");
  if (readoutEl) readoutEl.style.display = "none";

  /* ── Update status text ───────────────────────────────────────────── */
  if (nowValue != null) {
    if (currentTideEl) {
      if (tideViewMode === "live") {
        currentTideEl.innerText =
          `Tide now at ${selectedStation.name}: ${nowValue > 0 ? "+" : ""}${nowValue.toFixed(2)} ft`;
      } else {
        currentTideEl.innerText =
          `Tide for ${selectedTideDate} at ${selectedStation.name}: ${formatTideReadout(nowMs, nowValue)}`;
      }
    }
    const tideIsLow  = tideChartLowAlertOn  && nowValue <= LOW_TIDE_ALERT_FT;
    const tideIsHigh = tideChartHighAlertOn && nowValue >= HIGH_TIDE_ALERT_FT;
    const tideAlert  = tideIsLow || tideIsHigh;
    if (currentTideEl) currentTideEl.style.color = (tideStatusColorAlert && tideAlert) ? "#ff6a6a" : "#dff6ff";
    if (lowTideAlertEl) lowTideAlertEl.textContent = tideIsLow  ? "⚠ LOW TIDE"  :
                                                       tideIsHigh ? "⚠ HIGH TIDE" : "";
  } else {
    if (currentTideEl) {
      currentTideEl.innerText   = "";
      currentTideEl.style.color = "#dff6ff";
    }
    if (lowTideAlertEl) lowTideAlertEl.textContent = "";
  }
}
function setupTideInteraction() {
  const canvas = document.getElementById("tideChart");
  if (!canvas) return;

  if (isMobile()) {
    /* ---------------------------------------------------------------
       MOBILE touch:
       • Short drag  → pan the visible 3-hour window
       • Tap         → snap back to current time
       • Long press (≥400ms, no movement) → show yellow scrub line;
         drag while holding to move it; release to dismiss
    --------------------------------------------------------------- */
    let touchStartX      = null;
    let touchStartOffset = null;
    let mode             = null;   /* null | "pan" | "scrub" */
    let holdTimer        = null;
    const PAN_PX         = 8;
    const HOLD_MS        = 400;

    const scrubFromClientX = (clientX) => {
      const metrics = getTideChartMetrics(canvas);
      const rect    = canvas.getBoundingClientRect();
      const rawX    = (clientX - rect.left) * (canvas.width / (rect.width || 1));
      const cx      = clamp(rawX, metrics.leftPad, canvas.width - metrics.rightPad);
      const pct     = (cx - metrics.leftPad) / metrics.chartW;
      tideScrubTimeMs = metrics.startMs + pct * (metrics.endMs - metrics.startMs);
      drawTide(tidePredictions);
    };

    canvas.addEventListener("touchstart", (e) => {
      if (layoutEditMode || !tidePredictions.length) return;
      e.preventDefault();
      touchStartX      = e.touches[0].clientX;
      touchStartOffset = tideViewOffsetMs;
      mode             = null;
      tideDragging     = false;

      holdTimer = setTimeout(() => {
        if (mode === null) {
          mode         = "scrub";
          tideDragging = true;
          scrubFromClientX(touchStartX);
        }
      }, HOLD_MS);
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
      if (touchStartX === null || layoutEditMode || !tidePredictions.length) return;
      const dx = e.touches[0].clientX - touchStartX;

      if (mode === "scrub") {
        scrubFromClientX(e.touches[0].clientX);
      } else if (mode === "pan" || Math.abs(dx) > PAN_PX) {
        if (mode === null) {
          clearTimeout(holdTimer);
          holdTimer = null;
          mode = "pan";
        }
        const visibleMs = getTideVisibleHours() * 3600 * 1000;
        const msPerPx   = visibleMs / (canvas.offsetWidth || 1);
        const firstMs   = tidePredictions[0].timeMs;
        const lastMs    = tidePredictions[tidePredictions.length - 1].timeMs;
        const maxOffset = Math.max(0, (lastMs - firstMs) - visibleMs);
        tideViewOffsetMs = clamp(touchStartOffset - dx * msPerPx, 0, maxOffset);
        drawTide(tidePredictions);
      }
    }, { passive: true });

    canvas.addEventListener("touchend", () => {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (mode === "scrub") {
        tideDragging    = false;
        tideScrubTimeMs = null;
        drawTide(tidePredictions);
      } else if (mode === null) {
        /* pure tap — snap to current time */
        tideViewOffsetMs = 0;
        drawTide(tidePredictions);
      }
      mode        = null;
      touchStartX = null;
    });

  } else {
    /* ---------------------------------------------------------------
       DESKTOP: mouse click-drag to scrub (unchanged behaviour)
    --------------------------------------------------------------- */
    const scrubFromClientX = (clientX) => {
      if (!tidePredictions.length) return;
      const metrics = getTideChartMetrics(canvas);
      const rect    = canvas.getBoundingClientRect();
      const scaleX  = rect.width ? canvas.width / rect.width : 1;
      const rawX    = (clientX - rect.left) * scaleX;
      const cx      = clamp(rawX, metrics.leftPad, canvas.width - metrics.rightPad);
      const pct     = (cx - metrics.leftPad) / metrics.chartW;
      tideScrubTimeMs = metrics.startMs + pct * (metrics.endMs - metrics.startMs);
      drawTide(tidePredictions);
    };

    canvas.addEventListener("mousedown", (e) => {
      if (layoutEditMode || e.button !== 0 || !tidePredictions.length) return;
      tideDragging = true;
      scrubFromClientX(e.clientX);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup",   onUp);
    });

    function onMove(e) { if (tideDragging) scrubFromClientX(e.clientX); }

    function onUp() {
      tideDragging    = false;
      tideScrubTimeMs = null;
      drawTide(tidePredictions);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup",   onUp);
    }
  }
}
/* ==========================================================================
   HELPERS
   ========================================================================== */
function ensureTideReadout() {
  const panel = document.querySelector("#tideChartWidget .tidePanel");
  if (!panel) return null;

  let el = document.getElementById("tideReadout");
  if (!el) {
    el = document.createElement("div");
    el.id = "tideReadout";
    panel.appendChild(el);
  }
  return el;
}

function getTideChartMetrics(canvas) {
  /* On mobile use tighter padding so the chart fills edge-to-edge */
  const leftPad   = isMobile() ? 4  : 36;
  const rightPad  = isMobile() ? 4  : 20;
  const topPad    = isMobile() ? 6  : 28; /* minimal top — pill floats inside chart */
  const bottomPad = isMobile() ? 20 : 34;
  const chartW = canvas.width - leftPad - rightPad;
  const chartH = canvas.height - topPad - bottomPad;

  const firstMs = tidePredictions[0]?.timeMs ?? Date.now();
  const lastMs  = tidePredictions[tidePredictions.length - 1]?.timeMs ?? Date.now() + 1;

  let startMs, endMs;

  if (isMobile()) {
    /* on mobile, show only a TIDE_VISIBLE_HOURS window, offset by drag */
    const visibleMs = getTideVisibleHours() * 3600 * 1000;
    startMs = firstMs + tideViewOffsetMs;
    endMs   = startMs + visibleMs;
    /* clamp so we don't go past the data */
    if (endMs > lastMs) {
      endMs   = lastMs;
      startMs = Math.max(firstMs, endMs - visibleMs);
    }
  } else {
    startMs = firstMs;
    endMs   = lastMs;
  }

  return { startMs, endMs, leftPad, rightPad, topPad, bottomPad, chartW, chartH };
}

function getDefaultTideLineTime() {
  if (tideViewMode === "live") {
    return Date.now();
  }

  if (tidePredictions.length) {
    return tidePredictions[0].timeMs;
  }

  return Date.now();
}

function formatTideReadout(timeMs, value) {
  return `${new Date(timeMs).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  })} • ${value > 0 ? "+" : ""}${value.toFixed(2)} ft`;
}

function findSlackPoints(series) {
  const points = [];

  for (let i = 1; i < series.length - 1; i++) {
    const prev = series[i - 1].value;
    const curr = series[i].value;
    const next = series[i + 1].value;

    const isHigh = curr >= prev && curr >= next && (curr > prev || curr > next);
    const isLow = curr <= prev && curr <= next && (curr < prev || curr < next);

    if (isHigh) {
      points.push({ ...series[i], kind: "high" });
    } else if (isLow) {
      points.push({ ...series[i], kind: "low" });
    }
  }

  return points;
}

function getTideAtTime(series, targetMs) {
  if (!series.length) return null;
  if (series.length === 1) return series[0].value;

  if (targetMs <= series[0].timeMs) return series[0].value;
  if (targetMs >= series[series.length - 1].timeMs) return series[series.length - 1].value;

  for (let i = 0; i < series.length - 1; i++) {
    const a = series[i];
    const b = series[i + 1];

    if (targetMs >= a.timeMs && targetMs <= b.timeMs) {
      const span = b.timeMs - a.timeMs;
      const pct = span === 0 ? 0 : (targetMs - a.timeMs) / span;
      return a.value + (b.value - a.value) * pct;
    }
  }

  return null;
}

async function refreshAll() {
  await Promise.allSettled([loadWeather(), loadTides()]);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

function degToCompass(deg) {
  const dirs = [
    "N","NNE","NE","ENE",
    "E","ESE","SE","SSE",
    "S","SSW","SW","WSW",
    "W","WNW","NW","NNW"
  ];

  return dirs[Math.round(deg / 22.5) % 16];
}

function formatNoaaDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");

  return `${y}${m}${d} ${hh}:${mm}`;
}

function formatHour(iso) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    hour12: true
  });
}

function formatWeekday(iso) {
  return new Date(iso).toLocaleDateString([], {
    weekday: "short"
  });
}

function shadeColor(hex, amt) {
  const col = hex.replace("#", "");
  let num = parseInt(col, 16);

  let r = (num >> 16) + amt;
  let g = ((num >> 8) & 0x00FF) + amt;
  let b = (num & 0x0000FF) + amt;

  r = clamp(r, 0, 255);
  g = clamp(g, 0, 255);
  b = clamp(b, 0, 255);

  return "#" + (
    (1 << 24) +
    (r << 16) +
    (g << 8) +
    b
  ).toString(16).slice(1);
}

function shiftHue(hex, degree) {
  const c = hexToRgb(hex);
  const hsl = rgbToHsl(c.r, c.g, c.b);

  hsl.h = (hsl.h + degree) % 360;

  const rgb = hslToRgb(hsl.h, hsl.s, hsl.l);

  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/* ==========================================================================
   RADAR CENTER-ON-VESSEL BUTTON
   Lets the player snap the radar view to their Oregon Sail boat's
   current position instead of the saved home address. Purely a
   display override — doesn't touch the saved address setting.
   ========================================================================== */
function updateRadarCenterBtnVisibility() {
  const btn = document.getElementById("osRadarCenterBtn");
  if (!btn) return;
  const hasBoat = typeof window.OS !== "undefined" && window.OS.boat;
  btn.style.display = (compassMapMode === "radar" && hasBoat) ? "flex" : "none";
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("osRadarCenterBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (typeof window.OS === "undefined" || !window.OS.boat) return;
    const estimated = window.OS.estimateLiveLatLon(window.OS.boat, 4.5);
    window.radarCenterOverride = { lat: estimated.lat, lon: estimated.lon };
    updateCompassMap();
    setTimeout(refreshRadarOverlay, 100);
  });
});

/* ==========================================================================
   SATELLITE COMPASS
   ========================================================================== */
function updateCompassMap() {
  const canvas   = document.getElementById("compassMapCanvas");
  const iframe   = document.getElementById("radarIframe");
  if (!canvas) return;

  stopRadarAnimation();

  /* Helper: hide iframe */
  function hideIframe() {
    if (iframe) { iframe.style.display = "none"; iframe.src = ""; }
  }

  /* ── NONE ── */
  if (compassMapMode === "none") {
    canvas.style.display = "none";
    hideIframe();
    return;
  }

  /* ── RADAR: RainViewer iframe fills the entire widget ── */
  if (compassMapMode === "radar") {
    canvas.style.display = "none";
    if (!iframe) return;

    const widgetEl2 = document.getElementById("windWidget");
    if (!widgetEl2) return;

    /* Make sure the widget has position:relative so absolute children work */
    widgetEl2.style.position = "relative";
    widgetEl2.style.overflow = "hidden";

    /* Move iframe directly into the widget (not widgetFrame) */
    if (iframe.parentElement !== widgetEl2) widgetEl2.appendChild(iframe);

    /* If the player tapped "center on vessel", that takes priority.
       Otherwise: saved address location, then geolocation, then default. */
    const savedLat = parseFloat(localStorage.getItem("marineLocationLat"));
    const savedLon = parseFloat(localStorage.getItem("marineLocationLon"));
    const lat  = (window.radarCenterOverride ? window.radarCenterOverride.lat :
                  (marineLocationLat != null ? marineLocationLat :
                  (!isNaN(savedLat)  ? savedLat  :
                  (userLat           ? userLat   : 29.9))));
    const lon  = (window.radarCenterOverride ? window.radarCenterOverride.lon :
                  (marineLocationLon != null ? marineLocationLon :
                  (!isNaN(savedLon)  ? savedLon  :
                  (userLon           ? userLon   : -81.3))));
    const zoom = Math.max(2, Math.min(compassZoom, 14));

    const newSrc = "https://www.rainviewer.com/map.html?loc=" +
      lat.toFixed(5) + "," + lon.toFixed(5) + "," + zoom +
      "&oFa=0&oC=0&oU=0&oCS=1&oF=0&oAP=1&rmt=4&mwr=1&ext=1&layer=radar&sm=1&sn=1";

    if (iframe.src !== newSrc) iframe.src = newSrc;
    iframe.style.cssText = "display:block;position:absolute;top:0;left:0;width:100%;height:100%;border:none;border-radius:inherit;z-index:10;";

    /* ── Canvas overlay: ring, arrow, wind readings on top of radar ── */
    let radarOverlay = document.getElementById("radarOverlayCanvas");
    if (!radarOverlay) {
      radarOverlay = document.createElement("canvas");
      radarOverlay.id = "radarOverlayCanvas";
      radarOverlay.style.cssText = "pointer-events:none;position:absolute;top:0;left:0;z-index:20;";
      widgetEl2.appendChild(radarOverlay);
    }
    radarOverlay.style.display = "block";
    radarOverlay.width  = widgetEl2.offsetWidth;
    radarOverlay.height = widgetEl2.offsetHeight;
    radarOverlay.style.width  = widgetEl2.offsetWidth  + "px";
    radarOverlay.style.height = widgetEl2.offsetHeight + "px";
    drawRadarCompassOverlay(radarOverlay);
    return;
  }

  /* Hide radar overlay when leaving radar mode */
  const existingOverlay = document.getElementById("radarOverlayCanvas");
  if (existingOverlay) existingOverlay.style.display = "none";

  /* ── SATELLITE MODES: hide iframe, draw canvas ── */
  hideIframe();
  if (!marineLocationLat || !marineLocationLon) return;
  canvas.style.display = "block";

  if (compassMapMode === "widget") {
    const widgetFrame = document.querySelector("#windWidget .widgetFrame");
    if (!widgetFrame) return;
    if (canvas.parentElement !== widgetFrame) widgetFrame.insertBefore(canvas, widgetFrame.firstChild);
    const w = widgetFrame.offsetWidth;
    const h = widgetFrame.offsetHeight;
    if (!w || !h) { setTimeout(updateCompassMap, 50); return; }
    canvas.width = w; canvas.height = h;
    canvas.style.cssText = "position:absolute;top:0;left:0;width:" + w + "px;height:" + h + "px;border-radius:12px;opacity:0.45;z-index:0;display:block;";
    drawMapTiles(canvas, w, h);
  } else {
    /* compass mode */
    const compassEl = document.getElementById("compassWidget");
    if (!compassEl) return;
    if (canvas.parentElement !== compassEl) compassEl.insertBefore(canvas, compassEl.firstChild);
    canvas.width = compassSize; canvas.height = compassSize;
    canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;border-radius:50%;opacity:0.65;z-index:0;display:block;";
    drawMapTiles(canvas, compassSize, compassSize);
  }
}

function drawMapTiles(canvas, w, h) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const zoom = compassZoom;
  const lat = marineLocationLat;
  const lon = marineLocationLon;

  const n = Math.pow(2, zoom);
  const tileX = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  const pixelX = Math.floor(((lon + 180) / 360 * n - tileX) * 256);
  const pixelY = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - tileY) * 256);

  ctx.save();
  ctx.beginPath();
  if (compassMapMode === "compass") {
    ctx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2);
  } else {
    ctx.roundRect(0, 0, w, h, 12);
  }
  ctx.clip();
  ctx.fillStyle = "#0a1924";
  ctx.fillRect(0, 0, w, h);

  [-1, 0, 1].forEach(dy => {
    [-1, 0, 1].forEach(dx => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${tileY + dy}/${tileX + dx}`;
      img.onload = () => {
        const drawX = (w / 2 - pixelX) + dx * 256;
        const drawY = (h / 2 - pixelY) + dy * 256;
        ctx.drawImage(img, drawX, drawY, 256, 256);
      };
    });
  });

  ctx.restore();
}




/* Draw compass ring, arrow and wind info onto the radar overlay canvas */
function refreshRadarOverlay() {
  if (compassMapMode !== "radar") return;
  const canvas = document.getElementById("radarOverlayCanvas");
  if (canvas) drawRadarCompassOverlay(canvas);
}

function drawRadarCompassOverlay(canvas) {
  if (!canvas) return;
  const W   = canvas.width;
  const H   = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const cx  = W / 2;
  const cy  = H / 2;
  const r   = Math.min(W, H) * 0.28;  /* smaller ring */
  const deg = lastWindDeg || 0;
  const rad = (deg - 90) * Math.PI / 180;

  /* ── Ring ── */
  if (compassStyle !== "none") {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(10, 25, 40, 0.85)";
    ctx.lineWidth   = 9;
    ctx.stroke();
    ctx.strokeStyle = "rgba(160, 220, 255, 0.90)";
    ctx.lineWidth   = 3;
    ctx.stroke();
    ctx.restore();

    if (compassStyle === "crosshair") {
      ctx.save();
      ctx.strokeStyle = "rgba(160,220,255,0.4)";
      ctx.lineWidth   = 1.5;
      ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
      ctx.restore();
    }

    /* Cardinal letters just outside the ring */
    const cardinals = [["N",0],["E",90],["S",180],["W",270]];
    ctx.save();
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    cardinals.forEach(([ltr, a]) => {
      const cr  = (a - 90) * Math.PI / 180;
      const lx  = cx + Math.cos(cr) * (r + 16);
      const ly  = cy + Math.sin(cr) * (r + 16);
      ctx.shadowColor = "rgba(0,0,0,0.95)";
      ctx.shadowBlur  = 5;
      ctx.fillStyle   = "#ffffff";
      ctx.fillText(ltr, lx, ly);
    });
    ctx.restore();
  }

  /* ── Arrow: starts at center, arrowhead at tip ── */
  const arrowColor = "#ff8060";
  const arrowLen   = r * 0.88;
  const tipX  = cx + Math.cos(rad) * arrowLen;
  const tipY  = cy + Math.sin(rad) * arrowLen;
  const hLen  = 16;
  const hAng  = 0.40;

  ctx.save();
  ctx.shadowColor = "rgba(255,110,70,0.7)";
  ctx.shadowBlur  = 10;

  /* Shaft — stop short of tip so arrowhead sits cleanly at end */
  ctx.strokeStyle = arrowColor;
  ctx.lineWidth   = 4;
  ctx.lineCap     = "round";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(tipX - Math.cos(rad) * hLen * 0.6, tipY - Math.sin(rad) * hLen * 0.6);
  ctx.stroke();

  /* Arrowhead at the very tip — same color as shaft */
  ctx.fillStyle = arrowColor;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - hLen*Math.cos(rad-hAng), tipY - hLen*Math.sin(rad-hAng));
  ctx.lineTo(tipX - hLen*Math.cos(rad+hAng), tipY - hLen*Math.sin(rad+hAng));
  ctx.closePath();
  ctx.fill();

  /* Center dot */
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI*2);
  ctx.fillStyle = arrowColor;
  ctx.fill();
  ctx.restore();

  /* ── Wind info pill — bottom left of widget ── */
  const mph   = lastWindMph || 0;
  const kph   = Math.round(mph * 1.60934);
  const knots = Math.round(mph * 0.868976);
  const dir   = degToCompass(deg);

  const parts = [];
  if (showWindMph)   parts.push(mph + " mph");
  if (showWindKph)   parts.push(kph + " kph");
  if (showWindKnots) parts.push(knots + " kts");
  if (showWindDir)   parts.push(dir + "  " + deg + "°");

  if (parts.length) {
    ctx.save();
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    const lineH = 24;
    const padX  = 12;
    const padY  = 8;
    const boxW  = Math.max(...parts.map(p => ctx.measureText(p).width)) + padX * 2;
    const boxH  = parts.length * lineH + padY * 2;
    const boxX  = 12;
    const boxY  = H - boxH - 12;

    ctx.fillStyle = "rgba(5,15,25,0.82)";
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(160,220,255,0.3)";
    ctx.lineWidth   = 1;
    ctx.stroke();

    ctx.fillStyle = "#d0ecff";
    parts.forEach((p, i) => {
      ctx.fillText(p, boxX + padX, boxY + padY + lineH * (i + 0.5));
    });
    ctx.restore();
  }
}

async function geocodeMarineAddress(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { "Accept-Language": "en" } });
    const data = await res.json();

    if (data && data.length > 0) {
      marineLocationLat = parseFloat(data[0].lat);
      marineLocationLon = parseFloat(data[0].lon);

      localStorage.setItem("marineLocationLat", marineLocationLat);
      localStorage.setItem("marineLocationLon", marineLocationLon);
      localStorage.setItem("marineLocationAddress", address);

      updateCompassMap();

      /* update nearby stations based on marina address */
      userLat = marineLocationLat;
      userLon = marineLocationLon;

      if (!allNoaaStations) allNoaaStations = await fetchAllNoaaStations();
      await updateNearbyStations(marineLocationLat, marineLocationLon);
    } else {
      alert("Address not found — try being more specific, e.g. '111 Avenida Menendez, St Augustine FL'");
    }
  } catch (err) {
    console.error("Geocode error:", err);
  }
}



function hexToRgb(hex) {
  const v = parseInt(hex.replace("#", ""), 16);

  return {
    r: (v >> 16) & 255,
    g: (v >> 8) & 255,
    b: v & 255
  };
}

function rgbToHex(r, g, b) {
  return "#" + [r,g,b].map(v =>
    v.toString(16).padStart(2, "0")
  ).join("");
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;

  const max = Math.max(r,g,b);
  const min = Math.min(r,g,b);

  let h, s;
  const l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;

    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    switch(max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }

    h *= 60;
  }

  return { h, s, l };
}

function hslToRgb(h, s, l) {
  h /= 360;

  let r, g, b;

  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q-p)*6*t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q-p)*(2/3 - t)*6;
      return p;
    };

    const q = l < .5 ? l * (1+s) : l + s - l*s;
    const p = 2*l - q;

    r = hue2rgb(p,q,h + 1/3);
    g = hue2rgb(p,q,h);
    b = hue2rgb(p,q,h - 1/3);
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255)
  };
}


/* ==========================================================================
   RADAR OVERLAY  (drawn on top of satellite tiles — same canvas, same math)
   ========================================================================== */

const _radarCache = {};

function _getRadarImg(url) {
  if (!_radarCache[url]) {
    var img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    _radarCache[url] = img;
  }
  return _radarCache[url];
}

/* Draw radar tiles on top of whatever is already on the canvas */
function drawRadarOverlay(canvas, w, h) {
  if (!canvas || !radarFrames.length) return;
  if (!w) w = canvas.width;
  if (!h) h = canvas.height;
  if (!w || !h) return;

  var lat = marineLocationLat != null ? marineLocationLat : userLat;
  var lon = marineLocationLon != null ? marineLocationLon : userLon;
  if (!lat || !lon) return;

  /* Use same zoom + same pixel math as drawMapTiles so tiles line up exactly */
  var zoom   = compassZoom;
  var path   = radarFrames[radarFrameIdx % radarFrames.length];
  var ctx    = canvas.getContext("2d");
  var n      = Math.pow(2, zoom);
  var tileX  = Math.floor((lon + 180) / 360 * n);
  var latRad = lat * Math.PI / 180;
  var tileY  = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  var pixelX = Math.floor(((lon + 180) / 360 * n - tileX) * 256);
  var pixelY = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - tileY) * 256);

  /* Draw 3x3 radar tiles at same positions as satellite tiles */
  [-1, 0, 1].forEach(function(dy) {
    [-1, 0, 1].forEach(function(dx) {
      var drawX = (w / 2 - pixelX) + dx * 256;
      var drawY = (h / 2 - pixelY) + dy * 256;
      /* RainViewer tile — note: row=tileY+dy, col=tileX+dx */
      var url = "https://tilecache.rainviewer.com" + path +
                "/256/" + zoom + "/" + (tileY + dy) + "/" + (tileX + dx) + "/4/1_1.png";
      (function(img, dX, dY) {
        var draw = function() {
          if (compassMapMode !== "radar") return;
          ctx.save();
          ctx.globalAlpha = 0.75;
          ctx.drawImage(img, dX, dY, 256, 256);
          ctx.restore();
          drawRadarChrome(ctx, w, h, path);
        };
        if (img.complete && img.naturalWidth > 0) {
          draw();
        } else {
          img.onload = draw;
        }
      })(_getRadarImg(url), drawX, drawY);
    });
  });

  drawRadarChrome(ctx, w, h, path);
}

/* Crosshair + timestamp label */
function drawRadarChrome(ctx, w, h, path) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,40,40,0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(w/2-12, h/2); ctx.lineTo(w/2+12, h/2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w/2, h/2-12); ctx.lineTo(w/2, h/2+12); ctx.stroke();
  ctx.restore();

  var m = path ? path.match(/[0-9]{9,}/) : null;
  if (m) {
    var lbl = new Date(parseInt(m[0]) * 1000)
      .toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
    ctx.save();
    ctx.font = "bold 12px sans-serif";
    var pw = ctx.measureText(lbl).width + 20;
    ctx.fillStyle = "rgba(0,0,0,0.68)";
    ctx.fillRect(6, h - 28, pw, 22);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText(lbl, 14, h - 12);
    ctx.restore();
  }
}

async function fetchRadarFrames() {
  try {
    var res = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    var data = await res.json();
    var past    = (data.radar && data.radar.past)    ? data.radar.past.map(function(f)    { return f.path; }) : [];
    var nowcast = (data.radar && data.radar.nowcast) ? data.radar.nowcast.map(function(f) { return f.path; }) : [];
    radarFrames = past.concat(nowcast);
    radarFrameIdx = 0;
    /* Preload first frame tiles */
    if (radarFrames.length) {
      var lat   = marineLocationLat != null ? marineLocationLat : userLat;
      var lon2  = marineLocationLon != null ? marineLocationLon : userLon;
      var zoom2 = compassZoom;
      var n2    = Math.pow(2, zoom2);
      var txP   = Math.floor((lon2 + 180) / 360 * n2);
      var latR  = lat * Math.PI / 180;
      var tyP   = Math.floor((1 - Math.log(Math.tan(latR) + 1/Math.cos(latR)) / Math.PI) / 2 * n2);
      var p0    = radarFrames[0];
      for (var dxi = -1; dxi <= 1; dxi++) for (var dyi = -1; dyi <= 1; dyi++) {
        _getRadarImg("https://tilecache.rainviewer.com" + p0 +
          "/256/" + zoom2 + "/" + (tyP+dyi) + "/" + (txP+dxi) + "/4/1_1.png");
      }
    }
  } catch(e) {
    console.warn("Radar fetch failed:", e);
    radarFrames = [];
  }
}

function startRadarAnimation(canvas, w, h) {
  stopRadarAnimation();
  if (!radarFrames.length) return;
  var interval = Math.max(150, Math.round(1100 - radarSpeed * 100));
  radarAnimTimer = setInterval(function() {
    radarFrameIdx = (radarFrameIdx + 1) % radarFrames.length;
    if (compassMapMode === "radar") {
      /* Redraw satellite base then overlay next radar frame */
      drawMapTiles(canvas, w, h);
      drawRadarOverlay(canvas, w, h);
    }
  }, interval);
}

function stopRadarAnimation() {
  if (radarAnimTimer) { clearInterval(radarAnimTimer); radarAnimTimer = null; }
}