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
  const NAV_PANEL_ID = "osNavGauges";
  const STORAGE_KEY = "osInstrumentLayout";
  const GAUGE_SIZE = 92;

  /* Helm tab instruments — speed, windex, engine (1×2), boom */
  const HELM_DEFS = [
    { id: "sog",      label: "Speed",     type: "speed" },
    { id: "windex",   label: "Windex",    type: "windex" },
    { id: "engine",   label: "Engine",    type: "engine", w: 1, h: 2 },
    { id: "sailtrim", label: "Sail Trim", type: "sailtrim", w: 1, h: 2 },
    { id: "wheel",    label: "Helm",      type: "wheel", w: 2, h: 2 }
  ];

  /* Nav Station tab instruments — supplies. Moved here so the Helm
     stays focused on vessel control, Nav Station on provisions/DC. */
  const NAV_DEFS = [
    { id: "water", label: "Water", type: "percent", icon: "💧" },
    { id: "food",  label: "Food",  type: "percent", icon: "🍞" },
    { id: "hull",  label: "Hull",  type: "percent", icon: "🛟" }
  ];

  let gaugeLayout = loadLayout();
  let panelEl = null;
  let navPanelEl = null;

  function defaultPositionFor(def, index, allDefs) {
    const gap = 8;
    /* Engine, sailtrim, and wheel are non-1x1 — laid out manually to
       account for their footprints. */
    const positions = {
      sog:      { left: gap,               top: gap },
      windex:   { left: gap + GAUGE_SIZE + gap, top: gap },
      engine:   { left: gap + (GAUGE_SIZE + gap) * 2, top: gap },
      sailtrim: { left: gap + (GAUGE_SIZE + gap) * 3, top: gap },
      wheel:    { left: gap + GAUGE_SIZE + gap, top: gap + GAUGE_SIZE + gap }
    };
    if (positions[def.id]) return positions[def.id];
    /* Nav gauges: simple row */
    const col = index % 3;
    return { left: gap + col * (GAUGE_SIZE + gap), top: gap };
  }

  function gaugeWidth(def) {
    return (def.w || 1) * GAUGE_SIZE + (def.w > 1 ? (def.w - 1) * 8 : 0);
  }

  function gaugeHeight(def) {
    return (def.h || 1) * GAUGE_SIZE + (def.h > 1 ? (def.h - 1) * 8 : 0);
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

  function buildPanel() {
    panelEl = document.getElementById(PANEL_ID);
    navPanelEl = document.getElementById(NAV_PANEL_ID);

    if (panelEl) {
      panelEl.innerHTML = "";
      HELM_DEFS.forEach((def, i) => {
        const pos = gaugeLayout[def.id] || defaultPositionFor(def, i, HELM_DEFS);
        gaugeLayout[def.id] = pos;
        const el = createGauge(def, pos);
        panelEl.appendChild(el);
        makeGaugeDraggable(el, def.id);
      });
    }

    if (navPanelEl) {
      navPanelEl.innerHTML = "";
      NAV_DEFS.forEach((def, i) => {
        const pos = gaugeLayout[def.id] || defaultPositionFor(def, i, NAV_DEFS);
        gaugeLayout[def.id] = pos;
        const el = createGauge(def, pos);
        navPanelEl.appendChild(el);
        makeGaugeDraggable(el, def.id);
      });
    }

    saveLayout();
  }

  function createGauge(def, pos) {
    const gauge = document.createElement("div");
    gauge.className = "osGauge osGauge-" + def.type;
    gauge.dataset.gaugeId = def.id;
    gauge.style.left = pos.left + "px";
    gauge.style.top = pos.top + "px";
    gauge.style.width = (pos.size || gaugeWidth(def)) + "px";
    gauge.style.height = (pos.sizeH || gaugeHeight(def)) + "px";
    gauge.innerHTML = buildGaugeInnerHtml(def);
    return gauge;
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
                <line x1="40" y1="40" x2="40" y2="10" class="osWindexArrowLine"/>
              </g>
            </svg>
          </div>
          <div class="osGaugeUnit" id="osWindexLabel">Apparent Wind</div>
        `;
      case "engine":
        return `
          <div class="osGaugeLabel">Engine</div>
          <button class="osEngineToggle" id="osEngineToggle">START</button>
          <div class="osThrottleWrap">
            <div class="osThrottleTrack">
              <div class="osThrottleZone osThrottleFwd">FWD</div>
              <div class="osThrottleZone osThrottleNeutral">·</div>
              <div class="osThrottleZone osThrottleRev">REV</div>
            </div>
            <input type="range" id="osThrottleSlider" class="osThrottleSlider"
              min="-1" max="1" step="0.01" value="0"
              orient="vertical" disabled>
          </div>
          <div class="osGaugeUnit" id="osThrottleLabel">Engine Off</div>
          <div class="osEngineFuelRow">
            <span class="osGaugeLabel">⛽ Fuel</span>
            <div class="osGaugeCircle osGaugeCircleSmall">
              <svg viewBox="0 0 36 36" class="osGaugeRing">
                <path class="osGaugeRingBg" d="M18 2 a16 16 0 1 1 0 32 a16 16 0 1 1 0 -32" />
                <path class="osGaugeRingFill" id="osGaugeRing_fuel" d="M18 2 a16 16 0 1 1 0 32 a16 16 0 1 1 0 -32" />
              </svg>
              <div class="osGaugeValue osGaugeValueSmall" id="osGaugeVal_fuel">—</div>
            </div>
          </div>
        `;
      case "sailtrim":
        return `
          <div class="osSailTrimHeader">
            <span class="osGaugeLabel">Sail Trim</span>
            <button class="osSailsToggle" id="osSailsToggle">SAILS UP</button>
          </div>

          <div class="osSailTrimSection">
            <div class="osSailTrimSubLabel">Boom</div>
            <input type="range" id="osBoomSlider" class="osBoomSliderSmall" min="-90" max="90" step="1" value="25">
            <div class="osGaugeUnit" id="osBoomLabel">25°</div>
          </div>

          <div class="osSailTrimSection">
            <div class="osSailTrimSubLabel">Main Reef</div>
            <div class="osReefButtons">
              <button class="osReefBtn active" data-reef="0">Full</button>
              <button class="osReefBtn" data-reef="1">Reef 1</button>
              <button class="osReefBtn" data-reef="2">Reef 2</button>
            </div>
          </div>

          <div class="osSailTrimSection">
            <div class="osSailTrimSubLabel">Jib Furl</div>
            <input type="range" id="osJibFurlSlider" class="osBoomSliderSmall" min="0" max="100" step="1" value="100">
            <div class="osGaugeUnit" id="osJibFurlLabel">Full Jib</div>
          </div>

          <div class="osSailAreaReadout" id="osSailAreaReadout">— sq ft exposed</div>
        `;
      case "wheel":
        return `
          <div class="osWheelHeader">
            <span class="osGaugeLabel">Helm</span>
            <div class="osHelmModeToggle">
              <button class="osHelmModeBtn" id="osManualBtn">MANUAL</button>
              <button class="osHelmModeBtn" id="osAutoBtn">AUTO</button>
            </div>
          </div>
          <div class="osWheelFace" id="osWheelFace">
            <svg viewBox="0 0 100 100" class="osWheelSvg" id="osWheelSvg">
              <circle cx="50" cy="50" r="42" class="osWheelRim"/>
              <circle cx="50" cy="50" r="10" class="osWheelHub"/>
              <g id="osWheelSpokes">
                <line x1="50" y1="8"  x2="50" y2="36" class="osWheelSpoke"/>
                <line x1="50" y1="92" x2="50" y2="64" class="osWheelSpoke"/>
                <line x1="8"  y1="50" x2="36" y2="50" class="osWheelSpoke"/>
                <line x1="92" y1="50" x2="64" y2="50" class="osWheelSpoke"/>
                <line x1="20" y1="20" x2="39" y2="39" class="osWheelSpoke"/>
                <line x1="80" y1="80" x2="61" y2="61" class="osWheelSpoke"/>
                <line x1="80" y1="20" x2="61" y2="39" class="osWheelSpoke"/>
                <line x1="20" y1="80" x2="39" y2="61" class="osWheelSpoke"/>
              </g>
            </svg>
          </div>
          <div class="osRudderRow">
            <span class="osRudderLabelEnd">P</span>
            <div class="osRudderTrack">
              <div class="osRudderCenterMark"></div>
              <div class="osRudderDot" id="osRudderDot"></div>
            </div>
            <span class="osRudderLabelEnd">S</span>
          </div>
          <div class="osGaugeUnit" id="osRudderLabel">Center</div>
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
        size: parseFloat(gauge.style.width),
        sizeH: parseFloat(gauge.style.height)
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
    if (arrowGroup) arrowGroup.setAttribute("transform", `rotate(${((aw.angleFromBow + 180) % 360).toFixed(1)} 40 40)`);
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

  function setReefButtons(reefLevel) {
    document.querySelectorAll(".osReefBtn").forEach(btn => {
      btn.classList.toggle("active", parseInt(btn.dataset.reef, 10) === reefLevel);
    });
  }

  function setJibFurlLabel(pct) {
    const label = document.getElementById("osJibFurlLabel");
    if (!label) return;
    const rounded = Math.round(pct);
    label.textContent = rounded <= 2 ? "Furled" : rounded >= 98 ? "Full Jib" : rounded + "% Jib";
  }

  function setSailAreaReadout(exposedSqFt, totalSqFt) {
    const el = document.getElementById("osSailAreaReadout");
    if (!el) return;
    el.textContent = `${Math.round(exposedSqFt)} / ${Math.round(totalSqFt)} sq ft exposed`;
  }

  function setSailsState(isUp) {
    const toggle = document.getElementById("osSailsToggle");
    if (toggle) {
      toggle.textContent = isUp ? "SAILS DOWN" : "SAILS UP";
      toggle.classList.toggle("up", isUp);
    }
  }

  /* rudderAngle: -45 (full port) .. 45 (full starboard). autopilotOn:
     when true, the wheel visually centers and dims since the autopilot
     is holding course rather than the player steering directly. */
  function setWheelState(rudderAngle, autopilotOn) {
    const spokes = document.getElementById("osWheelSpokes");
    const dot = document.getElementById("osRudderDot");
    const label = document.getElementById("osRudderLabel");
    const manualBtn = document.getElementById("osManualBtn");
    const autoBtn = document.getElementById("osAutoBtn");
    const face = document.getElementById("osWheelFace");

    if (spokes) spokes.setAttribute("transform", `rotate(${rudderAngle * 2} 50 50)`);

    if (dot) {
      const pct = (rudderAngle + 45) / 90; /* 0..1 */
      dot.style.left = (pct * 100) + "%";
    }

    if (label) {
      const rounded = Math.round(rudderAngle);
      label.textContent = Math.abs(rounded) <= 2 ? "Center" :
        (rounded < 0 ? `Port ${Math.abs(rounded)}°` : `Starboard ${rounded}°`);
    }

    if (manualBtn) manualBtn.classList.toggle("active", !autopilotOn);
    if (autoBtn) autoBtn.classList.toggle("active", !!autopilotOn);
    if (face) face.classList.toggle("autopilot", !!autopilotOn);
  }

  function initInstrumentPanel(attempts) {
    const helm = document.getElementById(PANEL_ID);
    const nav = document.getElementById(NAV_PANEL_ID);
    if (helm || nav) {
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
    setReefButtons,
    setJibFurlLabel,
    setSailAreaReadout,
    setSailsState,
    setWheelState,
    rebuild: buildPanel
  };
})();
