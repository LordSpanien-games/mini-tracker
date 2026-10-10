import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

OBR.onReady(() => {});

async function openTableOverlay() {
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
  await OBR.action.close();
}

async function openHostDashboard() {
  await OBR.popover.open({
    id: "com.minitracker.control",
    url: "https://lordspanien-games.github.io/mini-tracker/control.html",
    width: 420,
    height: 640,
    anchorReference: "POSITION",
    anchorPosition: { left: 80, top: 80 },
    disableClickAway: true,
  });
  await OBR.action.close();
}

document.getElementById("tableBtn").addEventListener("click", openTableOverlay);
document.getElementById("hostBtn").addEventListener("click", openHostDashboard);
