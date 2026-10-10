import OBR, { isImage } from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

const contactList = document.getElementById("contactList");
const empty = document.getElementById("empty");

const META_KEY_CONTACTS = "com.minitracker/contacts";
const META_KEY_LINKS = "com.minitracker/links";

let sceneTokens = [];
let currentContacts = {};

OBR.onReady(async () => {
  const ready = await OBR.scene.isReady();
  if (ready) await loadTokens();
  OBR.scene.onReadyChange(async (isReady) => { if (isReady) await loadTokens(); });
  OBR.scene.items.onChange(async () => { await loadTokens(); });

  const meta = await OBR.room.getMetadata();
  currentContacts = meta[META_KEY_CONTACTS] || {};
  render();

  OBR.room.onMetadataChange((metadata) => {
    currentContacts = metadata[META_KEY_CONTACTS] || {};
    render();
  });
});

async function loadTokens() {
  sceneTokens = await OBR.scene.items.getItems(
    (item) => item.layer === "CHARACTER" && isImage(item)
  );
}

function render() {
  const ids = Object.keys(currentContacts);
  if (ids.length === 0) {
    contactList.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  contactList.innerHTML = "";
  for (const pointerId of ids) {
    const card = document.createElement("div");
    card.className = "contact";
    card.innerHTML = `<div class="label">Kontakt #${pointerId}</div>`;
    sceneTokens.forEach((t) => {
      const opt = document.createElement("div");
      opt.className = "tokenOption";
      opt.textContent = t.name || "(ohne Namen)";
      opt.addEventListener("click", () => assign(pointerId, t.id));
      card.appendChild(opt);
    });
    contactList.appendChild(card);
  }
}

async function assign(pointerId, tokenId) {
  const meta = await OBR.room.getMetadata();
  const links = { ...(meta[META_KEY_LINKS] || {}), [pointerId]: tokenId };
  await OBR.room.setMetadata({ [META_KEY_LINKS]: links });
}
