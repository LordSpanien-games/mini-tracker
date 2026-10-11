import OBR, { isImage } from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

const overlay = document.getElementById("overlay");
const pauseBtn = document.getElementById("pauseBtn");

let sceneTokens = [];
let pending = new Map();
let links = new Map();
let releasing = new Map();
let frozenLinks = new Map();

const RELEASE_GRACE_MS = 400;
const RELEASE_GRACE_RADIUS_PX = 80;
const RELINK_WINDOW_MS = 5000;
const RELINK_RADIUS_PX = 250;
const STOP_INTERACTION_AFTER_MS = 2500;
const HOVER_LINK_MS = 3000;
const HOVER_RADIUS_PX = 45;
const HOVER_CHECK_INTERVAL_MS = 200;

const META_KEY_CONTACTS = "com.minitracker/contacts";
const META_KEY_LINKS = "com.minitracker/links";
const POPOVER_ID = "com.minitracker.overlay";

function genId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + "-" + Date.now();
}

function ts() {
  return new Date().toISOString().split("T")[1].slice(0, 12);
}

pauseBtn.addEventListener("pointerdown", async (e) => {
  e.stopPropagation();
  console.log(`[${ts()}] [Tisch] Pause gedrückt - schließe Overlay.`);
  await OBR.popover.close(POPOVER_ID);
});

OBR.onReady(async () => {
  console.log(`[${ts()}] [Tisch] SDK bereit.`);
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
  for (const [, p] of pending) contacts[p.contactId] = { x: p.x, y: p.y };
  await OBR.room.setMetadata({ [META_KEY_CONTACTS]: contacts });
}

async function cleanupMetadataAfterAssign(contactId) {
  try {
    const meta = await OBR.room.getMetadata();
    const links = { ...(meta[META_KEY_LINKS] || {}) };
    const contacts = { ...(meta[META_KEY_CONTACTS] || {}) };
    delete links[contactId];
    delete contacts[contactId];
    await OBR.room.setMetadata({ [META_KEY_LINKS]: links, [META_KEY_CONTACTS]: contacts });
  } catch (err) {
    console.error("[Tisch] Fehler beim Metadata-Cleanup:", err);
  }
}

function applyLinksFromMetadata(linksFromHost) {
  for (const [contactId, tokenId] of Object.entries(linksFromHost)) {
    let foundPointerId = null;
    for (const [pid, p] of pending) {
      if (p.contactId === contactId) { foundPointerId = pid; break; }
    }
    if (foundPointerId === null) continue;
    if (links.has(foundPointerId)) continue;

    const p = pending.get(foundPointerId);
    clearPendingHover(p);
    p.el.remove();
    p.labelEl.remove();
    pending.delete(foundPointerId);
    doAssign(foundPointerId, tokenId, p.x, p.y);
    cleanupMetadataAfterAssign(contactId);
    console.log(`[${ts()}] [Tisch] Host-Zuordnung: ${contactId.slice(0,8)} -> ${tokenId}`);
  }
}

async function autoAssignFromHover(pointerId, tokenId) {
  const p = pending.get(pointerId);
  if (!p) return;
  if (links.has(pointerId)) return;
  clearPendingHover(p);
  p.el.remove();
  p.labelEl.remove();
  pending.delete(pointerId);
  doAssign(pointerId, tokenId, p.x, p.y);
  await cleanupMetadataAfterAssign(p.contactId);
  console.log(`[${ts()}] [Tisch] Auto-Zuordnung (Hover): ${pointerId} -> ${tokenId}`);
}

function doAssign(pointerId, tokenId, x, y) {
  if (links.has(pointerId)) {
    console.warn(`[${ts()}] [Tisch] doAssign ignoriert - pointerId ${pointerId} bereits verknüpft.`);
    return;
  }
  if (getLinkedTokenIds().has(tokenId)) {
    console.warn(`[${ts()}] [Tisch] doAssign ignoriert - Token ${tokenId} ist bereits anderweitig verknüpft.`);
    return;
  }

  const token = sceneTokens.find((t) => t.id === tokenId);
  const el = document.createElement("div");
  el.className = "marker linked";
  overlay.appendChild(el);

  const labelEl = document.createElement("div");
  labelEl.className = "idLabel hidden";
  overlay.appendChild(labelEl);

  positionMarkerAndLabel(el, labelEl, x, y);
  links.set(pointerId, {
    tokenId, el, labelEl,
    interaction: null,
    moveTimeout: null,
    lastScenePos: token?.position || null,
    starting: false,
  });

  showLockFlash(x, y);
  commitPositionImmediate(tokenId, x, y);
  console.log(`[${ts()}] [Tisch] LOCKED: pointerId=${pointerId} -> token=${tokenId}`);
}

function tryResumeReleasing(pointerId, x, y) {
  let bestTokenId = null, bestDist = Infinity;
  for (const [tokenId, r] of releasing) {
    const dist = Math.hypot(r.x - x, r.y - y);
    if (dist <= RELEASE_GRACE_RADIUS_PX && dist < bestDist) { bestDist = dist; bestTokenId = tokenId; }
  }
  if (bestTokenId) {
    const r = releasing.get(bestTokenId);
    clearTimeout(r.timeoutHandle);
    releasing.delete(bestTokenId);

    const token = sceneTokens.find((t) => t.id === bestTokenId);
    const el = document.createElement("div");
    el.className = "marker linked";
    overlay.appendChild(el);
    const labelEl = document.createElement("div");
    labelEl.className = "idLabel hidden";
    overlay.appendChild(labelEl);
    positionMarkerAndLabel(el, labelEl, x, y);

    links.set(pointerId, {
      tokenId: bestTokenId, el, labelEl,
      interaction: null, moveTimeout: null,
      lastScenePos: token?.position || null,
      starting: false,
    });
    console.log(`[${ts()}] [Tisch] Flacker-Toleranz: nahtlose Fortsetzung für Token ${bestTokenId} (Distanz ${Math.round(bestDist)}px)`);
    return true;
  }
  return false;
}

function showLockFlash(x, y) {
  const flash = document.createElement("div");
  flash.className = "lockFlash";
  flash.style.left = x + "px";
  flash.style.top = y + "px";
  overlay.appendChild(flash);
  setTimeout(() => flash.remove(), 650);
}

async function commitPositionImmediate(tokenId, x, y) {
  try {
    const scenePos = await OBR.viewport.inverseTransformPoint({ x, y });
    await OBR.scene.items.updateItems([tokenId], (items) => {
      for (const item of items) item.position = scenePos;
    });
    const link = [...links.values()].find((l) => l.tokenId === tokenId);
    if (link) link.lastScenePos = scenePos;
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

function createPendingMarker(contactId, x, y) {
  const el = document.createElement("div");
  el.className = "marker pending";
  el.textContent = "?";
  overlay.appendChild(el);

  const labelEl = document.createElement("div");
  labelEl.className = "idLabel";
  labelEl.textContent = `#${contactId.slice(0, 4)}`;
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
    console.log(`[${ts()}] [Tisch] Re-Link (nach echtem Hochnehmen) erfolgreich: ${pointerId} -> ${bestTokenId}`);
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
    if (link.starting) return;
    link.starting = true;
    try {
      const freshItems = await OBR.scene.items.getItems([link.tokenId]);
      const token = freshItems[0];
      if (!token) { link.starting = false; return; }
      if (!links.has(pointerId)) { link.starting = false; return; }
      link.interaction = await OBR.interaction.startItemInteraction(token);
      link.starting = false;
    } catch (err) {
      console.error("[Tisch] Fehler beim Starten der Interaction:", err);
      link.starting = false;
      return;
    }
  }

  if (!link.interaction) return;

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
  const tokenId = link.tokenId;

  links.delete(pointerId);

  console.log(`[${ts()}] [Tisch] pointerUp für ${pointerId}, Token ${tokenId} -> Flacker-Toleranzfenster (${RELEASE_GRACE_MS}ms) gestartet.`);

  const timeoutHandle = setTimeout(() => {
    releasing.delete(tokenId);
    link.el.classList.remove("linked");
    link.el.classList.add("frozen");
    link.labelEl.classList.remove("hidden");
    link.labelEl.textContent = "wartet...";

    const frozenTimeout = setTimeout(() => {
      link.el.remove();
      link.labelEl.remove();
      frozenLinks.delete(tokenId);
      console.log(`[${ts()}] [Tisch] Re-Link-Fenster abgelaufen für Token ${tokenId}.`);
    }, RELINK_WINDOW_MS);

    frozenLinks.set(tokenId, { x, y, el: link.el, labelEl: link.labelEl, timeoutHandle: frozenTimeout });
    console.log(`[${ts()}] [Tisch] Kein Flacker - echtes Hochnehmen angenommen. Token ${tokenId} jetzt sichtbar eingefroren.`);
  }, RELEASE_GRACE_MS);

  releasing.set(tokenId, { x, y, timeoutHandle });

  link.el.remove();
  link.labelEl.remove();
}

overlay.addEventListener("pointerdown", (e) => {
  if (e.target !== overlay) return;
  const { pointerId, clientX: x, clientY: y } = e;

  console.log(`[${ts()}] [Tisch] pointerdown: id=${pointerId}, type=${e.pointerType}, bereits verlinkt=${links.has(pointerId)}`);

  if (links.has(pointerId)) return;

  if (tryResumeReleasing(pointerId, x, y)) return;
  if (tryRelink(pointerId, x, y)) return;

  const contactId = genId();
  const { el, labelEl } = createPendingMarker(contactId, x, y);
  const entry = { contactId, x, y, el, labelEl, hoverTokenId: null, hoverStart: null, hoverInterval: null };
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
  console.log(`[${ts()}] [Tisch] pointerup: id=${pointerId}`);
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

overlay.addEventListener("pointercancel", (e) => {
  console.log(`[${ts()}] [Tisch] pointercancel: id=${e.pointerId}`);
  overlay.dispatchEvent(new PointerEvent("pointerup", e));
});
overlay.addEventListener("contextmenu", (e) => e.preventDefault());
