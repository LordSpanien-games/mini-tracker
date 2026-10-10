import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

const status = document.getElementById("status");
const btn = document.getElementById("openBtn");

OBR.onReady(() => {
  status.textContent = "SDK bereit.";
});

async function openOverlay() {
  await OBR.popover.open({
    id: "com.minitracker.overlay",
    url: "https://lordspanien-games.github.io/mini-tracker/overlay.html",
    width: window.screen.width,
    height: window.screen.height,
    anchorReference: "POSITION",
    anchorPosition: { left: 0, top: 0 },
    hidePaper: true,
    disableClickAway: true,
  });
  status.textContent = "Overlay geöffnet.";
}

btn.addEventListener("click", openOverlay);
