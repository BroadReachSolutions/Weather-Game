/* ============================================================
   Oregon Sail — Instrument Gauges
   Each gauge (Speed, Windex, Engine, Sail Trim, Wheel, Water, Food,
   Hull) is now an independent widget that can be placed on any
   sub-tab via the dynamic tab system (tabsystem.js) and resized
   there with the universal widget-resize handles — there is no
   longer a single shared gauge canvas with internal drag-to-
   reposition; that's been replaced by the tab system's own resize
   model at the widget-card level.
   ============================================================ */

(function () {
  /* Each gauge has its own target container id, matching a widget
     id in the tab system's #osWidgetTemplates pool. */
  const GAUGE_TARGETS = {
    sog:      "osGaugeTarget-speed",
    windex:   "osGaugeTarget-windex",
    engine:   "osGaugeTarget-engine",
    sailtrim: "osGaugeTarget-sailtrim",
    wheel:    "osGaugeTarget-wheel",
    water:    "osGaugeTarget-water",
    food:     "osGaugeTarget-food",
    hull:     "osGaugeTarget-hull"
  };

  const HELM_DEFS = [
    { id: "sog",      label: "Speed",     type: "speed" },
    { id: "windex",   label: "Windex",    type: "windex" },
    { id: "engine",   label: "Engine",    type: "engine" },
    { id: "sailtrim", label: "Sail Trim", type: "sailtrim" },
    { id: "wheel",    label: "Helm",      type: "wheel" }
  ];

  const NAV_DEFS = [
    { id: "water", label: "Water", type: "percent", icon: "💧" },
    { id: "food",  label: "Food",  type: "percent", icon: "🍞" },
    { id: "hull",  label: "Hull",  type: "percent", icon: "🛟" }
  ];

  const ALL_DEFS = HELM_DEFS.concat(NAV_DEFS);

  /* Builds each gauge's inner HTML into its own target container,
     wherever that container currently exists in the DOM (it may be
     sitting inert inside #osWidgetTemplates, or already placed on a
     visible sub-tab — either way getElementById finds it). Only
     builds once per element; the gauge's own internal update
     functions (setSpeedGauge, setWindexGauge, etc) handle all
     subsequent live updates, so there's no need to rebuild the
     static HTML shell every time a tab switch happens to re-show it. */
  function buildPanel() {
    ALL_DEFS.forEach(def => {
      const targetId = GAUGE_TARGETS[def.id];
      const targetEl = document.getElementById(targetId);
      if (!targetEl) return; /* gauge widget not currently placed anywhere */
      if (targetEl.dataset.built === "1") return;
      targetEl.classList.add("osGauge", "osGauge-" + def.type);
      targetEl.innerHTML = buildGaugeInnerHtml(def);
      targetEl.dataset.built = "1";
    });
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

          <div class="osSailTrimSection" id="osSpinnakerSection">
            <div class="osSailTrimSubLabel">Spinnaker <span class="osSpinnakerHint" id="osSpinnakerHint"></span></div>
            <input type="range" id="osSpinnakerSlider" class="osBoomSliderSmall" min="0" max="100" step="1" value="0">
            <div class="osGaugeUnit" id="osSpinnakerLabel">Doused</div>
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

  function setSpinnakerLabel(pct) {
    const label = document.getElementById("osSpinnakerLabel");
    if (!label) return;
    const rounded = Math.round(pct);
    label.textContent = rounded <= 2 ? "Doused" : rounded >= 98 ? "Flying" : rounded + "% Out";
  }

  /* isDownwind: whether the boat is currently on a point of sail
     where a spinnaker actually helps (Broad Reach/Running). Shows a
     hint when it's deployed but not contributing, since that's a
     real tactical state the player should notice. */
  function setSpinnakerHint(isDownwind, furlPct) {
    const hint = document.getElementById("osSpinnakerHint");
    if (!hint) return;
    if (furlPct > 2 && !isDownwind) {
      hint.textContent = "(no benefit — not downwind)";
      hint.classList.add("warn");
    } else {
      hint.textContent = "";
      hint.classList.remove("warn");
    }
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
    const anyTarget = Object.values(GAUGE_TARGETS).some(id => document.getElementById(id));
    if (anyTarget) {
      buildPanel();
      return;
    }
    if (attempts > 0) setTimeout(() => initInstrumentPanel(attempts - 1), 300);
  }

  document.addEventListener("DOMContentLoaded", () => initInstrumentPanel(20));

  /* Gauges can be newly placed onto a sub-tab at any time (the player
     adding one via the tab system's widget editor) or re-shown after
     being moved between tabs — re-run buildPanel periodically so
     newly-placed gauges get their HTML shell built without requiring
     a full page reload. Cheap no-op for already-built gauges thanks
     to the dataset.built guard in buildPanel(). */
  setInterval(buildPanel, 1000);

  window.OSInstruments = {
    setPercentGauge,
    setSpeedGauge,
    setWindexGauge,
    calculateApparentWind,
    setEngineState,
    setBoomLabel,
    setReefButtons,
    setJibFurlLabel,
    setSpinnakerLabel,
    setSpinnakerHint,
    setSailAreaReadout,
    setSailsState,
    setWheelState,
    rebuild: buildPanel
  };
})();
