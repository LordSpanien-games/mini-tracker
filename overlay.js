import OBR, { isImage } from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

const overlay = document.getElementById("overlay");
const debug = document.getElementById("debug");
const tokenList = document.getElementById("tokenList");

let sceneTokens = [];           // Liste aller Character-Tokens in der Szene
let pending = new Map();        // pointerId -> {x, y, el}  (noch nicht zugeordnete Touches)
let links = new Map();          // pointerId -> {tokenId, el, interaction, lastMoveTime, moveTimeout}
let frozenLinks = new Map();    // tokenId -> {x, y, frozenSince, el}  (Mini hochgenommen, wartet auf Re-Link)

const RELINK_WINDOW_MS = 8000;
const RELINK_RADIUS_PX = 60;
const STOP_INTERACTION_AFTER_MS = 1200; // Interaction stoppen wenn so lange keine Bewegung

OBR.onReady(async () => {
  debug.textContent = "SDK bereit.";
  const ready = await OBR.scene.isReady();
  if (ready) await loadTokens();
  OBR.scene.onReadyChange(async (isReady) => { if (isReady) await loadTokens(); });
  OBR.scene.items.onChange(async () => { await loadTokens(); });
});

async function loadTokens() {
  try {
    sceneTokens = await OBR.scene.items.getItems(
      (item) => item.layer === "CHARACTER" && isImage(item)
    );
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

// ---------- Pending (unzugeordnete) Touch-Punkte ----------
function createPendingMarker(id, x, y) {
  const el = document.createElement("div");
  el.className = "marker pending";
  el.textContent = "?";
  overlay.appendChild(el);
  positionEl(el, x, y);
  el.addEventListener("pointerdown", (ev) => {
    ev.stopPropagation();
    openAssignMenu(id, x, y);
  });
  return el;
}

function positionEl(el, x, y) {
  el.style.left = x + "px";
  el.style.top = y + "px";
}

// ---------- Zuweisungsmenü (simple Auswahl per Tap auf Panel-Eintrag) ----------
let assignTargetPointerId = null;

function openAssignMenu(pointerId, x, y) {
  assignTargetPointerId = pointerId;
  const menu = document.getElementById("assignMenu");
  menu.innerHTML = `<div style="color:#ffb020;margin-bottom:6px;">Touch #${pointerId} zuweisen:</div>` +
    sceneTokens.map((t) =>
      `<div class="assignOption" data-id="${t.id}">${t.name || "(ohne Namen)"}</div>`
    ).join("");
  menu.style.display = "block";
  menu.style.left = Math.min(x, window.innerWidth - 220) + "px";
  menu.style.top = Math.min(y, window.innerHeight - 200) + "px";

  menu.querySelectorAll(".assignOption").forEach((opt) => {
    opt.onclick = () => {
      const tokenId = opt.dataset.id;
      assignToken(pointerId, tokenId);
      menu.style.display = "none";
    };
  });
}

document.getElementById("overlay").addEventListener("pointerdown", (e) => {
  const menu = document.getElementById("assignMenu");
  if (menu.style.display === "block" && e.target.id === "overlay") {
    menu.style.display = "none";
  }
});

// ---------- Zuordnung erstellen ----------
function assignToken(pointerId, tokenId) {
  const p = pending.get(pointerId);
  if (!p) return;
  p.el.remove();
  pending.delete(pointerId);

  const token = sceneTokens.find((t) => t.id === tokenId);
  const el = document.createElement("div");
  el.className = "marker linked";
  el.textContent = (token?.name || "?").slice(0, 2).toUpperCase();
  overlay.appendChild(el);
  positionEl(el, p.x, p.y);

  links.set(pointerId, {
    tokenId,
    el,
    interaction: null,
    lastMoveTime: 0,
    moveTimeout: null,
  });
}

// ---------- Re-Link Versuch bei neuem Touch ----------
function tryRelink(pointerId, x, y) {
  let bestTokenId = null;
  let bestDist = Infinity;
  for (const [tokenId, f] of frozenLinks) {
    const dist = Math.hypot(f.x - x, f.y - y);
    if (dist <= RELINK_RADIUS_PX && dist < bestDist) {
      bestDist = dist;
      bestTokenId = tokenId;
    }
  }
  if (bestTokenId) {
    const f = frozenLinks.get(bestTokenId);
    clearTimeout(f.timeoutHandle);
    f.el.remove();
    frozenLinks.delete(bestTokenId);

    const token = sceneTokens.find((t) => t.id === bestTokenId);
    const el = document.createElement("div");
    el.className = "marker linked";
    el.textContent = (token?.name || "?").slice(0, 2).toUpperCase();
    overlay.appendChild(el);
    positionEl(el, x, y);

    links.set(pointerId, {
      tokenId: bestTokenId,
      el,
      interaction: null,
      lastMoveTime: 0,
      moveTimeout: null,
    });
    return true;
  }
  return false;
}

// ---------- Bewegung eines zugeordneten Tokens ----------
async function moveLinkedToken(pointerId, x, y) {
  const link = links.get(pointerId);
  if (!link) return;

  positionEl(link.el, x, y);

  const scenePos = await OBR.viewport.inverseTransformPoint({ x, y });

  if (!link.interaction) {
    const token = sceneTokens.find((t) => t.id === link.tokenId);
    if (!token) return;
    link.interaction = await OBR.interaction.startItemInteraction(token);
  }

  const [update] = link.interaction;
  update((draft) => {
    draft.position = scenePos;
  });

  link.lastMoveTime = Date.now();
  clearTimeout(link.moveTimeout);
  link.moveTimeout = setTimeout(() => stopInteraction(pointerId), STOP_INTERACTION_AFTER_MS);
}

function stopInteraction(pointerId) {
  const link = links.get(pointerId);
  if (!link || !link.interaction) return;
  const [, stop] = link.interaction;
  stop();
  link.interaction = null;
}

// ---------- Touch wird abgehoben ----------
function handleLinkedUp(pointerId) {
  const link = links.get(pointerId);
  if (!link) return;
  stopInteraction(pointerId);

  const rect = link.el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  link.el.classList.add("frozen");
  const timeoutHandle = setTimeout(() => {
    link.el.remove();
    frozenLinks.delete(link.tokenId);
  }, RELINK_WINDOW_MS);

  frozenLinks.set(link.tokenId, { x, y, el: link.el, timeoutHandle });
  links.delete(pointerId);
}

// ---------- Haupt Pointer-Event-Handler ----------
overlay.addEventListener("pointerdown", (e) => {
  if (e.target !== overlay) return; // Klicks auf Marker/Menü nicht hier behandeln
  const { pointerId, clientX: x, clientY: y } = e;

  if (tryRelink(pointerId, x, y)) {
    debug.textContent = `Re-Link erfolgreich: ${pointerId}`;
    return;
  }

  const el = createPendingMarker(pointerId, x, y);
  pending.set(pointerId, { x, y, el });
  debug.textContent = `Neuer Kontakt ${pointerId} - bitte zuweisen`;
});

overlay.addEventListener("pointermove", (e) => {
  const { pointerId, clientX: x, clientY: y } = e;

  const p = pending.get(pointerId);
  if (p) {
    p.x = x; p.y = y;
    positionEl(p.el, x, y);
    return;
  }

  if (links.has(pointerId)) {
    moveLinkedToken(pointerId, x, y);
  }
});

overlay.addEventListener("pointerup", (e) => {
  const { pointerId } = e;
  const p = pending.get(pointerId);
  if (p) {
    p.el.remove();
    pending.delete(pointerId);
    return;
  }
  handleLinkedUp(pointerId);
});

overlay.addEventListener("pointercancel", (e) => {
  overlay.dispatchEvent(new PointerEvent("pointerup", e));
});

overlay.addEventListener("contextmenu", (e) => e.preventDefault());
