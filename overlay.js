import OBR, { isImage } from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

const overlay = document.getElementById("overlay");
const pauseBtn = document.getElementById("pauseBtn");

let sceneTokens = [];
let pending = new Map();     // pointerId -> {x, y, el, labelEl, hoverTokenId, hoverStart, hoverInterval}
let links = new Map();       // pointerId -> {tokenId, el, labelEl, interaction, moveTimeout, lastScenePos}
let frozenLinks = new Map(); // tokenId -> {x, y, el, labelEl, timeoutHandle}

const RELINK_WINDOW_MS = 5000;
const RELINK_RADIUS_PX = 250;
const STOP_INTERACTION_AFTER_MS = 1200;
const HOVER_LINK_MS = 3000;
const HOVER_RADIUS_PX = 45;
const HOVER_CHECK_INTERVAL_MS = 200;

const META_KEY_CONTACTS = "com.minitracker/contacts";
const META_KEY_LINKS = "com.minitracker/links";
const POPOVER_ID = "com.minitracker.overlay";

pauseBtn.addEventListener("pointerdown", async (e) => {
  e.stopPropagation();
  console.log("[Tisch] Pause gedrückt - schließe Overlay.");
  await OBR.popover.close(POPOVER_ID);
});

OBR.onReady(async () => {
  console.log("[Tisch] SDK bereit.");
  const ready = await OBR.scene.isReady();
  if (ready) await loadTokens();
  OBR.scene.onReadyChange(async (isReady) => { if (isReady) await loadTokens(); });
  OBR.scene.items.onChange(async () => { await loadTokens(); });

  const meta = await OBR.room.getMetadata();
  applyLinksFromMetadata(meta[META_KEY_LINKS] || {});
  OBR.room.onMetadataChange((metadata) => {
    applyLinksFromMetadata(metadata[META_KEY_LINKS] || {});
  });
});

async function loadTokens() {
  sceneTokens = await OBR.scene.items.getItems(
    (item) => item.layer === "CHARACTER" && isImage(item)
  );
}

function getLinkedTokenIds() {
  return new Set([...links.values()].map((l) => l.tokenId));
}

async function publishContacts() {
  const contacts = {};
  for (const [pointerId, p] of pending) contacts[pointerId] = { x: p.x, y: p.y };
  await OBR.room.setMetadata({ [META_KEY_CONTACTS]: contacts });
}

function applyLinksFromMetadata(linksFromHost) {
  for (const [pointerIdStr, tokenId] of Object.entries(linksFromHost)) {
    const pointerId = Number(pointerIdStr);
    if (links.has(pointerId)) continue;
    const p = pending.get(pointerId);
    if (!p) continue;
    clearPendingHover(p);
    p.el.remove();
    p.labelEl.remove();
    pending.delete(pointerId);
    doAssign(pointerId, tokenId, p.x, p.y);
    publishContacts();
    console.log(`[Tisch] Host-Zuordnung: ${pointerId} -> ${tokenId}`);
  }
}

async function autoAssignFromHover(pointerId, tokenId) {
  const p = pending.get(pointerId);
  if (!p) return;
  clearPendingHover(p);
  p.el.remove();
  p.labelEl.remove();
  pending.delete(pointerId);
  doAssign(pointerId, tokenId, p.x, p.y);

  const meta = await OBR.room.getMetadata();
  const newLinks = { ...(meta[META_KEY_LINKS] || {}), [pointerId]: tokenId };
  const newContacts = { ...(meta[META_KEY_CONTACTS] || {}) };
  delete newContacts[pointerId];
  await OBR.room.setMetadata({ [META_KEY_LINKS]: newLinks, [META_KEY_CONTACTS]: newContacts });
  console.log(`[Tisch] Auto-Zuordnung (Hover): ${pointerId} -> ${tokenId}`);
}

function doAssign(pointerId, tokenId, x, y) {
  const token = sceneTokens.find((t) => t.id === tokenId);
  const el = document.createElement("div");
  el.className = "marker linked";
  overlay.appendChild(el);

  const labelEl = document.createElement("div");
  labelEl.className = "idLabel hidden";
  overlay.appendChild(labelEl);

  positionMarkerAndLabel(el, labelEl, x, y);
  links.set(pointerId, { tokenId, el, labelEl, interaction: null, moveTimeout: null, lastScenePos: token?.position || null });

  commitPositionImmediate(tokenId, x, y);
}

async function commitPositionImmediate(tokenId, x, y) {
  try {
    const scenePos = await OBR.viewport.inverseTransformPoint({ x, y });
    await OBR.scene.items.updateItems([tokenId], (items) => {
      for (const item of items) item.position = scenePos;
    });
    const link = [...links.values()].find((l) => l.tokenId === tokenId);
    if (link) link.lastScenePos = scenePos;
    console.log(`[Tisch] Sofort-Teleport für ${tokenId}:`, scenePos);
  } catch (err) {
    console.error("[Tisch] Fehler beim Sofort-Teleport:", err);
  }
}

function positionMarkerAndLabel(el, labelEl, x, y) {
  el.style.left = x + "px";
  el.style.top = y + "px";
  labelEl.style.left = x + "px";
  labelEl.style.top = (y + 28) + "px";
}

function createPendingMarker(pointerId, x, y) {
  const el = document.createElement("div");
  el.className = "marker pending";
  el.textContent = "?";
  overlay.appendChild(el);

  const labelEl = document.createElement("div");
  labelEl.className = "idLabel";
  labelEl.textContent = `#${pointerId}`;
  overlay.appendChild(labelEl);

  positionMarkerAndLabel(el, labelEl, x, y);
  return { el, labelEl };
}

function startHoverCheck(pointerId) {
  const p = pending.get(pointerId);
  if (!p) return;
  p.hoverTokenId = null;
  p.hoverStart = null;
  p.hoverInterval = setInterval(async () => {
    const current = pending.get(pointerId);
    if (!current) return;
    const linkedIds = getLinkedTokenIds();
    const candidates = sceneTokens.filter((t) => !linkedIds.has(t.id));

    let closestId = null, closestDist = Infinity;
    for (const token of candidates) {
      try {
        const screenPos = await OBR.viewport.transformPoint(token.position);
        const dist = Math.hypot(screenPos.x - current.x, screenPos.y - current.y);
        if (dist <= HOVER_RADIUS_PX && dist < closestDist) { closestDist = dist; closestId = token.id; }
      } catch (err) {}
    }

    if (closestId) {
      if (current.hoverTokenId === closestId) {
        const elapsed = Date.now() - current.hoverStart;
        current.el.classList.add("hovering");
        if (elapsed >= HOVER_LINK_MS) {
          clearInterval(current.hoverInterval);
          autoAssignFromHover(pointerId, closestId);
        }
      } else {
        current.hoverTokenId = closestId;
        current.hoverStart = Date.now();
        current.el.classList.add("hovering");
      }
    } else {
      current.hoverTokenId = null;
      current.hoverStart = null;
      current.el.classList.remove("hovering");
    }
  }, HOVER_CHECK_INTERVAL_MS);
}

function clearPendingHover(p) {
  if (p.hoverInterval) clearInterval(p.hoverInterval);
}

function tryRelink(pointerId, x, y) {
  let bestTokenId = null, bestDist = Infinity;
  for (const [tokenId, f] of frozenLinks) {
    const dist = Math.hypot(f.x - x, f.y - y);
    if (dist <= RELINK_RADIUS_PX && dist < bestDist) { bestDist = dist; bestTokenId = tokenId; }
  }
  if (bestTokenId) {
    const f = frozenLinks.get(bestTokenId);
    clearTimeout(f.timeoutHandle);
    f.el.remove();
    f.labelEl.remove();
    frozenLinks.delete(bestTokenId);
    doAssign(pointerId, bestTokenId, x, y);
    console.log(`[Tisch] Re-Link erfolgreich: ${pointerId} -> ${bestTokenId}`);
    return true;
  }
  return false;
}

async function moveLinkedToken(pointerId, x, y) {
  const link = links.get(pointerId);
  if (!link) return;
  positionMarkerAndLabel(link.el, link.labelEl, x, y);

  const scenePos = await OBR.viewport.inverseTransformPoint({ x, y });
  link.lastScenePos = scenePos;

  if (!link.interaction) {
    // WICHTIG: frisches Token-Objekt direkt von der Szene holen, nicht aus dem
    // evtl. veralteten sceneTokens-Cache, damit die Interaction mit dem korrekten,
    // aktuellen Ausgangszustand (Position) startet und nicht von einer alten
    // Position aus "hinwandert".
    const freshItems = await OBR.scene.items.getItems([link.tokenId]);
    const token = freshItems[0];
    if (!token) return;
    link.interaction = await OBR.interaction.startItemInteraction(token);
  }
  const [update] = link.interaction;
  update((draft) => { draft.position = scenePos; });

  clearTimeout(link.moveTimeout);
  link.moveTimeout = setTimeout(() => stopInteraction(pointerId), STOP_INTERACTION_AFTER_MS);
}

async function stopInteraction(pointerId) {
  const link = links.get(pointerId);
  if (!link || !link.interaction) return;
  const [, stop] = link.interaction;
  stop();
  link.interaction = null;

  if (link.lastScenePos) {
    try {
      await OBR.scene.items.updateItems([link.tokenId], (items) => {
        for (const item of items) item.position = link.lastScenePos;
      });
    } catch (err) {
      console.error("[Tisch] Fehler beim Committen der Position:", err);
    }
  }
}

async function handleLinkedUp(pointerId) {
  const link = links.get(pointerId);
  if (!link) return;
  await stopInteraction(pointerId);
  const rect = link.el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  link.el.classList.remove("linked");
  link.el.classList.add("frozen");
  link.labelEl.classList.remove("hidden");
  link.labelEl.textContent = "wartet...";

  const timeoutHandle = setTimeout(() => {
    link.el.remove();
    link.labelEl.remove();
    frozenLinks.delete(link.tokenId);
  }, RELINK_WINDOW_MS);

  frozenLinks.set(link.tokenId, { x, y, el: link.el, labelEl: link.labelEl, timeoutHandle });
  links.delete(pointerId);
}

overlay.addEventListener("pointerdown", (e) => {
  if (e.target !== overlay) return;
  const { pointerId, clientX: x, clientY: y } = e;
  if (tryRelink(pointerId, x, y)) return;
  const { el, labelEl } = createPendingMarker(pointerId, x, y);
  const entry = { x, y, el, labelEl, hoverTokenId: null, hoverStart: null, hoverInterval: null };
  pending.set(pointerId, entry);
  startHoverCheck(pointerId);
  publishContacts();
});

overlay.addEventListener("pointermove", (e) => {
  const { pointerId, clientX: x, clientY: y } = e;
  const p = pending.get(pointerId);
  if (p) { p.x = x; p.y = y; positionMarkerAndLabel(p.el, p.labelEl, x, y); return; }
  if (links.has(pointerId)) moveLinkedToken(pointerId, x, y);
});

overlay.addEventListener("pointerup", (e) => {
  const { pointerId } = e;
  const p = pending.get(pointerId);
  if (p) {
    clearPendingHover(p);
    p.el.remove();
    p.labelEl.remove();
    pending.delete(pointerId);
    publishContacts();
    return;
  }
  handleLinkedUp(pointerId);
});

overlay.addEventListener("pointercancel", (e) => overlay.dispatchEvent(new PointerEvent("pointerup", e)));
overlay.addEventListener("contextmenu", (e) => e.preventDefault());
