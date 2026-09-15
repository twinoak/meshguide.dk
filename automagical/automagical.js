// automagical.js - index.html: configure the device on the other end of a USB
// cable (repeater / room server / USB companion) or a Bluetooth link (BLE
// companion). Connecting and identifying the firmware happens here; reading,
// map, recommendations and applying are the shared flow in flow.js.

import { MeshCoreSerial, serialSupported } from "./serial.js";
import { MeshCoreBle, bluetoothSupported } from "./ble.js";
import { $, CANCEL_MESSAGES, createFlow, createLog, installCopyButtons, setProgress, showConnectError, showError } from "./flow.js";

const ui = {
  status: $("status"), btnConnect: $("btnConnect"), btnConnectBle: $("btnConnectBle"), btnDisconnect: $("btnDisconnect"), btnReread: $("btnReread"),
  connectError: $("connectError"), device: $("device"), deviceError: $("deviceError"), deviceNote: $("deviceNote"), deviceTable: $("deviceTable"),
  location: $("location"), locationText: $("locationText"), map: $("map"), mapHint: $("mapHint"), btnPick: $("btnPick"), btnUseDevice: $("btnUseDevice"), scopesText: $("scopesText"),
  recommend: $("recommend"), findings: $("findings"), plan: $("plan"), btnApply: $("btnApply"), btnReboot: $("btnReboot"), applyStatus: $("applyStatus"), applyLog: $("applyLog"), rebootNote: $("rebootNote"),
  serialLog: $("serialLog"),
  readProgress: $("readProgress"), applyProgress: $("applyProgress")
};

const log = createLog(ui.serialLog);

function setStatus(text, cls) {
  ui.status.textContent = text;
  ui.status.className = "am-status" + (cls ? " " + cls : "");
}

const flow = createFlow({
  ui, log, setStatus, mode: "direct",
  reread: () => readDevice(), // identify again, so a companion's DEVICE_INFO is fresh
  onReboot: async () => { await disconnect(); setStatus("Enheden genstarter - tilslut igen om et øjeblik", ""); }
});

let link = null;

// transport: "usb" (Web Serial: repeater / room server / USB companion) or
// "ble" (Web Bluetooth: BLE companion, like the app).
async function connect(transport) {
  showError(ui.connectError, "");
  ui.btnConnect.disabled = true;
  ui.btnConnectBle.disabled = true;
  setStatus(transport === "ble" ? "Forbinder via Bluetooth … (vælg enheden, og indtast PIN hvis du bliver spurgt)" : "Forbinder …", "busy");
  const l = transport === "ble" ? new MeshCoreBle({ onLog: log }) : new MeshCoreSerial({ onLog: log });
  try {
    await l.connect();
  } catch (e) {
    ui.btnConnect.disabled = false;
    ui.btnConnectBle.disabled = false;
    setStatus("Ikke forbundet", "");
    if (e && CANCEL_MESSAGES.includes(e.message)) return; // user closed the picker
    log("error", (transport === "ble" ? "Bluetooth: " : "Seriel: ") + (e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : e));
    showConnectError(ui.connectError, transport, e);
    return;
  }
  link = l;
  flow.setLink(link);
  ui.btnConnect.hidden = true;
  ui.btnConnectBle.hidden = true;
  ui.btnDisconnect.hidden = false;
  ui.btnReread.hidden = false;
  setStatus(transport === "ble" ? "Forbundet via Bluetooth" : "Forbundet", "connected");
  await readDevice();
}

async function disconnect() {
  if (link) await link.disconnect();
  link = null;
  flow.setLink(null);
  ui.btnConnect.hidden = false;
  ui.btnConnect.disabled = false;
  ui.btnConnectBle.hidden = !bluetoothSupported();
  ui.btnConnectBle.disabled = false;
  ui.btnDisconnect.hidden = true;
  ui.btnReread.hidden = true;
  setStatus("Ikke forbundet", "");
}

// Which firmware is this? Text CLI (repeater/room/sensor) or the companion's
// binary protocol? Then hand over to the flow.
async function readDevice() {
  if (!link) return;
  setStatus("Identificerer firmware …", "busy");
  setProgress(ui.readProgress, { text: "Spørger enheden hvilken firmware den kører …" });
  ui.btnReread.disabled = true;
  ui.device.hidden = false;
  showError(ui.deviceError, "");
  showError(ui.deviceNote, "");
  let id;
  try {
    id = await link.identify();
  } catch (e) {
    console.error(e);
    flow.showUnknown("Kunne ikke tale med enheden (" + (e && e.message ? e.message : e) + "). Er kablet stadig i? Prøv Genlæs enheden, eller Afbryd og tilslut igen.");
    return;
  }
  flow.app.identity = id;
  if (id.kind === "companion") {
    await flow.showCompanion(id);
    return;
  }
  if (id.kind === "unknown") {
    flow.showUnknown(link.kind === "ble"
      ? "Ingen svar over Bluetooth. Blev parringen (PIN) gennemført, og er det en MeshCore-companion? Prøv Genlæs enheden - eller se loggen nederst."
      : "Enheden svarede hverken som repeater (tekst-CLI) eller companion (binær protokol). Er det den rigtige port, er enheden tændt, og kører den MeshCore-firmware? Bemærk: en companion med BLE- eller WiFi-firmware har ingen USB-kommunikation - tilslut den via Bluetooth i stedet. Prøv Genlæs enheden - eller se den serielle log nederst.");
    return;
  }
  await flow.readSettings();
}

// --- Wire up -----------------------------------------------------------------------

if (!serialSupported()) {
  $("noSerial").hidden = false;
  ui.btnConnect.disabled = true;
}
ui.btnConnectBle.hidden = !bluetoothSupported();
ui.btnConnect.addEventListener("click", () => connect("usb"));
ui.btnConnectBle.addEventListener("click", () => connect("ble"));
ui.btnDisconnect.addEventListener("click", disconnect);
ui.btnReread.addEventListener("click", readDevice);
installCopyButtons();
