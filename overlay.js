import OBR from "./owlbear-sdk.js";

const overlay = document.getElementById("overlay");
const debug = document.getElementById("debug");
let points = new Map();

OBR.onReady(() => {
  debug.textContent = "SDK bereit. Transparenz-Test aktiv.";
});

function render(id, x, y) {
  let el = points.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = "marker";
    overlay.appendChild(el);
    points.set(id, el);
  }
  el.style.left = x + "px";
  el.style.top = y + "px";
  el.textContent = id;
  debug.textContent = `Aktive Punkte: ${points.size} | letzte ID: ${id} @ (${Math.round(x)},${Math.round(y)})`;
}

function remove(id) {
  const el = points.get(id);
  if (el) { el.remove(); points.delete(id); }
  debug.textContent = `Aktive Punkte: ${points.size}`;
}

overlay.addEventListener("pointerdown", (e) => render(e.pointerId, e.clientX, e.clientY));
overlay.addEventListener("pointermove", (e) => { if (points.has(e.pointerId)) render(e.pointerId, e.clientX, e.clientY); });
overlay.addEventListener("pointerup", (e) => remove(e.pointerId));
overlay.addEventListener("pointercancel", (e) => remove(e.pointerId));
overlay.addEventListener("contextmenu", (e) => e.preventDefault());
