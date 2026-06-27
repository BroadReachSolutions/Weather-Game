/* ============================================================
   Oregon Sail — Dynamic Tab System
   Two-level tab UI: 5 fixed main tabs, each with user-defined
   sub-tabs (add via "+", rename, persisted), each sub-tab holding
   a freely-editable set of widgets (long-press to add/remove).

   Real widgets (helmgauges, chartplotter, navgauges, track) are
   physical DOM nodes living in #osWidgetTemplates — this module
   MOVES them between sub-tabs rather than rebuilding them, so
   instruments.js/game-ui.js's direct element references keep
   working unchanged regardless of which sub-tab is showing them.
   Placeholder widgets (radar, depth, etc) are cloned freely since
   they're inert.
   ============================================================ */

(function () {
  const STORAGE_KEY = "osTabConfig";
  const CONFIG_VERSION = 6; /* bumped: battery panel added to Systems > Electrical defaults */

  /* Which widget ids are offered for each main tab's "+ Add Widget"
     picker. Placeholders are listed here even though they're not
     real systems yet, per the request to have the framework fully
     exercise-able now. */
  const WIDGET_CATALOG = {
    cockpit: [
      { id: "sailtrim", label: "Sail Trim" },
      { id: "wheel", label: "Wheel / Helm" },
      { id: "engine", label: "Engine" },
      { id: "speed", label: "Speed" },
      { id: "windex", label: "Windex" },
      { id: "radar", label: "Radar" },
      { id: "depth", label: "Depth" },
      { id: "tridata", label: "Tri-Data" },
      { id: "windtransducer", label: "Wind Transducer" }
    ],
    navstation: [
      { id: "chartplotter", label: "Chart Plotter (Satellite Map)" },
      { id: "station", label: "Station / Tide / Edit Layout Controls" },
      { id: "compass", label: "Wind Compass" },
      { id: "forecast", label: "Weather Forecast" },
      { id: "tidechart", label: "Tide Chart" },
      { id: "lightpanel", label: "DC Lighting Panel" },
      { id: "water", label: "Water Gauge" },
      { id: "food", label: "Food Gauge" },
      { id: "hull", label: "Hull Gauge" },
      { id: "track", label: "Track Controls" }
    ],
    crew: [],   /* no widgets yet — real crew system is future work */
    systems: [
      { id: "batterypanel", label: "Battery Bank" }
    ],
    storage: []
  };

  function defaultConfig() {
    return {
      version: CONFIG_VERSION,
      mains: [
        { id: "cockpit", label: "Cockpit", subtabs: [
          { id: "helm", label: "Helm", widgets: ["sailtrim", "wheel", "engine", "speed", "windex"] }
        ]},
        { id: "navstation", label: "Nav Station", subtabs: [
          { id: "weather", label: "Weather", widgets: ["chartplotter", "station", "compass", "forecast", "tidechart", "lightpanel", "water", "food", "hull", "track"] }
        ]},
        { id: "crew", label: "Crew", subtabs: [
          { id: "health", label: "Health", widgets: [] },
          { id: "morale", label: "Morale", widgets: [] },
          { id: "skills", label: "Skills", widgets: [] }
        ]},
        { id: "systems", label: "Systems", subtabs: [
          { id: "electrical", label: "Electrical", widgets: ["batterypanel"] },
          { id: "pumping", label: "Pumping", widgets: [] },
          { id: "mechanical", label: "Mechanical", widgets: [] }
        ]},
        { id: "storage", label: "Storage", subtabs: [
          { id: "fridge", label: "Fridge", widgets: [] },
          { id: "pantry", label: "Pantry", widgets: [] },
          { id: "other", label: "Other", widgets: [] }
        ]}
      ]
    };
  }

  let config = loadConfig();
  let activeMainId = config.mains[0].id;
  let activeSubId = config.mains[0].subtabs[0] ? config.mains[0].subtabs[0].id : null;

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultConfig();
      const parsed = JSON.parse(raw);
      if (parsed.version !== CONFIG_VERSION) return defaultConfig();
      return parsed;
    } catch (e) {
      return defaultConfig();
    }
  }

  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  function getMain(id) {
    return config.mains.find(m => m.id === id);
  }
  function getSub(mainId, subId) {
    const main = getMain(mainId);
    return main ? main.subtabs.find(s => s.id === subId) : null;
  }

  /* ---------------------------------------------------------------
     RENDER — main tab bar
     --------------------------------------------------------------- */
  function renderMainTabs() {
    const bar = document.getElementById("osMainTabBar");
    if (!bar) return;
    bar.innerHTML = "";
    config.mains.forEach(main => {
      const btn = document.createElement("button");
      btn.className = "osMainTab" + (main.id === activeMainId ? " active" : "");
      btn.textContent = main.label;
      btn.addEventListener("click", () => {
        activeMainId = main.id;
        const main2 = getMain(activeMainId);
        activeSubId = main2.subtabs[0] ? main2.subtabs[0].id : null;
        renderMainTabs();
        renderSubTabs();
      });
      bar.appendChild(btn);
    });
  }

  /* ---------------------------------------------------------------
     RENDER — sub-tab row (with rename + "+" to add)
     --------------------------------------------------------------- */
  function renderSubTabs() {
    const bar = document.getElementById("osSubTabBar");
    if (!bar) return;
    bar.innerHTML = "";
    const main = getMain(activeMainId);
    if (!main) return;

    main.subtabs.forEach(sub => {
      const btn = document.createElement("button");
      btn.className = "osSubTab" + (sub.id === activeSubId ? " active" : "");
      btn.textContent = sub.label;
      btn.addEventListener("click", () => {
        activeSubId = sub.id;
        renderSubTabs();
        renderContent();
      });
      /* Double-click/double-tap to rename, since a single tap needs
         to stay a plain "switch to this tab" action */
      btn.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        renameSubTab(main, sub);
      });
      bar.appendChild(btn);
    });

    const addBtn = document.createElement("button");
    addBtn.className = "osSubTabAdd";
    addBtn.textContent = "+";
    addBtn.title = "Add a new tab";
    addBtn.addEventListener("click", () => addSubTab(main));
    bar.appendChild(addBtn);

    renderContent();
  }

  function renameSubTab(main, sub) {
    const newName = prompt("Rename tab:", sub.label);
    if (!newName || !newName.trim()) return;
    sub.label = newName.trim().slice(0, 24);
    saveConfig();
    renderSubTabs();
  }

  function addSubTab(main) {
    const name = prompt("Name for the new tab:", "New Tab");
    if (!name || !name.trim()) return;
    const id = "custom_" + Date.now();
    main.subtabs.push({ id, label: name.trim().slice(0, 24), widgets: [] });
    activeSubId = id;
    saveConfig();
    renderSubTabs();
  }

  /* ---------------------------------------------------------------
     FREE WIDGET POSITIONING + RESIZE
     Every widget card is absolutely positioned within its sub-tab's
     content area, with a small grip handle (top-left) to drag it
     anywhere and a resize handle (bottom-right) to resize it. Both
     position and size are stored per widget id, per sub-tab, inside
     that sub-tab's own config object.
     --------------------------------------------------------------- */
  function nextDefaultPosition(sub, index) {
    /* Cascade new widgets diagonally so they don't all land exactly
       on top of each other before the player has dragged anything */
    const col = index % 4;
    const row = Math.floor(index / 4);
    return { x: 8 + col * 40, y: 8 + row * 40 };
  }

  function applyStoredLayout(node, sub, widgetId, index) {
    const positions = sub.positions || {};
    const sizes = sub.sizes || {};
    const pos = positions[widgetId] || nextDefaultPosition(sub, index);
    const size = sizes[widgetId];
    node.style.left = pos.x + "px";
    node.style.top = pos.y + "px";
    if (size) {
      node.style.width = size.w + "px";
      node.style.height = size.h + "px";
    }
  }

  function attachGripHandle(node, sub, widgetId) {
    if (node.querySelector(".osWidgetGripHandle")) return;
    const grip = document.createElement("div");
    grip.className = "osWidgetGripHandle";
    grip.innerHTML = "⠿";
    node.appendChild(grip);

    let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;

    function getXY(e) {
      if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    function onDown(e) {
      e.preventDefault();
      e.stopPropagation(); /* don't also trigger the long-press editor */
      dragging = true;
      const { x, y } = getXY(e);
      startX = x; startY = y;
      startLeft = node.offsetLeft; startTop = node.offsetTop;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
    }

    function onMove(e) {
      if (!dragging) return;
      e.preventDefault();
      const { x, y } = getXY(e);
      const parent = node.parentElement;
      const maxLeft = Math.max(0, parent.clientWidth - node.offsetWidth);
      const maxTop = Math.max(0, parent.clientHeight - node.offsetHeight);
      let newLeft = startLeft + (x - startX);
      let newTop = startTop + (y - startY);
      newLeft = Math.max(0, Math.min(maxLeft, newLeft));
      newTop = Math.max(0, Math.min(maxTop, newTop));
      node.style.left = newLeft + "px";
      node.style.top = newTop + "px";
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      if (!sub.positions) sub.positions = {};
      sub.positions[widgetId] = { x: node.offsetLeft, y: node.offsetTop };
      saveConfig();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    }

    grip.addEventListener("mousedown", onDown);
    grip.addEventListener("touchstart", onDown, { passive: false });
  }

  function attachResizeHandle(node, sub, widgetId) {
    if (node.querySelector(".osWidgetResizeHandle")) return; /* already has one */
    const handle = document.createElement("div");
    handle.className = "osWidgetResizeHandle";
    node.appendChild(handle);

    let startX = 0, startY = 0, startW = 0, startH = 0, dragging = false;

    function getXY(e) {
      if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    function onDown(e) {
      e.preventDefault();
      e.stopPropagation(); /* don't let this also trigger the long-press editor */
      dragging = true;
      const { x, y } = getXY(e);
      startX = x; startY = y;
      startW = node.offsetWidth; startH = node.offsetHeight;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onUp);
    }

    function onMove(e) {
      if (!dragging) return;
      e.preventDefault();
      const { x, y } = getXY(e);
      const newW = Math.max(80, startW + (x - startX));
      const newH = Math.max(70, startH + (y - startY));
      node.style.width = newW + "px";
      node.style.height = newH + "px";
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      if (!sub.sizes) sub.sizes = {};
      sub.sizes[widgetId] = { w: node.offsetWidth, h: node.offsetHeight };
      saveConfig();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    }

    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("touchstart", onDown, { passive: false });
  }

  /* ---------------------------------------------------------------
     RENDER — content area for the active sub-tab
     Real widgets are MOVED here (appendChild relocates, doesn't
     clone) so instruments.js/game-ui.js's element references stay
     valid. Placeholder widgets are cloned since they're inert.
     --------------------------------------------------------------- */
  function renderContent() {
    const content = document.getElementById("osSubTabContent");
    const templates = document.getElementById("osWidgetTemplates");
    if (!content || !templates) return;

    /* CRITICAL: real widget nodes (helmgauges, chartplotter, etc) are
       MOVED into this container, not cloned. Calling content.innerHTML
       = "" would PERMANENTLY DELETE them once they're no longer inside
       #osWidgetTemplates — there'd be nothing left to move back next
       time. So real nodes must be returned to the templates container
       first; only placeholder clones (which can be freely recreated)
       and other stray DOM are actually cleared. */
    Array.from(content.children).forEach(child => {
      const widgetId = child.dataset && child.dataset.widgetId;
      if (widgetId && REAL_WIDGET_IDS.includes(widgetId)) {
        templates.appendChild(child); /* detach safely, don't destroy */
      }
    });
    content.innerHTML = "";

    const sub = getSub(activeMainId, activeSubId);
    if (!sub) return;

    if (sub.widgets.length === 0) {
      const empty = document.createElement("div");
      empty.className = "osTabEmptyState";
      empty.innerHTML = `
        <div class="osTabEmptyIcon">➕</div>
        <div class="osTabEmptyText">Long-press here to add a widget</div>
      `;
      content.appendChild(empty);
    }

    sub.widgets.forEach((widgetId, index) => {
      const node = getWidgetNode(widgetId);
      if (node) {
        content.appendChild(node);
        if (node.classList.contains("osWidgetResizable")) {
          applyStoredLayout(node, sub, widgetId, index);
          attachGripHandle(node, sub, widgetId);
          attachResizeHandle(node, sub, widgetId);
        }
      }
      if (widgetId === "chartplotter" && typeof window.OSGameUI !== "undefined") {
        window.OSGameUI.onChartPlotterShown();
      }
    });

    attachLongPress(content, sub);
  }

  /* Returns the DOM node for a widget id — the REAL node (moved, not
     cloned) for real widgets so element-id references elsewhere in
     the app stay valid, or a fresh clone for inert placeholders. */
  const REAL_WIDGET_IDS = [
    "sailtrim", "wheel", "engine", "speed", "windex",
    "chartplotter", "water", "food", "hull", "track", "station",
    "compass", "forecast", "tidechart", "lightpanel", "batterypanel"
  ];

  function getWidgetNode(widgetId) {
    const template = document.querySelector(`#osWidgetTemplates [data-widget-id="${widgetId}"]`);
    if (!template) return null;
    if (REAL_WIDGET_IDS.includes(widgetId)) {
      return template; /* move the actual node */
    }
    return template.cloneNode(true); /* placeholders: safe to duplicate */
  }

  /* ---------------------------------------------------------------
     LONG-PRESS — add/remove widgets for the current sub-tab
     --------------------------------------------------------------- */
  function attachLongPress(contentEl, sub) {
    let pressTimer = null;
    const LONG_PRESS_MS = 550;

    function start(e) {
      /* Don't trigger if the press started on a real interactive
         widget (gauge controls, map, etc) — only the empty/background
         area of the content should open the editor, so people can
         still actually use the widgets without it interrupting them */
      if (e.target.closest(".osWidgetCard")) return;
      pressTimer = setTimeout(() => showWidgetEditor(sub), LONG_PRESS_MS);
    }
    function cancel() {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }

    contentEl.addEventListener("touchstart", start, { passive: true });
    contentEl.addEventListener("touchend", cancel);
    contentEl.addEventListener("touchmove", cancel);
    contentEl.addEventListener("mousedown", start);
    contentEl.addEventListener("mouseup", cancel);
    contentEl.addEventListener("mouseleave", cancel);
    /* Right-click as a desktop-testing equivalent of long-press */
    contentEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showWidgetEditor(sub);
    });
  }

  function showWidgetEditor(sub) {
    const overlay = document.getElementById("osWidgetEditorOverlay");
    if (!overlay) return;

    const catalog = WIDGET_CATALOG[activeMainId] || [];
    const placedHtml = sub.widgets.map(wId => {
      const meta = catalog.find(w => w.id === wId);
      return `
        <div class="osWidgetEditorRow">
          <span>${meta ? meta.label : wId}</span>
          <button class="osDevBtnSmall osDevBtnDanger" data-remove="${wId}">Remove</button>
        </div>
      `;
    }).join("") || `<p class="osWidgetEditorEmpty">No widgets on this tab yet.</p>`;

    const availableToAdd = catalog.filter(w => !sub.widgets.includes(w.id));
    const addHtml = availableToAdd.map(w =>
      `<button class="osDevBtnSmall" data-add="${w.id}">+ ${w.label}</button>`
    ).join("") || `<p class="osWidgetEditorEmpty">${catalog.length === 0 ? "No widgets available for this section yet." : "All available widgets are already placed."}</p>`;

    overlay.innerHTML = `
      <div class="osWidgetEditorPanel">
        <div class="osWidgetEditorHeader">
          <span>Edit "${sub.label}"</span>
          <button class="osDevCloseBtn" id="osWidgetEditorClose">✕</button>
        </div>
        <div class="osWidgetEditorSection">
          <div class="osWidgetEditorSubhead">On this tab</div>
          ${placedHtml}
        </div>
        <div class="osWidgetEditorSection">
          <div class="osWidgetEditorSubhead">Add a widget</div>
          <div class="osWidgetEditorAddGrid">${addHtml}</div>
        </div>
      </div>
    `;
    overlay.style.display = "flex";

    overlay.querySelectorAll("[data-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        sub.widgets = sub.widgets.filter(w => w !== btn.dataset.remove);
        saveConfig();
        renderContent();
        showWidgetEditor(sub); /* refresh the editor in place */
      });
    });
    overlay.querySelectorAll("[data-add]").forEach(btn => {
      btn.addEventListener("click", () => {
        sub.widgets.push(btn.dataset.add);
        saveConfig();
        renderContent();
        showWidgetEditor(sub);
      });
    });
    document.getElementById("osWidgetEditorClose").addEventListener("click", () => {
      overlay.style.display = "none";
    });
  }

  /* ---------------------------------------------------------------
     INIT
     --------------------------------------------------------------- */
  function init() {
    renderMainTabs();
    renderSubTabs();
  }

  document.addEventListener("DOMContentLoaded", init);
  /* Also try immediately in case this script loads after DOMContentLoaded already fired */
  if (document.readyState !== "loading") init();

  window.OSTabSystem = {
    refresh: () => { renderMainTabs(); renderSubTabs(); }
  };
})();
