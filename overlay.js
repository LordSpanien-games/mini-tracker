import OBR, { isImage } from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

const overlay = document.getElementById("overlay");
const pauseBtn = document.getElementById("pauseBtn");

let sceneTokens = [];
let pending = new Map();     // pointerId -> {contactId, x, y, el, labelEl, hoverTokenId, hoverStart, hoverInterval}
let links = new Map();       // pointerId -> {contactId, tokenId, el, labelEl, interaction, moveTimeout, lastScenePos}
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

function genId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + "-" + Date.now();
}

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
  for (const [, p] of pending) contacts[p.contactId] = { x: p.x, y: p.y };
  await OBR.room.setMetadata({ [META_KEY_CONTACTS]: contacts });
}

// Entfernt verbrauchte Einträge aus der Metadata, damit sie nie erneut
// (fälschlich) angewendet werden können - das war die Hauptursache des Bugs.
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

// ---------- Zuordnung über Host-Dashboard ----------
function applyLinksFromMetadata(linksFromHost) {
  for (const [contactId, tokenId] of Object.entries(linksFromHost)) {
    // Suche den passenden offenen Kontakt anhand der eigenen contactId (nicht pointerId!)
    let foundPointerId = null;
    for (const [pid, p] of pending) {
      if (p.contactId === contactId) { foundPointerId = pid; break; }
    }
    if (foundPointerId === null) continue; // kein passender offener Kontakt (z.B. schon verarbeitet/veraltet)
    if (links.has(foundPointerId)) continue; // dieser Touch ist bereits aktiv verknüpft - nicht überschreiben!

    const p = pending.get(foundPointerId);
    clearPendingHover(p);
    p.el.remove();
    p.labelEl.remove();
    pending.delete(foundPointerId);
    doAssign(foundPointerId, tokenId, p.x, p.y);
    cleanupMetadataAfterAssign(contactId);
    console.log(`[Tisch] Host-Zuordnung: ${contactId.slice(0,8)} -> ${tokenId}`);
  }
}

// ---------- Zuordnung direkt am Tisch (Hover-Methode) ----------
async function autoAssignFromHover(pointerId, tokenId) {
  const p = pending.get(pointerId);
  if (!p) return;
  if (links.has(pointerId)) return; // Sicherheitsnetz
  clearPendingHover(p);
  p.el.remove();
  p.labelEl.remove();
  pending.delete(pointerId);
  doAssign(pointerId, tokenId, p.x, p.y);
  await cleanupMetadataAfterAssign(p.contactId);
  console.log(`[Tisch] Auto-Zuordnung (Hover): ${pointerId} -> ${tokenId}`);
}

// ---------- Kernfunktion: Zuordnung herstellen ----------
function doAssign(pointerId, tokenId, x, y) {
  // Schutz 1: dieser Touch-Kontakt ist bereits aktiv verknüpft -> nichts tun
  if (links.has(pointerId)) {
    console.warn(`[Tisch] doAssign ignoriert - pointerId ${pointerId} bereits verknüpft.`);
    return;
  }
  // Schutz 2: dieser Token ist bereits an einen ANDEREN aktiven Kontakt verknüpft -> nichts tun
  if (getLinkedTokenIds().has(tokenId)) {
    console.warn(`[Tisch] doAssign ignoriert - Token ${tokenId} ist bereits anderweitig verknüpft.`);
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
  links.set(pointerId, { tokenId, el, labelEl, interaction: null, moveTimeout: null, lastScenePos: token?.position || null });

  showLockFlash(x, y);
  commitPositionImmediate(tokenId, x, y);
}

// Kurzer visueller Bestätigungs-Blitz beim Locken (ersetzt den dauerhaften Marker)
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

// ---------- Hover-zu-Token Prüfung ----------
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

// ---------- Re-Link bei Wiederaufsetzen (rein lokal, pointerId-unabhängig) ----------
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

// ---------- Bewegung ----------
async function moveLinkedToken(pointerId, x, y) {
  const link = links.get(pointerId);
  if (!link) return;
  positionMarkerAndLabel(link.el, link.labelEl, x, y);

  const scenePos = await OBR.viewport.inverseTransformPoint({ x, y });
  link.lastScenePos = scenePos;

  if (!link.interaction) {
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

// ---------- Pointer-Events ----------
overlay.addEventListener("pointerdown", (e) => {
  if (e.target !== overlay) return;
  const { pointerId, clientX: x, clientY: y } = e;

  if (links.has(pointerId)) return; // dieser Kontakt ist bereits aktiv verknüpft, nicht neu starten
  if (tryRelink(pointerId, x, y)) return;

  const contactId = genId();
  const { el, labelEl } = createPendingMarker(contactId, x, y);
  const entry = { contactId, x, y, el, labelEl, hoverTokenId: null, hoverStart: null, hoverInterval: null };
  pending.set(pointerId, entry);
  startHoverCheck(pointerId);
  publishContacts();
  console.log(`[Tisch] Neuer Kontakt: pointerId=${pointerId}, contactId=${contactId.slice(0,8)}, type=${e.pointerType}`);
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
