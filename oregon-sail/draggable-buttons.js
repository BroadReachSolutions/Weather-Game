/* ============================================================
   Draggable Center Buttons
   Makes the "center on vessel" buttons (game map + radar widget)
   freely repositionable while Edit Layout mode is on. Position is
   saved per-button to localStorage and restored on load.

   Reuses the same `body.layout-edit` class the dashboard's widget
   editor already toggles, so dragging only activates during the
   same edit session as widget resize/drag.
   ============================================================ */

(function () {
  const STORAGE_PREFIX = "osButtonPos_";

  function makeButtonDraggable(buttonId) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;

    const container = btn.parentElement; /* positioned ancestor (relative/absolute) */
    if (!container) return;

    /* Restore saved position, if any */
    restorePosition(btn, buttonId);

    let dragState = null;

    function getClientXY(e) {
      if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.changedTouches && e.changedTouches.length) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
      return { x: e.clientX, y: e.clientY };
    }

    function onPointerDown(e) {
      if (!document.body.classList.contains("layout-edit")) return; /* only draggable in edit mode */
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = getClientXY(e);
      const rect = container.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      dragState = {
        startX: x,
        startY: y,
        startLeft: btnRect.left - rect.left,
        startTop: btnRect.top - rect.top,
        containerW: rect.width,
        containerH: rect.height
      };
      window.addEventListener("mousemove", onPointerMove);
      window.addEventListener("mouseup", onPointerUp);
      window.addEventListener("touchmove", onPointerMove, { passive: false });
      window.addEventListener("touchend", onPointerUp);
    }

    function onPointerMove(e) {
      if (!dragState) return;
      e.preventDefault();
      const { x, y } = getClientXY(e);
      const dx = x - dragState.startX;
      const dy = y - dragState.startY;

      let newLeft = dragState.startLeft + dx;
      let newTop = dragState.startTop + dy;

      /* Clamp within the container so the button can't drag off-frame */
      const btnW = btn.offsetWidth;
      const btnH = btn.offsetHeight;
      newLeft = Math.max(2, Math.min(dragState.containerW - btnW - 2, newLeft));
      newTop = Math.max(2, Math.min(dragState.containerH - btnH - 2, newTop));

      btn.style.left = newLeft + "px";
      btn.style.top = newTop + "px";
      btn.style.right = "auto";
      btn.style.bottom = "auto";
    }

    function onPointerUp() {
      if (!dragState) return;
      dragState = null;
      savePosition(btn, buttonId);
      window.removeEventListener("mousemove", onPointerMove);
      window.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("touchmove", onPointerMove);
      window.removeEventListener("touchend", onPointerUp);
    }

    btn.addEventListener("mousedown", onPointerDown);
    btn.addEventListener("touchstart", onPointerDown, { passive: false });
  }

  function savePosition(btn, buttonId) {
    const pos = { left: btn.style.left, top: btn.style.top };
    localStorage.setItem(STORAGE_PREFIX + buttonId, JSON.stringify(pos));
  }

  function restorePosition(btn, buttonId) {
    const raw = localStorage.getItem(STORAGE_PREFIX + buttonId);
    if (!raw) return;
    try {
      const pos = JSON.parse(raw);
      if (pos.left) btn.style.left = pos.left;
      if (pos.top) btn.style.top = pos.top;
      if (pos.left || pos.top) {
        btn.style.right = "auto";
        btn.style.bottom = "auto";
      }
    } catch (e) {}
  }

  function initDraggableButtons(attempts) {
    const gameBtn = document.getElementById("osCenterBtn");
    const radarBtn = document.getElementById("osRadarCenterBtn");

    if (gameBtn && radarBtn) {
      makeButtonDraggable("osCenterBtn");
      makeButtonDraggable("osRadarCenterBtn");
      return;
    }
    if (attempts > 0) {
      setTimeout(() => initDraggableButtons(attempts - 1), 300);
    }
  }

  document.addEventListener("DOMContentLoaded", () => initDraggableButtons(20));
})();
