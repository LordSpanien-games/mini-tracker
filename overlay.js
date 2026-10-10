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

  // Sofort-Teleport: Position direkt hart setzen, ohne auf eine Bewegung zu warten.
  // Verhindert, dass der Token "liegen bleibt" oder animiert über Wände/Fog gleitet.
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
