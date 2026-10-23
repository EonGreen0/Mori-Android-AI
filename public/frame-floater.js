import { initFavoritesPanel } from "./favorites-panel.js";

const button = document.getElementById("capture");
const invoke =
  window.__TAURI__?.core?.invoke ||
  window.__TAURI_INTERNALS__?.invoke ||
  window.__TAURI__?.invoke;

const dragHandle = document.querySelector(".drag");
const favorites = initFavoritesPanel(invoke);
let activeDrag = null;
let lastDragMovement = null;

async function toggleFavorites() {
  // Finish the last drag before resizing: a delayed final move otherwise uses
  // the compact window's origin to reposition an already expanded panel.
  await lastDragMovement?.ready;
  await lastDragMovement?.movingPromise;
  favorites.toggle();
}

async function moveFloater(drag) {
  if (!drag.origin || drag.moving || drag.cancelled) return;
  drag.moving = true;
  try {
    // Keep the most recent pointer position while a native move is pending.
    // The final pointerup position is retained even after capture is released.
    while (drag.pending && !drag.cancelled) {
      const delta = drag.pending;
      drag.pending = null;
      await invoke("tauri_move_frame_floater", {
        position: {
          x: Math.round(drag.origin.x + delta.x * drag.origin.scaleFactor),
          y: Math.round(drag.origin.y + delta.y * drag.origin.scaleFactor),
        },
      });
    }
  } catch (error) {
    console.warn("Mori floater drag failed:", error);
  } finally {
    drag.moving = false;
  }
}

function updateDrag(event) {
  const drag = activeDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const delta = { x: event.screenX - drag.x, y: event.screenY - drag.y };
  if (Math.hypot(delta.x, delta.y) >= 4) drag.hasMoved = true;
  if (!drag.hasMoved) return;
  drag.pending = delta;
  if (!drag.moving) drag.movingPromise = moveFloater(drag);
}

dragHandle?.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !invoke || activeDrag) return;
  event.preventDefault();
  dragHandle.setPointerCapture(event.pointerId);
  const drag = { pointerId: event.pointerId, x: event.screenX, y: event.screenY };
  activeDrag = drag;
  drag.ready = invoke("tauri_move_frame_floater", { position: null })
    .then((origin) => {
      if (drag.cancelled) return;
      drag.origin = origin;
      if (!drag.moving) drag.movingPromise = moveFloater(drag);
      return drag.movingPromise;
    })
    .catch((error) => console.warn("Mori floater drag failed:", error));
});
dragHandle?.addEventListener("pointermove", updateDrag);
dragHandle?.addEventListener("pointerup", (event) => {
  if (event.pointerId !== activeDrag?.pointerId) return;
  const drag = activeDrag;
  updateDrag(event);
  activeDrag = null;
  dragHandle.releasePointerCapture(event.pointerId);
  if (drag.hasMoved) lastDragMovement = drag;
  else { drag.cancelled = true; toggleFavorites(); }
});
dragHandle?.addEventListener("click", (event) => { if (event.detail === 0) toggleFavorites(); });
function cancelDrag(event) {
  if (event.pointerId !== activeDrag?.pointerId) return;
  if (activeDrag.hasMoved) lastDragMovement = activeDrag;
  activeDrag.cancelled = true;
  activeDrag.pending = null;
  activeDrag = null;
}
dragHandle?.addEventListener("pointercancel", cancelDrag);
dragHandle?.addEventListener("lostpointercapture", cancelDrag);

button?.addEventListener("click", async () => {
  if (!invoke || button.disabled) return;
  button.disabled = true;
  try {
    await invoke("tauri_request_global_frame_capture");
  } catch (error) {
    console.warn("Mori global frame request failed:", error);
  } finally {
    setTimeout(() => {
      button.disabled = false;
    }, 900);
  }
});
