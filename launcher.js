import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

const status = document.getElementById("status");

OBR.onReady(() => { status.textContent = "SDK bereit."; });

async function openFullscreen(url, id) {
  await OBR.popover.open({
    id,
    url,
    width: window.screen.width,
    height: window.screen.height,
    anchorReference: "POSITION",
    anchorPosition: { left: 0, top: 0 },
    hidePaper: true,
    disableClickAway: true,
  });
  status.textContent = "Geöffnet.";
}

document.getElementById("tableBtn").addEventListener("click", () =>
  openFullscreen("https://lordspanien-games.github.io/mini-tracker/overlay.html", "com.minitracker.overlay")
);
document.getElementById("hostBtn").addEventListener("click", () =>
  openFullscreen("https://lordspanien-games.github.io/mini-tracker/control.html", "com.minitracker.control")
);
