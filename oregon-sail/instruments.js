/* ============================================================
   Oregon Sail — Instrument Panel
   A free-form grid of square gauges in the bottom half of the
   game widget. Every player starts with a fixed default set
   (water, fuel, food, hull, speed, windex, engine, boom trim);
   future "instrument upgrades" can unlock additional gauges
   (true wind, radar, etc.) using the same framework — see
   INSTRUMENT_DEFS below, just add an entry and a render function.

   Gauges are draggable/resizable only while the dashboard is in
   Edit Layout mode (same body.layout-edit class the rest of the
   app already uses). Positions persist per-gauge in localStorage.
   ============================================================ */

(function () {
  const PANEL_ID = "osInstrumentPanel";
  const STORAGE_KEY = "osInstrumentLayout";
  const GAUGE_SIZE = 92; /* default square gauge size, px, within the panel's own coordinate space */

  /* ---------------------------------------------------------------
     GAUGE DEFINITIONS
     `owned` gauges render immediately. Locked/unowned gauges (for
     the future instrument-upgrade system) simply aren't included
     in this list yet — add an entry here once that gauge type is
     unlockable, with an `owned: false` default and a settings UI
     to grant it later.
     --------------------------------------------------------------- */
  const INSTRUMENT_DEFS = [
    { id: "water",  label: "Water",  type: "percent", icon: "💧" },
    { id: "fuel",   label: "Fuel",   type: "percent", icon: "⛽" },
    { id: "food",   label: "Food",   type: "percent", icon: "🍞" },
    { id: "hull",   label: "Hull",   type: "percent", icon: "🛟" },
    { id: "sog",    label: "Speed",  type: "speed" },
    { id: "windex", label: "Windex", type: "windex" },
    { id: "engine", label: "Engine", type: "engine" },
    { id: "boom",   label: "Boom Trim", type: "boom" }
  ];

  let gaugeLayout = loadLayout();
  let panelEl = null;

  function defaultPositionFor(index) {
    const cols = 3;
    const gap = 8;
    const col = index % cols;
    const row = Math.floor(index / cols);
    return {
      left: gap + col * (GAUGE_SIZE + gap),
      top: gap + row * (GAUGE_SIZE + gap)
    };
  }

  function loadLayout() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function saveLayout() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(gaugeLayout));
  }

  /* ---------------------------------------------------------------
     BUILD PANEL
     --------------------------------------------------------------- */
  function buildPanel() {
    panelEl = document.getElementById(PANEL_ID);
    if (!panelEl) return;
    panelEl.innerHTML = "";

    INSTRUMENT_DEFS.forEach((def, i) => {
      const pos = gaugeLayout[def.id] || defaultPositionFor(i);
      gaugeLayout[def.id] = pos;

      const gauge = document.createElement("div");
      gauge.className = "osGauge osGauge-" + def.type;
      gauge.dataset.gaugeId = def.id;
      gauge.style.left = pos.left + "px";
      gauge.style.top = pos.top + "px";
      gauge.style.width = (pos.size || GAUGE_SIZE) + "px";
      gauge.style.height = (pos.size || GAUGE_SIZE) + "px";
      gauge.innerHTML = buildGaugeInnerHtml(def);
      panelEl.appendChild(gauge);

      makeGaugeDraggable(gauge, def.id);
    });

    saveLayout();
  }

  function buildGaugeInnerHtml(def) {
    switch (def.type) {
      case "percent":
        return `
          <div class="osGaugeLabel">${def.icon} ${def.label}</div>
          <div class="osGaugeCircle">
            <svg viewBox="0 0 36 36" class="osGaugeRing">
              <path class="osGaugeRingBg" d="M18 2 a16 16 0 1 1 0 32 a16 16 0 1 1 0 -32" />
              <path class="osGaugeRingFill" id="osGaugeRing_${def.id}" d="M18 2 a16 16 0 1 1 0 32 a16 16 0 1 1 0 -32" />
            </svg>
            <div class="osGaugeValue" id="osGaugeVal_${def.id}">—</div>
          </div>
        `;
      case "speed":
        return `
          <div class="osGaugeLabel">Speed</div>
          <div class="osGaugeBigValue" id="osGaugeVal_sog">—</div>
          <div class="osGaugeUnit">kt SOG</div>
        `;
      case "windex":
        return `
          <div class="osGaugeLabel">Windex</div>
          <div class="osWindexFace" id="osWindexFace">
            <svg viewBox="0 0 80 80" class="osWindexSvg">
              <circle cx="40" cy="40" r="36" class="osWindexRing"/>
              ${buildWindexTicks()}
              <g id="osWindexBoat">
                <path d="M40 14 L47 34 L46 56 Q40 60 34 56 L33 34 Z" class="osWindexBoatShape"/>
              </g>
              <g id="osWindexArrowGroup">
                <line x1="40" y1="40" x2="40" y2="14" class="osWindexArrowLine"/>
                <path d="M35 18 L40 8 L45 18 Z" class="osWindexArrowHead"/>
              </g>
            </svg>
          </div>
          <div class="osGaugeUnit" id="osWindexLabel">Apparent Wind</div>
        `;
      case "engine":
        return `
          <div class="osGaugeLabel">Engine</div>
          <button class="osEngineToggle" id="osEngineToggle">START</button>
          <input type="range" id="osThrottleSlider" class="osThrottleSlider" min="-1" max="1" step="0.01" value="0" disabled>
          <div class="osGaugeUnit" id="osThrottleLabel">0 RPM</div>
        `;
      case "boom":
        return `
          <div class="osGaugeLabel">Boom Trim</div>
          <input type="range" id="osBoomSlider" class="osBoomSliderSmall" min="-90" max="90" step="1" value="25">
          <div class="osGaugeUnit" id="osBoomLabel">25°</div>
        `;
      default:
        return `<div class="osGaugeLabel">${def.label}</div>`;
    }
  }

  function buildWindexTicks() {
    let ticks = "";
    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg * Math.PI) / 180;
      const x1 = 40 + Math.sin(rad) * 32;
      const y1 = 40 - Math.cos(rad) * 32;
      const x2 = 40 + Math.sin(rad) * 27;
      const y2 = 40 - Math.cos(rad) * 27;
      ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="osWindexTick"/>`;
    }
    return ticks;
  }

  /* ---------------------------------------------------------------
     DRAG (Edit Layout mode only)
     --------------------------------------------------------------- */
  function makeGaugeDraggable(gauge, gaugeId) {
    let dragState = null;

    function getXY(e) {
      if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.changedTouches && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    function onDown(e) {
      if (!document.body.classList.contains("layout-edit")) return;
      e.preventDefault();
      const { x, y } = getXY(e);
      dragState = {
        startX: x, startY: y,
        left: parseFloat(gauge.style.left) || 0,
        top: parseFloat(gauge.style.top) || 0
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
    }

    function onMove(e) {
      if (!dragState) return;
      e.preventDefault();
      const { x, y } = getXY(e);
      /* Use clientWidth/clientHeight (content box, excludes any
         scrollbar) rather than getBoundingClientRect (full border
         box) — otherwise the right/bottom edge clamp falls short by
         however wide the scrollbar track is. */
      const maxLeft = panelEl.clientWidth - gauge.offsetWidth;
      const maxTop = panelEl.clientHeight - gauge.offsetHeight;
      let newLeft = dragState.left + (x - dragState.startX);
      let newTop = dragState.top + (y - dragState.startY);
      newLeft = Math.max(0, Math.min(maxLeft, newLeft));
      newTop = Math.max(0, Math.min(maxTop, newTop));
      gauge.style.left = newLeft + "px";
      gauge.style.top = newTop + "px";
    }

    function onUp() {
      if (!dragState) return;
      dragState = null;
      gaugeLayout[gaugeId] = {
        left: parseFloat(gauge.style.left),
        top: parseFloat(gauge.style.top),
        size: parseFloat(gauge.style.width)
      };
      saveLayout();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    }

    gauge.addEventListener("mousedown", onDown);
    gauge.addEventListener("touchstart", onDown, { passive: false });
  }

  /* ---------------------------------------------------------------
     GAUGE UPDATES — called from game-ui.js whenever boat state or
     wind data refreshes. Exposed on window.OSInstruments.
     --------------------------------------------------------------- */
  function setPercentGauge(id, pct) {
    const clamped = Math.max(0, Math.min(100, pct));
    const valEl = document.getElementById("osGaugeVal_" + id);
    const ringEl = document.getElementById("osGaugeRing_" + id);
    if (valEl) valEl.textContent = Math.round(clamped) + "%";
    if (ringEl) {
      const circumference = 2 * Math.PI * 16;
      const offset = circumference * (1 - clamped / 100);
      ringEl.style.strokeDasharray = circumference.toFixed(1);
      ringEl.style.strokeDashoffset = offset.toFixed(1);
      ringEl.classList.toggle("osLow", clamped <= 20);
    }
  }

  function setSpeedGauge(knots) {
    const el = document.getElementById("osGaugeVal_sog");
    if (el) el.textContent = (knots || 0).toFixed(1);
  }

  /* Apparent wind = vector(true wind) - vector(boat motion).
     Returns { speedKt, angleFromBow } where angleFromBow is 0-360
     relative to the boat's own heading (0 = dead ahead). */
  function calculateApparentWind(headingDeg, speedKt, trueWindFromDeg, trueWindKt) {
    const toRad = d => (d * Math.PI) / 180;
    /* Convert true wind (a "from" direction) to a vector the wind is
       blowing TOWARD, in standard math coords (x=east, y=north) */
    const twToward = (trueWindFromDeg + 180) % 360;
    const twX = trueWindKt * Math.sin(toRad(twToward));
    const twY = trueWindKt * Math.cos(toRad(twToward));

    /* Boat's motion vector */
    const boatX = speedKt * Math.sin(toRad(headingDeg));
    const boatY = speedKt * Math.cos(toRad(headingDeg));

    /* Apparent wind blowing-toward vector = true wind vector - boat vector */
    const awX = twX - boatX;
    const awY = twY - boatY;
    const awSpeed = Math.sqrt(awX * awX + awY * awY);

    /* Convert back to a compass "from" direction */
    let awToward = (Math.atan2(awX, awY) * 180) / Math.PI;
    let awFrom = (awToward + 180 + 360) % 360;

    /* Express relative to the boat's heading (0 = dead ahead) for the windex face */
    const relativeDeg = ((awFrom - headingDeg) + 360) % 360;

    return { speedKt: awSpeed, angleFromBow: relativeDeg };
  }

  function setWindexGauge(headingDeg, speedKt, trueWindFromDeg, trueWindKt) {
    const aw = calculateApparentWind(headingDeg, speedKt, trueWindFromDeg, trueWindKt);
    const arrowGroup = document.getElementById("osWindexArrowGroup");
    const label = document.getElementById("osWindexLabel");
    if (arrowGroup) arrowGroup.setAttribute("transform", `rotate(${aw.angleFromBow.toFixed(1)} 40 40)`);
    if (label) label.textContent = `${aw.speedKt.toFixed(1)} kt apparent`;
  }

  function setEngineState(isRunning, rpm) {
    const toggle = document.getElementById("osEngineToggle");
    const slider = document.getElementById("osThrottleSlider");
    const label = document.getElementById("osThrottleLabel");
    if (toggle) {
      toggle.textContent = isRunning ? "STOP" : "START";
      toggle.classList.toggle("running", isRunning);
    }
    if (slider) slider.disabled = !isRunning;
    if (label) label.textContent = isRunning ? Math.round(rpm) + " RPM" : "Engine off";
  }

  function setBoomLabel(angle) {
    const label = document.getElementById("osBoomLabel");
    if (label) label.textContent = Math.round(angle) + "°";
  }

  function initInstrumentPanel(attempts) {
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      buildPanel();
      return;
    }
    if (attempts > 0) setTimeout(() => initInstrumentPanel(attempts - 1), 300);
  }

  document.addEventListener("DOMContentLoaded", () => initInstrumentPanel(20));

  window.OSInstruments = {
    setPercentGauge,
    setSpeedGauge,
    setWindexGauge,
    calculateApparentWind,
    setEngineState,
    setBoomLabel,
    rebuild: buildPanel
  };
})();
