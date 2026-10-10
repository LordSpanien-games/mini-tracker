import OBR, { isImage } from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

const overlay = document.getElementById("overlay");
const debug = document.getElementById("debug");
const tokenList = document.getElementById("tokenList");
let points = new Map();
let sceneTokens = [];

OBR.onReady(async () => {
  debug.textContent = "SDK bereit.";

  const ready = await OBR.scene.isReady();
  if (ready) {
    await loadTokens();
  }
  OBR.scene.onReadyChange(async (isReady) => {
    if (isReady) await loadTokens();
  });

  // Reagiere auf Änderungen in der Szene (Token hinzugefügt/entfernt/umbenannt)
  OBR.scene.items.onChange(async () => {
    await loadTokens();
  });
});

async function loadTokens() {
  try {
    const items = await OBR.scene.items.getItems(
      (item) => item.layer === "CHARACTER" && isImage(item)
    );
    sceneTokens = items;
    renderTokenList();
  } catch (err) {
    tokenList.textContent = "Fehler: " + err.message;
  }
}

function renderTokenList() {
  if (sceneTokens.length === 0) {
    tokenList.textContent = "Keine Tokens gefunden.";
    return;
  }
  tokenList.innerHTML = sceneTokens
    .map((t) => `<div class="tok">${t.name || "(ohne Namen)"} <span style="color:#888">[${t.id.slice(0,6)}]</span></div>`)
    .join("");
}

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
