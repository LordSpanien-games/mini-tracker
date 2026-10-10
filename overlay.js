import OBR, { isImage } from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

const overlay = document.getElementById("overlay");

let sceneTokens = [];
let pending = new Map();     // pointerId -> {x, y, el, labelEl}
let links = new Map();       // pointerId -> {tokenId, el, labelEl, interaction, moveTimeout}
let frozenLinks = new Map(); // tokenId -> {x, y, el, labelEl, timeoutHandle}

const RELINK_WINDOW_MS = 8000;
const RELINK_RADIUS_PX = 60;
const STOP_INTERACTION_AFTER_MS = 1200;
const META_KEY_CONTACTS = "com.minitracker/contacts";
const META_KEY_LINKS = "com.minitracker/links";

OBR.onReady(async () => {
  console.log("[Tisch] SDK bereit.");
  const ready = await OBR.scene.isReady();
  if (ready) await loadTokens();
  OBR.scene.onReadyChange(async (isReady) => { if (isReady) await loadTokens(); });
  OBR.scene.items.onChange(async () => { await loadTokens(); });

  const meta = await OBR.room.getMetadata();
  console.log("[Tisch] Initiale Metadata:", meta);
  applyLinksFromMetadata(meta[META_KEY_LINKS] || {});

  OBR.room.onMetadataChange((metadata) => {
    console.log("[Tisch] Metadata-Änderung empfangen:", metadata[META_KEY_LINKS]);
    applyLinksFromMetadata(metadata[META_KEY_LINKS] || {});
  });
});

async function loadTokens() {
  sceneTokens = await OBR.scene.items.getItems(
    (item) => item.layer === "CHARACTER" && isImage(item)
  );
  console.log("[Tisch] Tokens geladen:", sceneTokens.map(t => t.name));
}

async function publishContacts() {
  const contacts = {};
  for (const [pointerId, p] of pending) contacts[pointerId] = { x: p.x, y: p.y };
  await OBR.room.setMetadata({ [META_KEY_CONTACTS]: contacts });
  console.log("[Tisch] Kontakte veröffentlicht:", contacts);
}

function applyLinksFromMetadata(linksFromHost) {
  for (const [pointerIdStr, tokenId] of Object.entries(linksFromHost)) {
    const pointerId = Number(pointerIdStr);
    if (links.has(pointerId)) continue;
    const p = pending.get(pointerId);
    if (!p) {
      console.warn(`[Tisch] Link für ${pointerId} empfangen, aber kein offener Kontakt vorhanden (Mini evtl. nicht mehr auf dem Feld)`);
      continue;
    }
    p.el.remove();
    p.labelEl.remove();
    pending.delete(pointerId);
    doAssign(pointerId, tokenId, p.x, p.y);
    publishContacts();
    console.log(`[Tisch] ERFOLG: Kontakt ${pointerId} -> Token ${tokenId} verknüpft`);
  }
}

function doAssign(pointerId, tokenId, x, y) {
  const token = sceneTokens.find((t) => t.id === tokenId);
  const el = document.createElement("div");
  el.className = "marker linked";
  el.textContent = (token?.name || "?").slice(0, 2).toUpperCase();
  overlay.appendChild(el);

  const labelEl = document.createElement("div");
  labelEl.className = "idLabel";
  labelEl.textContent = `#${pointerId}`;
  overlay.appendChild(labelEl);

  positionMarkerAndLabel(el, labelEl, x, y);
  links.set(pointerId, { tokenId, el, labelEl, interaction: null, moveTimeout: null });
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
    console.log(`[Tisch] Re-Link: ${pointerId} -> ${bestTokenId}`);
    return true;
  }
  return false;
}

async function moveLinkedToken(pointerId, x, y) {
  const link = links.get(pointerId);
  if (!link) return;
  positionMarkerAndLabel(link.el, link.labelEl, x, y);

  const scenePos = await OBR.viewport.inverseTransformPoint({ x, y });

  if (!link.interaction) {
    const token = sceneTokens.find((t) => t.id === link.tokenId);
    if (!token) return;
    link.interaction = await OBR.interaction.startItemInteraction(token);
  }
  const [update] = link.interaction;
  update((draft) => { draft.position = scenePos; });

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
  pending.set(pointerId, { x, y, el, labelEl });
  publishContacts();
  console.log(`[Tisch] Neuer Kontakt erstellt: ${pointerId}`);
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
  if (p) { p.el.remove(); p.labelEl.remove(); pending.delete(pointerId); publishContacts(); return; }
  handleLinkedUp(pointerId);
});

overlay.addEventListener("pointercancel", (e) => overlay.dispatchEvent(new PointerEvent("pointerup", e)));
overlay.addEventListener("contextmenu", (e) => e.preventDefault());
