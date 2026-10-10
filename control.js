import OBR, { isImage } from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

const contactList = document.getElementById("contactList");
const empty = document.getElementById("empty");
const panelHeader = document.getElementById("panelHeader");
const panelBody = document.getElementById("panelBody");
const toggleIcon = document.getElementById("toggleIcon");

const META_KEY_CONTACTS = "com.minitracker/contacts";
const META_KEY_LINKS = "com.minitracker/links";

let sceneTokens = [];
let currentContacts = {};

panelHeader.addEventListener("click", () => {
  panelBody.classList.toggle("collapsed");
  toggleIcon.textContent = panelBody.classList.contains("collapsed") ? "▸" : "▾";
});

OBR.onReady(async () => {
  console.log("[Host] SDK bereit.");
  const ready = await OBR.scene.isReady();
  if (ready) await loadTokens();
  OBR.scene.onReadyChange(async (isReady) => { if (isReady) await loadTokens(); });
  OBR.scene.items.onChange(async () => { await loadTokens(); });

  const meta = await OBR.room.getMetadata();
  console.log("[Host] Initiale Metadata:", meta);
  currentContacts = meta[META_KEY_CONTACTS] || {};
  render();

  OBR.room.onMetadataChange((metadata) => {
    console.log("[Host] Metadata-Änderung empfangen:", metadata[META_KEY_CONTACTS]);
    currentContacts = metadata[META_KEY_CONTACTS] || {};
    render();
  });
});

async function loadTokens() {
  sceneTokens = await OBR.scene.items.getItems(
    (item) => item.layer === "CHARACTER" && isImage(item)
  );
  console.log("[Host] Tokens geladen:", sceneTokens.map(t => t.name));
  render();
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

    if (sceneTokens.length === 0) {
      const warn = document.createElement("div");
      warn.style.color = "#f33";
      warn.style.fontSize = "12px";
      warn.textContent = "Keine Tokens in der Szene gefunden!";
      card.appendChild(warn);
    }

    sceneTokens.forEach((t) => {
      const opt = document.createElement("div");
      opt.className = "tokenOption";
      opt.textContent = t.name || "(ohne Namen)";
      opt.addEventListener("pointerdown", async (ev) => {
        ev.preventDefault();
        console.log(`[Host] Klick: Kontakt ${pointerId} -> Token ${t.id} (${t.name})`);
        opt.textContent = "Wird zugewiesen...";
        try {
          await assign(pointerId, t.id);
          opt.textContent = "✅ Zugewiesen: " + (t.name || "(ohne Namen)");
          console.log("[Host] setMetadata erfolgreich");
        } catch (err) {
          opt.textContent = "❌ Fehler: " + err.message;
          console.error("[Host] Fehler bei assign():", err);
        }
      });
      card.appendChild(opt);
    });
    contactList.appendChild(card);
  }
}

async function assign(pointerId, tokenId) {
  const meta = await OBR.room.getMetadata();
  console.log("[Host] Aktuelle Links vor Update:", meta[META_KEY_LINKS]);
  const links = { ...(meta[META_KEY_LINKS] || {}), [pointerId]: tokenId };
  await OBR.room.setMetadata({ [META_KEY_LINKS]: links });
  console.log("[Host] Neue Links geschrieben:", links);
}
