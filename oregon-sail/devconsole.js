/* ============================================================
   Oregon Sail — Developer Console
   Unlocked when a boat's captain and vessel are both named "Sonic"
   (see game-ui.js's developer-mode check). Gives direct access to:
     - Vessel presets (CRUD against boat_presets table)
     - Live boat state inspector/editor (every raw DB field, editable)
     - Weather override (force wind speed/direction for testing)
     - Teleport (jump the boat to any lat/lon instantly)
     - Global UI config (colors/defaults applied to every player)
     - Map Editor (stub for now — real geodata editor is a future project)
     - Event log (recent client-side actions/errors, for debugging)
   ============================================================ */

(function () {
  let devLog = [];
  const MAX_LOG_ENTRIES = 200;

  /* Capture console.error/warn into our own log too, so dev-visible
     errors are easy to review without needing devtools open */
  const origError = console.error;
  const origWarn = console.warn;
  console.error = function (...args) {
    logEvent("error", args.map(String).join(" "));
    origError.apply(console, args);
  };
  console.warn = function (...args) {
    logEvent("warn", args.map(String).join(" "));
    origWarn.apply(console, args);
  };

  function logEvent(level, message) {
    devLog.push({ time: new Date().toISOString(), level, message });
    if (devLog.length > MAX_LOG_ENTRIES) devLog.shift();
    if (document.getElementById("osDevTabContent")?.dataset.activeTab === "log") renderLogTab();
  }

  /* ---------------------------------------------------------------
     WEATHER OVERRIDE WIRING
     Wraps the real wind getter functions (defined in script.js) so
     every consumer in the game — point of sail, sail speed, the 3D
     heel/wind-streak direction, the windex gauge — transparently
     respects the override without each call site needing its own
     check. When inactive, falls through to the real value untouched.
     --------------------------------------------------------------- */
  function installWeatherOverrideHooks() {
    if (window.__osRealGetLastWindDeg) return; /* already installed */

    window.__osRealGetLastWindDeg = window.getLastWindDeg;
    window.__osRealGetLastWindMph = window.getLastWindMph;

    window.getLastWindDeg = function () {
      if (window.OSDevWeatherOverride && window.OSDevWeatherOverride.active) {
        return window.OSDevWeatherOverride.dirDeg;
      }
      return typeof window.__osRealGetLastWindDeg === "function" ? window.__osRealGetLastWindDeg() : 0;
    };

    window.getLastWindMph = function () {
      if (window.OSDevWeatherOverride && window.OSDevWeatherOverride.active) {
        return window.OSDevWeatherOverride.speedMph;
      }
      return typeof window.__osRealGetLastWindMph === "function" ? window.__osRealGetLastWindMph() : 0;
    };
  }

  /* ---------------------------------------------------------------
     INIT — shows the toggle button, wires the open/close/tab switching
     --------------------------------------------------------------- */
  function init() {
    installWeatherOverrideHooks();
    const toggleBtn = document.getElementById("osDevToggleBtn");
    const closeBtn = document.getElementById("osDevCloseBtn");
    const console_ = document.getElementById("osDevConsole");
    const tabBar = document.getElementById("osDevTabBar");

    if (toggleBtn) toggleBtn.style.display = "flex";
    logEvent("info", "Developer console unlocked for this boat.");

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        console_.style.display = console_.style.display === "none" ? "flex" : "none";
        if (console_.style.display === "flex") switchDevTab("vessels");
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", () => { console_.style.display = "none"; });
    }
    if (tabBar) {
      tabBar.addEventListener("click", (e) => {
        const tab = e.target.closest(".osDevTab");
        if (!tab) return;
        document.querySelectorAll(".osDevTab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        switchDevTab(tab.dataset.devtab);
      });
    }
  }

  function switchDevTab(tabName) {
    const content = document.getElementById("osDevTabContent");
    if (!content) return;
    const leavingDesigner = content.dataset.activeTab === "designer" && tabName !== "designer";
    content.dataset.activeTab = tabName;

    const console_ = document.getElementById("osDevConsole");
    if (console_) console_.classList.toggle("osDevDesignerMode", tabName === "designer");

    if (leavingDesigner && typeof window.OSHelm3D !== "undefined" && window.OS.boat) {
      /* Restore the boat's actual saved design (or default) so any
         unsaved preview tweaks don't linger in the live game view */
      window.OSHelm3D.rebuildBoat(window.OS.boat.hull_design || window.OSHelm3D.getDefaultBoatDNA());
      designerDNA = null; /* next time the tab opens, start fresh from the boat's real state */
    }

    const renderers = {
      vessels: renderVesselsTab,
      designer: renderDesignerTab,
      state: renderStateTab,
      weather: renderWeatherTab,
      teleport: renderTeleportTab,
      ui: renderUiConfigTab,
      map: renderMapTab,
      log: renderLogTab
    };
    (renderers[tabName] || renderVesselsTab)();
  }

  /* ---------------------------------------------------------------
     VESSELS TAB — list, create, edit, delete boat presets
     --------------------------------------------------------------- */
  async function renderVesselsTab() {
    const content = document.getElementById("osDevTabContent");
    content.innerHTML = `<div class="osDevLoading">Loading vessel presets…</div>`;

    const { data: presets, error } = await sbClient
      .from("boat_presets")
      .select("*")
      .order("sort_order", { ascending: true });

    if (error) {
      content.innerHTML = `<div class="osDevError">Failed to load presets: ${error.message}</div>`;
      logEvent("error", "Failed to load boat_presets: " + error.message);
      return;
    }

    content.innerHTML = `
      <div class="osDevSection">
        <div class="osDevSectionHeader">
          <span>Vessel Presets (${presets.length})</span>
          <button class="osDevBtn" id="osDevNewVesselBtn">+ New Vessel</button>
        </div>
        <div class="osDevVesselList" id="osDevVesselList"></div>
      </div>
      <div class="osDevSection" id="osDevVesselEditWrap" style="display:none;"></div>
    `;

    const list = document.getElementById("osDevVesselList");
    presets.forEach(p => {
      const row = document.createElement("div");
      row.className = "osDevVesselRow";
      row.innerHTML = `
        <span class="osDevVesselIcon">${p.icon || "🛥"}</span>
        <span class="osDevVesselName">${p.display_name}</span>
        <span class="osDevVesselStat">${p.hull_speed_kt}kt</span>
        <button class="osDevBtnSmall" data-edit="${p.id}">Edit</button>
        <button class="osDevBtnSmall osDevBtnDanger" data-delete="${p.id}">Delete</button>
      `;
      list.appendChild(row);
    });

    list.querySelectorAll("[data-edit]").forEach(btn => {
      btn.addEventListener("click", () => {
        const preset = presets.find(p => p.id === btn.dataset.edit);
        showVesselEditor(preset);
      });
    });
    list.querySelectorAll("[data-delete]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this vessel preset? This can't be undone.")) return;
        await sbClient.from("boat_presets").delete().eq("id", btn.dataset.delete);
        logEvent("info", "Deleted boat preset " + btn.dataset.delete);
        renderVesselsTab();
      });
    });

    document.getElementById("osDevNewVesselBtn").addEventListener("click", () => showVesselEditor(null));
  }

  function showVesselEditor(preset) {
    const wrap = document.getElementById("osDevVesselEditWrap");
    const isNew = !preset;
    const p = preset || {
      preset_key: "", display_name: "", icon: "🛥", description: "",
      hull_speed_kt: 6.5, rated_wind_mph: 15, boat_weight_class: "medium",
      main_sail_area_sqft: 245, jib_sail_area_sqft: 105, spinnaker_sail_area_sqft: 0,
      reef_wind_limits_mph: [25, 30, 35], reef_speed_penalty: [1.0, 0.85, 0.65],
      sort_order: 0, is_active: true
    };

    wrap.style.display = "block";
    wrap.innerHTML = `
      <div class="osDevSectionHeader"><span>${isNew ? "New Vessel" : "Edit: " + p.display_name}</span></div>
      <div class="osDevFormGrid">
        <label>Preset Key <input type="text" id="dvKey" value="${p.preset_key}" placeholder="e.g. daysailer"></label>
        <label>Display Name <input type="text" id="dvName" value="${p.display_name}"></label>
        <label>Icon (emoji) <input type="text" id="dvIcon" value="${p.icon}"></label>
        <label>Hull Speed (kt) <input type="number" step="0.1" id="dvHullSpeed" value="${p.hull_speed_kt}"></label>
        <label>Rated Wind (mph) <input type="number" step="0.5" id="dvRatedWind" value="${p.rated_wind_mph}"></label>
        <label>Weight Class
          <select id="dvWeightClass">
            <option value="light" ${p.boat_weight_class === "light" ? "selected" : ""}>Light</option>
            <option value="medium" ${p.boat_weight_class === "medium" ? "selected" : ""}>Medium</option>
            <option value="heavy" ${p.boat_weight_class === "heavy" ? "selected" : ""}>Heavy</option>
          </select>
        </label>
        <label>Main Sail Area (sqft) <input type="number" id="dvMainArea" value="${p.main_sail_area_sqft}"></label>
        <label>Jib Sail Area (sqft) <input type="number" id="dvJibArea" value="${p.jib_sail_area_sqft}"></label>
        <label>Spinnaker Area (sqft, 0 = none) <input type="number" id="dvSpinnakerArea" value="${p.spinnaker_sail_area_sqft || 0}"></label>
        <label>Reef Wind Limits (mph, csv) <input type="text" id="dvReefLimits" value="${(p.reef_wind_limits_mph || []).join(",")}"></label>
        <label>Reef Speed Penalty (csv) <input type="text" id="dvReefPenalty" value="${(p.reef_speed_penalty || []).join(",")}"></label>
        <label>Sort Order <input type="number" id="dvSortOrder" value="${p.sort_order}"></label>
        <label class="osDevCheckboxLabel"><input type="checkbox" id="dvIsActive" ${p.is_active ? "checked" : ""}> Active (visible at main menu)</label>
        <label class="osDevFullWidth">Description <textarea id="dvDescription" rows="2">${p.description}</textarea></label>
      </div>
      <div class="osDevFormActions">
        <button class="osDevBtn" id="osDevSaveVesselBtn">${isNew ? "Create" : "Save Changes"}</button>
        <button class="osDevBtnSecondary" id="osDevCancelVesselBtn">Cancel</button>
        ${!isNew ? `<button class="osDevBtnSecondary" id="osDevTestVesselBtn">Test on my boat now</button>` : ""}
      </div>
    `;

    document.getElementById("osDevCancelVesselBtn").addEventListener("click", () => {
      wrap.style.display = "none";
    });

    document.getElementById("osDevSaveVesselBtn").addEventListener("click", async () => {
      const fields = {
        preset_key: document.getElementById("dvKey").value.trim(),
        display_name: document.getElementById("dvName").value.trim(),
        icon: document.getElementById("dvIcon").value.trim() || "🛥",
        hull_speed_kt: parseFloat(document.getElementById("dvHullSpeed").value) || 6.5,
        rated_wind_mph: parseFloat(document.getElementById("dvRatedWind").value) || 15,
        boat_weight_class: document.getElementById("dvWeightClass").value,
        main_sail_area_sqft: parseFloat(document.getElementById("dvMainArea").value) || 245,
        jib_sail_area_sqft: parseFloat(document.getElementById("dvJibArea").value) || 105,
        spinnaker_sail_area_sqft: parseFloat(document.getElementById("dvSpinnakerArea").value) || 0,
        reef_wind_limits_mph: document.getElementById("dvReefLimits").value.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n)),
        reef_speed_penalty: document.getElementById("dvReefPenalty").value.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n)),
        sort_order: parseInt(document.getElementById("dvSortOrder").value, 10) || 0,
        is_active: document.getElementById("dvIsActive").checked,
        description: document.getElementById("dvDescription").value,
        updated_at: new Date().toISOString()
      };

      if (!fields.preset_key || !fields.display_name) {
        alert("Preset key and display name are required.");
        return;
      }

      let result;
      if (isNew) {
        result = await sbClient.from("boat_presets").insert(fields);
      } else {
        result = await sbClient.from("boat_presets").update(fields).eq("id", p.id);
      }

      if (result.error) {
        alert("Save failed: " + result.error.message);
        logEvent("error", "Vessel save failed: " + result.error.message);
        return;
      }

      logEvent("info", `Vessel preset ${isNew ? "created" : "updated"}: ${fields.display_name}`);
      renderVesselsTab();
    });

    if (!isNew) {
      const testBtn = document.getElementById("osDevTestVesselBtn");
      if (testBtn) {
        testBtn.addEventListener("click", async () => {
          if (!window.OS.boat) return;
          const fields = {
            hull_speed_kt: parseFloat(document.getElementById("dvHullSpeed").value) || 6.5,
            rated_wind_mph: parseFloat(document.getElementById("dvRatedWind").value) || 15,
            boat_weight_class: document.getElementById("dvWeightClass").value,
            main_sail_area_sqft: parseFloat(document.getElementById("dvMainArea").value) || 245,
            jib_sail_area_sqft: parseFloat(document.getElementById("dvJibArea").value) || 105,
            spinnaker_sail_area_sqft: parseFloat(document.getElementById("dvSpinnakerArea").value) || 0,
            reef_wind_limits_mph: document.getElementById("dvReefLimits").value.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n)),
            reef_speed_penalty: document.getElementById("dvReefPenalty").value.split(",").map(s => parseFloat(s.trim())).filter(n => !isNaN(n))
          };
          Object.assign(window.OS.boat, fields);
          await sbClient.from("boats").update(fields).eq("id", window.OS.boat.id);
          logEvent("info", "Applied preset values to your live boat for testing.");
          alert("Applied! Your boat now uses these stats live — try sailing to feel the difference.");
        });
      }
    }
  }

  /* ---------------------------------------------------------------
     BOAT DESIGNER TAB — live parametric 3D boat design. Sliders/color
     pickers drive window.OSHelm3D.rebuildBoat() directly so the boat
     visible in the Helm view above updates in real time as you drag,
     before anything is saved anywhere.
     --------------------------------------------------------------- */
  const DESIGNER_TYPES = [
    { key: "hullType", label: "Hull Type", options: [
      { value: "cruiser", label: "Cruiser" },
      { value: "racer", label: "Racer" },
      { value: "trawler", label: "Trawler" },
      { value: "catamaran", label: "Catamaran" }
    ]},
    { key: "cabinType", label: "Cabin Top Type", options: [
      { value: "trunk", label: "Trunk Cabin" },
      { value: "flush", label: "Flush Deck" },
      { value: "pilothouse", label: "Pilothouse" }
    ]},
    { key: "keelType", label: "Keel Type", options: [
      { value: "fin", label: "Fin Keel" },
      { value: "full", label: "Full Keel" },
      { value: "wing", label: "Wing Keel" }
    ]},
    { key: "biminiType", label: "Bimini Type", options: [
      { value: "bimini", label: "Bimini (canvas)" },
      { value: "hardtop", label: "Hardtop" },
      { value: "none", label: "None (open cockpit)" }
    ]},
    { key: "lifelineType", label: "Lifeline Type", options: [
      { value: "single", label: "Single Line" },
      { value: "double", label: "Double Line" },
      { value: "none", label: "None" }
    ]},
    { key: "helmType", label: "Steering Type", options: [
      { value: "wheel", label: "Wheel" },
      { value: "tiller", label: "Tiller" }
    ]}
  ];

  const DESIGNER_FIELDS = [
    { key: "hullLength", label: "Hull Length", min: 4, max: 12, step: 0.1 },
    { key: "hullWidth", label: "Hull Width (Beam)", min: 1.2, max: 4, step: 0.1 },
    { key: "freeboard", label: "Freeboard (above water)", min: 0.4, max: 3, step: 0.1 },
    { key: "depth", label: "Hull Depth (below water)", min: 0.4, max: 3, step: 0.1 },
    { key: "mastHeight", label: "Mast Height", min: 4, max: 16, step: 0.2 },
    { key: "cabinLength", label: "Cabin Length", min: 1, max: 5, step: 0.1 },
    { key: "cabinWidth", label: "Cabin Width", min: 0.8, max: 3, step: 0.1 },
    { key: "cabinHeight", label: "Cabin Height", min: 0.4, max: 1.6, step: 0.05 },
    { key: "cabinOffsetZ", label: "Cabin Position (fore/aft)", min: -1.5, max: 1.5, step: 0.1 },
    { key: "biminiWidth", label: "Bimini Width", min: 0.8, max: 2.5, step: 0.1 },
    { key: "biminiLength", label: "Bimini Length", min: 0.8, max: 3, step: 0.1 }
  ];
  const DESIGNER_COLORS = [
    { key: "hullColor", label: "Hull Color" },
    { key: "deckColor", label: "Deck Color" },
    { key: "cabinColor", label: "Cabin Color" },
    { key: "sailColor", label: "Sail Color" },
    { key: "biminiColor", label: "Bimini Color" },
    { key: "spinnakerColor", label: "Spinnaker Color" }
  ];

  let designerDNA = null;

  function colorToHex(num) {
    return "#" + (num || 0).toString(16).padStart(6, "0");
  }
  function hexToColorInt(hex) {
    return parseInt(hex.replace("#", ""), 16);
  }

  function renderDesignerTab() {
    const content = document.getElementById("osDevTabContent");
    if (typeof window.OSHelm3D === "undefined") {
      content.innerHTML = `<div class="osDevError">3D Helm view isn't loaded.</div>`;
      return;
    }

    /* Start from this boat's saved design if it has one, otherwise
       the generator's defaults (today's boat as it ships). Only set
       designerDNA fresh the first time this tab opens — re-renders
       from a type change reuse the in-progress object so other
       slider tweaks aren't lost. */
    if (!designerDNA) {
      designerDNA = JSON.parse(JSON.stringify(
        (window.OS.boat && window.OS.boat.hull_design) || window.OSHelm3D.getCurrentBoatDNA() || window.OSHelm3D.getDefaultBoatDNA()
      ));
    }

    content.innerHTML = `
      <div class="osDevSection">
        <div class="osDevSectionHeader"><span>Boat Designer</span></div>
        <p class="osDevHint">Pick a type for each part, then use the sliders below to scale it. The boat in the Helm view above updates instantly. Nothing saves until you choose an action below.</p>

        <div class="osDevSectionHeader" style="margin-top:4px;"><span>Model Source</span></div>
        <div class="osDevFormGrid">
          <label class="osDevFullWidth">
            <select id="dsModelSource">
              <option value="procedural" ${!designerDNA.modelUrl ? "selected" : ""}>Procedural (build from sliders below)</option>
              <option value="imported" ${designerDNA.modelUrl ? "selected" : ""}>Imported Model (.glb/.gltf URL)</option>
            </select>
          </label>
        </div>
        <div id="osDevImportedModelRow" style="display:${designerDNA.modelUrl ? "block" : "none"};margin-bottom:12px;">
          <div class="osDevFormGrid">
            <label class="osDevFullWidth">
              Model URL (.glb or .gltf)
              <input type="text" id="dsModelUrl" value="${designerDNA.modelUrl || ""}" placeholder="https://raw.githubusercontent.com/.../boat.glb">
            </label>
          </div>
          <p class="osDevHint">Free models: <strong>kenney.nl</strong>, <strong>quaternius.com</strong>, or CC0/CC-BY models from <strong>sketchfab.com</strong> — export/download as glTF Binary (.glb) and host it somewhere reachable (e.g. a GitHub repo's raw file URL). The whole boat still heels/pitches/rocks with real wind and wave data; sail/boom-specific animation only works on procedural boats for now.</p>
          <div class="osDevFormActions">
            <button class="osDevBtnSecondary" id="osDevPreviewModelBtn">Preview This Model</button>
          </div>
        </div>

        <div id="osDevProceduralControls" style="display:${designerDNA.modelUrl ? "none" : "block"};">
          <div class="osDevDesignerTypes" id="osDevDesignerTypes"></div>
          <div class="osDevSectionHeader" style="margin-top:14px;"><span>Dimensions</span></div>
          <div class="osDevDesignerSliders" id="osDevDesignerSliders"></div>
          <div class="osDevSectionHeader" style="margin-top:14px;"><span>Colors</span></div>
          <div class="osDevDesignerColors" id="osDevDesignerColors"></div>
        </div>

        <div class="osDevSectionHeader" style="margin-top:14px;"><span>Buoyancy</span></div>
        <p class="osDevHint">How high or low the boat sits relative to the water surface — raise this if big swells are taking the deck underwater, lower it if the boat looks like it's floating above the water instead of sitting in it. This is a live rendering tweak, not saved with the boat design.</p>
        <div class="osDevFormGrid">
          <label class="osDevFullWidth">
            Float Height <span class="osDevSliderVal" id="dsBuoyancyVal">${(window.OSDevBuoyancyOffset != null ? window.OSDevBuoyancyOffset : 0.3).toFixed(2)}</span>
            <input type="range" id="dsBuoyancyOffset" min="-1" max="2" step="0.05" value="${window.OSDevBuoyancyOffset != null ? window.OSDevBuoyancyOffset : 0.3}">
          </label>
        </div>

        <div class="osDevFormActions" style="margin-top:14px;">
          <button class="osDevBtn" id="osDevApplyToMeBtn">Apply to My Boat</button>
          <button class="osDevBtnSecondary" id="osDevSaveAsPresetBtn">Save as New Preset</button>
          <button class="osDevBtnSecondary" id="osDevResetDesignBtn">Reset to Default Shape</button>
        </div>
      </div>
    `;

    document.getElementById("dsModelSource").addEventListener("change", (e) => {
      const importedRow = document.getElementById("osDevImportedModelRow");
      const proceduralWrap = document.getElementById("osDevProceduralControls");
      if (e.target.value === "imported") {
        importedRow.style.display = "block";
        proceduralWrap.style.display = "none";
        designerDNA.modelUrl = document.getElementById("dsModelUrl").value || null;
      } else {
        importedRow.style.display = "none";
        proceduralWrap.style.display = "block";
        designerDNA.modelUrl = null;
      }
      window.OSHelm3D.rebuildBoat(designerDNA);
    });

    const modelUrlInput = document.getElementById("dsModelUrl");
    if (modelUrlInput) {
      modelUrlInput.addEventListener("change", () => {
        designerDNA.modelUrl = modelUrlInput.value.trim() || null;
      });
    }
    const previewModelBtn = document.getElementById("osDevPreviewModelBtn");
    if (previewModelBtn) {
      previewModelBtn.addEventListener("click", () => {
        designerDNA.modelUrl = document.getElementById("dsModelUrl").value.trim() || null;
        if (!designerDNA.modelUrl) { alert("Enter a model URL first."); return; }
        window.OSHelm3D.rebuildBoat(designerDNA);
        logEvent("info", "Previewing imported model: " + designerDNA.modelUrl);
      });
    }

    const buoyancySlider = document.getElementById("dsBuoyancyOffset");
    if (buoyancySlider) {
      buoyancySlider.addEventListener("input", () => {
        const val = parseFloat(buoyancySlider.value);
        window.OSDevBuoyancyOffset = val;
        document.getElementById("dsBuoyancyVal").textContent = val.toFixed(2);
      });
    }

    const typeWrap = document.getElementById("osDevDesignerTypes");
    DESIGNER_TYPES.forEach(t => {
      const row = document.createElement("div");
      row.className = "osDevSliderRow";
      const optionsHtml = t.options.map(o =>
        `<option value="${o.value}" ${designerDNA[t.key] === o.value ? "selected" : ""}>${o.label}</option>`
      ).join("");
      row.innerHTML = `
        <label class="osDevSliderLabel">${t.label}</label>
        <select class="osDevTypeSelect" id="dt_${t.key}">${optionsHtml}</select>
      `;
      typeWrap.appendChild(row);

      const select = row.querySelector("select");
      select.addEventListener("change", () => {
        designerDNA[t.key] = select.value;
        window.OSHelm3D.rebuildBoat(designerDNA);
        /* Re-render fully since switching types can change which
           sliders are even relevant (kept simple rather than trying
           to diff the form — type changes are infrequent) */
        renderDesignerTab();
      });
    });

    const sliderWrap = document.getElementById("osDevDesignerSliders");
    DESIGNER_FIELDS.forEach(f => {
      const row = document.createElement("div");
      row.className = "osDevSliderRow";
      row.innerHTML = `
        <label class="osDevSliderLabel">${f.label} <span class="osDevSliderVal" id="dsVal_${f.key}">${designerDNA[f.key]}</span></label>
        <input type="range" class="osDevSlider" id="ds_${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" value="${designerDNA[f.key]}">
      `;
      sliderWrap.appendChild(row);

      const slider = row.querySelector("input");
      slider.addEventListener("input", () => {
        const val = parseFloat(slider.value);
        designerDNA[f.key] = val;
        document.getElementById(`dsVal_${f.key}`).textContent = val;
        window.OSHelm3D.rebuildBoat(designerDNA);
      });
    });

    const colorWrap = document.getElementById("osDevDesignerColors");
    DESIGNER_COLORS.forEach(c => {
      const row = document.createElement("div");
      row.className = "osDevColorRow";
      row.innerHTML = `
        <label class="osDevSliderLabel">${c.label}</label>
        <input type="color" class="osDevColorInput" id="dc_${c.key}" value="${colorToHex(designerDNA[c.key])}">
      `;
      colorWrap.appendChild(row);

      const input = row.querySelector("input");
      input.addEventListener("input", () => {
        designerDNA[c.key] = hexToColorInt(input.value);
        window.OSHelm3D.rebuildBoat(designerDNA);
      });
    });

    /* Render once immediately with the loaded DNA so the preview
       matches the sliders right away, not just after the first drag */
    window.OSHelm3D.rebuildBoat(designerDNA);

    document.getElementById("osDevApplyToMeBtn").addEventListener("click", async () => {
      if (!window.OS.boat) return;
      window.OS.boat.hull_design = designerDNA;
      const { error } = await sbClient.from("boats").update({ hull_design: designerDNA }).eq("id", window.OS.boat.id);
      if (error) { alert("Save failed: " + error.message); logEvent("error", "Apply design failed: " + error.message); }
      else { logEvent("info", "Applied custom hull design to your boat."); alert("Applied — your boat now uses this design permanently."); }
    });

    document.getElementById("osDevSaveAsPresetBtn").addEventListener("click", async () => {
      const key = prompt("Preset key (short slug, e.g. 'racer'):");
      if (!key) return;
      const name = prompt("Display name:", key);
      if (!name) return;
      const { error } = await sbClient.from("boat_presets").insert({
        preset_key: key.trim().toLowerCase(),
        display_name: name.trim(),
        hull_design: designerDNA,
        hull_speed_kt: 6.5,
        rated_wind_mph: 15
      });
      if (error) { alert("Save failed: " + error.message); logEvent("error", "Save preset failed: " + error.message); }
      else { logEvent("info", "Saved new preset with custom hull design: " + name); alert("Saved as a new vessel preset."); }
    });

    document.getElementById("osDevResetDesignBtn").addEventListener("click", () => {
      designerDNA = window.OSHelm3D.getDefaultBoatDNA();
      window.OSHelm3D.rebuildBoat(designerDNA);
      renderDesignerTab();
    });
  }

  /* ---------------------------------------------------------------
     BOAT STATE TAB — every raw field on your own boat, live-editable
     --------------------------------------------------------------- */
  function renderStateTab() {
    const content = document.getElementById("osDevTabContent");
    if (!window.OS.boat) {
      content.innerHTML = `<div class="osDevError">No boat loaded.</div>`;
      return;
    }

    const boat = window.OS.boat;
    const fieldOrder = Object.keys(boat).sort();

    content.innerHTML = `
      <div class="osDevSection">
        <div class="osDevSectionHeader">
          <span>Live Boat State — ${boat.captain_name} / ${boat.vessel_name}</span>
          <button class="osDevBtn" id="osDevRefreshStateBtn">Refresh</button>
        </div>
        <div class="osDevStateGrid" id="osDevStateGrid"></div>
        <div class="osDevFormActions">
          <button class="osDevBtn" id="osDevApplyStateBtn">Apply Changes</button>
          <button class="osDevBtnSecondary osDevBtnDanger" id="osDevResetBoatBtn">Reset My Boat</button>
        </div>
      </div>
    `;

    const grid = document.getElementById("osDevStateGrid");
    fieldOrder.forEach(key => {
      const val = boat[key];
      const isObj = val !== null && typeof val === "object";
      const displayVal = isObj ? JSON.stringify(val) : val;
      const row = document.createElement("div");
      row.className = "osDevStateRow";
      row.innerHTML = `
        <label class="osDevStateKey">${key}</label>
        <input type="text" class="osDevStateInput" data-field="${key}" value="${displayVal == null ? "" : String(displayVal).replace(/"/g, "&quot;")}">
      `;
      grid.appendChild(row);
    });

    document.getElementById("osDevRefreshStateBtn").addEventListener("click", async () => {
      await window.OS.refreshBoat();
      renderStateTab();
    });

    document.getElementById("osDevApplyStateBtn").addEventListener("click", async () => {
      const updates = {};
      grid.querySelectorAll(".osDevStateInput").forEach(input => {
        const key = input.dataset.field;
        if (["id", "device_id", "created_at"].includes(key)) return; /* don't let these be edited */
        const raw = input.value;
        let parsed = raw;
        if (raw === "true") parsed = true;
        else if (raw === "false") parsed = false;
        else if (raw === "") parsed = null;
        else if (!isNaN(parseFloat(raw)) && /^-?[\d.]+$/.test(raw)) parsed = parseFloat(raw);
        else if ((raw.startsWith("[") || raw.startsWith("{")) ) {
          try { parsed = JSON.parse(raw); } catch (e) { /* leave as string */ }
        }
        updates[key] = parsed;
      });
      Object.assign(window.OS.boat, updates);
      const { error } = await sbClient.from("boats").update(updates).eq("id", window.OS.boat.id);
      if (error) { alert("Apply failed: " + error.message); logEvent("error", "State apply failed: " + error.message); }
      else { logEvent("info", "Applied manual state edits to boat."); alert("Applied."); }
    });

    document.getElementById("osDevResetBoatBtn").addEventListener("click", async () => {
      if (!confirm("Reset your boat? This restores food/water/fuel/hull to full and returns you to your last set position. Stats stay as-is.")) return;
      const resets = { food: 100, water: 100, fuel: 100, hull_health: 100, sailing_active: false, engine_on: false };
      Object.assign(window.OS.boat, resets);
      await sbClient.from("boats").update(resets).eq("id", window.OS.boat.id);
      logEvent("info", "Boat reset (supplies/hull restored, engine/sails stopped).");
      renderStateTab();
    });
  }

  /* ---------------------------------------------------------------
     WEATHER TAB — override wind speed/direction for testing
     --------------------------------------------------------------- */
  function renderWeatherTab() {
    const content = document.getElementById("osDevTabContent");
    const override = window.OSDevWeatherOverride || { active: false, speedMph: 15, dirDeg: 270 };
    const swellOverride = window.OSDevSwellOverride || { active: false, heightFt: 3 };

    content.innerHTML = `
      <div class="osDevSection">
        <div class="osDevSectionHeader"><span>Weather Override</span></div>
        <p class="osDevHint">Forces a fixed wind speed/direction instead of the real forecast, for testing specific conditions on demand. Only affects your live client session right now — while this browser tab is open, every sailing calculation (point of sail, heel, wind streaks, windex) uses this instead of the real forecast. The server's background tick (which moves the boat while the app is closed) always uses real weather, regardless of this setting.</p>
        <div class="osDevFormGrid">
          <label class="osDevCheckboxLabel"><input type="checkbox" id="dwActive" ${override.active ? "checked" : ""}> Override active</label>
          <label>Wind Speed (mph) <input type="number" id="dwSpeed" value="${override.speedMph}"></label>
          <label>Wind From (deg, compass) <input type="number" id="dwDir" value="${override.dirDeg}"></label>
        </div>
        <div class="osDevFormActions">
          <button class="osDevBtn" id="osDevApplyWeatherBtn">Apply</button>
        </div>
      </div>

      <div class="osDevSection">
        <div class="osDevSectionHeader"><span>Swell / Wave Height Override</span></div>
        <p class="osDevHint">Normally swell height is just derived from wind speed (windSpeedKt / 10 * 1.8 ft). Use this to set it directly instead, for tuning how big the rolling swells in the Helm view look/feel independent of current wind.</p>
        <div class="osDevFormGrid">
          <label class="osDevCheckboxLabel"><input type="checkbox" id="dsSwellActive" ${swellOverride.active ? "checked" : ""}> Override active</label>
          <label class="osDevFullWidth">
            Swell Height (ft) <span class="osDevSliderVal" id="dsSwellVal">${swellOverride.heightFt}</span>
            <input type="range" id="dsSwellHeight" min="0" max="15" step="0.5" value="${swellOverride.heightFt}">
          </label>
        </div>
        <div class="osDevFormActions">
          <button class="osDevBtn" id="osDevApplySwellBtn">Apply</button>
        </div>
      </div>
    `;

    document.getElementById("osDevApplyWeatherBtn").addEventListener("click", () => {
      window.OSDevWeatherOverride = {
        active: document.getElementById("dwActive").checked,
        speedMph: parseFloat(document.getElementById("dwSpeed").value) || 15,
        dirDeg: parseFloat(document.getElementById("dwDir").value) || 0
      };
      logEvent("info", "Weather override " + (window.OSDevWeatherOverride.active ? "enabled" : "disabled") +
        ` (${window.OSDevWeatherOverride.speedMph}mph from ${window.OSDevWeatherOverride.dirDeg}°)`);
      alert("Weather override updated.");
    });

    const swellSlider = document.getElementById("dsSwellHeight");
    swellSlider.addEventListener("input", () => {
      document.getElementById("dsSwellVal").textContent = swellSlider.value;
    });

    document.getElementById("osDevApplySwellBtn").addEventListener("click", () => {
      window.OSDevSwellOverride = {
        active: document.getElementById("dsSwellActive").checked,
        heightFt: parseFloat(swellSlider.value) || 3
      };
      logEvent("info", "Swell override " + (window.OSDevSwellOverride.active ? "enabled" : "disabled") +
        ` (${window.OSDevSwellOverride.heightFt}ft)`);
      alert("Swell override updated.");
    });
  }

  /* ---------------------------------------------------------------
     TELEPORT TAB — jump the boat to any lat/lon instantly
     --------------------------------------------------------------- */
  function renderTeleportTab() {
    const content = document.getElementById("osDevTabContent");
    const boat = window.OS.boat;

    content.innerHTML = `
      <div class="osDevSection">
        <div class="osDevSectionHeader"><span>Teleport</span></div>
        <p class="osDevHint">Current position: ${boat ? boat.lat.toFixed(4) + ", " + boat.lon.toFixed(4) : "—"}</p>
        <div class="osDevFormGrid">
          <label>Latitude <input type="number" step="0.0001" id="dtLat" value="${boat ? boat.lat : 0}"></label>
          <label>Longitude <input type="number" step="0.0001" id="dtLon" value="${boat ? boat.lon : 0}"></label>
        </div>
        <div class="osDevFormActions">
          <button class="osDevBtn" id="osDevTeleportBtn">Teleport</button>
        </div>
        <div class="osDevSectionHeader" style="margin-top:16px;"><span>Quick Spots</span></div>
        <div class="osDevQuickSpots" id="osDevQuickSpots"></div>
      </div>
    `;

    const spots = [
      { name: "Portland, ME (start)", lat: 43.6591, lon: -70.2568 },
      { name: "Cape Cod, MA", lat: 41.6688, lon: -70.2962 },
      { name: "New York Harbor", lat: 40.6892, lon: -74.0445 },
      { name: "Chesapeake Bay", lat: 37.0, lon: -76.2 },
      { name: "Charleston, SC", lat: 32.7765, lon: -79.9311 },
      { name: "Miami, FL", lat: 25.7617, lon: -80.1918 },
      { name: "Panama Canal", lat: 9.08, lon: -79.68 },
      { name: "San Diego, CA", lat: 32.7157, lon: -117.1611 },
      { name: "Astoria, OR (finish)", lat: 46.1879, lon: -123.8313 }
    ];
    const spotsEl = document.getElementById("osDevQuickSpots");
    spots.forEach(s => {
      const btn = document.createElement("button");
      btn.className = "osDevBtnSmall";
      btn.textContent = s.name;
      btn.addEventListener("click", () => {
        document.getElementById("dtLat").value = s.lat;
        document.getElementById("dtLon").value = s.lon;
      });
      spotsEl.appendChild(btn);
    });

    document.getElementById("osDevTeleportBtn").addEventListener("click", async () => {
      const lat = parseFloat(document.getElementById("dtLat").value);
      const lon = parseFloat(document.getElementById("dtLon").value);
      if (isNaN(lat) || isNaN(lon)) { alert("Enter valid coordinates."); return; }
      if (!window.OS.boat) return;
      window.OS.boat.lat = lat;
      window.OS.boat.lon = lon;
      await sbClient.from("boats").update({ lat, lon }).eq("id", window.OS.boat.id);
      logEvent("info", `Teleported to ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
      if (typeof window.OSHelm3D !== "undefined") window.OSHelm3D.updateGroundTexture(lat, lon);
      renderTeleportTab();
    });
  }

  /* ---------------------------------------------------------------
     UI CONFIG TAB — global theme/defaults applied to every player
     --------------------------------------------------------------- */
  async function renderUiConfigTab() {
    const content = document.getElementById("osDevTabContent");
    content.innerHTML = `<div class="osDevLoading">Loading global config…</div>`;

    const { data, error } = await sbClient.from("app_config").select("*").eq("id", 1).single();
    if (error) {
      content.innerHTML = `<div class="osDevError">Failed to load app_config: ${error.message}</div>`;
      return;
    }

    const config = data.config || {};
    content.innerHTML = `
      <div class="osDevSection">
        <div class="osDevSectionHeader"><span>New Player Defaults</span></div>
        <p class="osDevHint">These apply to new players' first load (read from this table before script.js even runs). Existing players who've already customised their settings are never overwritten.</p>
        <div class="osDevFormGrid">
          <label>Dashboard Background Color
            <input type="color" id="dcBgColor" value="${config.dashboardBackgroundColor || "#07131c"}">
          </label>
          <label>Default Widget Theme
            <select id="dcTheme">
              <option value="clean" ${(!config.defaultTheme || config.defaultTheme === "clean") ? "selected" : ""}>Clean</option>
            </select>
          </label>
          <label>Default Compass Mode
            <select id="dcCompassMode">
              <option value="radar" ${(!config.compassMapMode || config.compassMapMode === "radar") ? "selected" : ""}>Radar</option>
              <option value="satellite" ${config.compassMapMode === "satellite" ? "selected" : ""}>Satellite</option>
            </select>
          </label>
          <label>Default Compass Style
            <select id="dcCompassStyle">
              <option value="none" ${(!config.compassStyle || config.compassStyle === "none") ? "selected" : ""}>No Ring</option>
              <option value="ring" ${config.compassStyle === "ring" ? "selected" : ""}>Ring</option>
            </select>
          </label>
          <label>Default Compass Zoom
            <input type="number" id="dcCompassZoom" value="${config.compassZoom || 17}" min="2" max="19">
          </label>
        </div>
        <div class="osDevFormActions">
          <button class="osDevBtn" id="osDevSaveFriendlyBtn">Save Defaults</button>
        </div>
      </div>

      <div class="osDevSection">
        <div class="osDevSectionHeader"><span>Raw Config (advanced)</span></div>
        <p class="osDevHint">Full JSON for anything not covered above. Editing the friendly fields and saving above also updates these same keys here.</p>
        <textarea id="dcConfigJson" class="osDevJsonEditor" rows="10">${JSON.stringify(config, null, 2)}</textarea>
        <div class="osDevFormActions">
          <button class="osDevBtn" id="osDevSaveConfigBtn">Save Raw JSON</button>
        </div>
      </div>
    `;

    document.getElementById("osDevSaveFriendlyBtn").addEventListener("click", async () => {
      const updated = {
        ...config,
        dashboardBackgroundColor: document.getElementById("dcBgColor").value,
        defaultTheme: document.getElementById("dcTheme").value,
        compassMapMode: document.getElementById("dcCompassMode").value,
        compassStyle: document.getElementById("dcCompassStyle").value,
        compassZoom: parseInt(document.getElementById("dcCompassZoom").value, 10) || 17
      };
      const { error: saveErr } = await sbClient
        .from("app_config")
        .update({ config: updated, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (saveErr) { alert("Save failed: " + saveErr.message); logEvent("error", "UI config save failed: " + saveErr.message); }
      else { logEvent("info", "Saved new-player defaults (background/theme/compass)."); alert("Saved — new players will get these on their first load."); }
    });

    document.getElementById("osDevSaveConfigBtn").addEventListener("click", async () => {
      let parsed;
      try {
        parsed = JSON.parse(document.getElementById("dcConfigJson").value);
      } catch (e) {
        alert("Invalid JSON: " + e.message);
        return;
      }
      const { error: saveErr } = await sbClient
        .from("app_config")
        .update({ config: parsed, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (saveErr) { alert("Save failed: " + saveErr.message); logEvent("error", "UI config save failed: " + saveErr.message); }
      else { logEvent("info", "Global UI config saved."); alert("Saved — will apply to all players on their next load."); }
    });
  }

  /* ---------------------------------------------------------------
     MAP EDITOR TAB — stub for now, real geodata editor is a future project
     --------------------------------------------------------------- */
  function renderMapTab() {
    const content = document.getElementById("osDevTabContent");
    content.innerHTML = `
      <div class="osDevSection">
        <div class="osDevSectionHeader"><span>Map Editor</span></div>
        <div class="osDevPlaceholder">
          <div class="osDevPlaceholderIcon">🗺️</div>
          <div class="osDevPlaceholderText">
            Coming in a future build: an auto-generated coastline/depth system (built from real
            chart data) with hand-correction tools layered on top, editable right here.
          </div>
        </div>
      </div>
    `;
  }

  /* ---------------------------------------------------------------
     EVENT LOG TAB
     --------------------------------------------------------------- */
  function renderLogTab() {
    const content = document.getElementById("osDevTabContent");
    content.innerHTML = `
      <div class="osDevSection">
        <div class="osDevSectionHeader">
          <span>Event Log (${devLog.length})</span>
          <button class="osDevBtnSmall" id="osDevClearLogBtn">Clear</button>
        </div>
        <div class="osDevLogList" id="osDevLogList"></div>
      </div>
    `;
    const list = document.getElementById("osDevLogList");
    devLog.slice().reverse().forEach(entry => {
      const row = document.createElement("div");
      row.className = "osDevLogRow osDevLogRow-" + entry.level;
      const time = new Date(entry.time).toLocaleTimeString();
      row.innerHTML = `<span class="osDevLogTime">${time}</span><span class="osDevLogMsg">${entry.message}</span>`;
      list.appendChild(row);
    });
    document.getElementById("osDevClearLogBtn").addEventListener("click", () => {
      devLog = [];
      renderLogTab();
    });
  }

  window.OSDevConsole = { init, logEvent };
})();
