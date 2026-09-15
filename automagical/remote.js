// remote.js - remote.html: configure a repeater through a companion's radio.
//
// Connect to a companion (USB or Bluetooth) -> fetch its contact list -> pick a
// repeater / room server -> log in with the admin password -> then the shared
// flow (flow.js) reads, compares and applies over remote-cli.js, with the
// radio settings locked (shown, never sent).

import { MeshCoreSerial, serialSupported } from "./serial.js";
import { MeshCoreBle, bluetoothSupported } from "./ble.js";
import { RemoteCli } from "./remote-cli.js";
import { createContactPicker } from "./contacts-ui.js";
import { $, CANCEL_MESSAGES, createFlow, createLog, installCopyButtons, setProgress, showConnectError, showError } from "./flow.js";

const ui = {
  status: $("status"), btnConnect: $("btnConnect"), btnConnectBle: $("btnConnectBle"), btnDisconnect: $("btnDisconnect"), connectError: $("connectError"), connectProgress: $("connectProgress"), companionInfo: $("companionInfo"),
  contacts: $("contacts"), contactsError: $("contactsError"), btnContacts: $("btnContacts"), btnDiscover: $("btnDiscover"), btnShowAll: $("btnShowAll"), discoverText: $("discoverText"), contactsText: $("contactsText"), contactsProgress: $("contactsProgress"), contactTable: $("contactTable"),
  login: $("login"), loginName: $("loginName"), loginError: $("loginError"), password: $("password"), btnLogin: $("btnLogin"), btnReread: $("btnReread"), loginStatus: $("loginStatus"), readProgress: $("readProgress"),
  device: $("device"), deviceError: $("deviceError"), deviceNote: $("deviceNote"), deviceTable: $("deviceTable"),
  location: $("location"), locationText: $("locationText"), map: $("map"), mapHint: $("mapHint"), btnPick: $("btnPick"), btnUseDevice: $("btnUseDevice"), scopesText: $("scopesText"),
  recommend: $("recommend"), findings: $("findings"), plan: $("plan"), btnApply: $("btnApply"), btnReboot: $("btnReboot"), applyStatus: $("applyStatus"), applyLog: $("applyLog"), rebootNote: $("rebootNote"), applyProgress: $("applyProgress"),
  serialLog: $("serialLog")
};

const log = createLog(ui.serialLog);

// Two status lines: the companion's (section 1) and the repeater login's (section 3).
// The flow reports into the login one, since that is where reading happens.
function setStatus(text, cls) {
  ui.status.textContent = text;
  ui.status.className = "am-status" + (cls ? " " + cls : "");
}
function setLoginStatus(text, cls) {
  ui.loginStatus.textContent = text;
  ui.loginStatus.className = "am-status" + (cls ? " " + cls : "");
}

const flow = createFlow({
  ui, log, setStatus: setLoginStatus, mode: "remote",
  onReboot: async () => { setLoginStatus("Genstart sendt - repeateren er tilbage om lidt. Log ind igen bagefter.", ""); endLogin(); }
});

const state = {
  link: null,        // MeshCoreSerial | MeshCoreBle to the companion
  companion: null,   // identify() result
  contact: null,     // the selected repeater
  remote: null       // RemoteCli once logged in
};

// The repeater table: contact list + "repeaters nearby", shared with v2.
const picker = createContactPicker({
  ui, log,
  getLink: () => state.link,
  onSelect: c => {
    if (!c) { state.contact = null; ui.login.hidden = true; return; }
    if (state.remote && state.contact && state.contact.publicKey !== c.publicKey) endLogin();
    state.contact = c;
    ui.loginName.textContent = c.name || (c.discovered ? "repeateren " + c.publicKey.slice(0, 12) + "…" : "(uden navn)");
    ui.login.hidden = false;
    if (!state.remote) {
      ui.password.focus();
      ui.login.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
});

// --- 1. Companion -----------------------------------------------------------------

async function connect(transport) {
  showError(ui.connectError, "");
  ui.btnConnect.disabled = true;
  ui.btnConnectBle.disabled = true;
  setStatus(transport === "ble" ? "Forbinder via Bluetooth … (vælg companionen, og indtast PIN hvis du bliver spurgt)" : "Forbinder …", "busy");
  const link = transport === "ble" ? new MeshCoreBle({ onLog: log }) : new MeshCoreSerial({ onLog: log });
  try {
    await link.connect();
  } catch (e) {
    ui.btnConnect.disabled = false;
    ui.btnConnectBle.disabled = false;
    setStatus("Ikke forbundet", "");
    if (e && CANCEL_MESSAGES.includes(e.message)) return; // user closed the picker
    log("error", (transport === "ble" ? "Bluetooth: " : "Seriel: ") + (e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : e));
    showConnectError(ui.connectError, transport, e);
    return;
  }
  state.link = link;
  ui.btnConnect.hidden = true;
  ui.btnConnectBle.hidden = true;
  ui.btnDisconnect.hidden = false;
  setStatus("Identificerer firmware …", "busy");
  setProgress(ui.connectProgress, { text: "Spørger enheden hvilken firmware den kører …" });
  let id;
  try {
    id = await link.identify();
    if (id.kind === "companion") {
      const set = await link.companionSetTime();
      log("info", set ? "companionens ur sat til computerens tid" : "companionens ur er foran computerens - det beholdes (firmwaren stiller kun uret frem)");
    }
  } catch (e) {
    setProgress(ui.connectProgress, null);
    setStatus("Fejl: " + (e && e.message ? e.message : e), "error");
    showError(ui.connectError, "Kunne ikke tale med enheden (" + (e && e.message ? e.message : e) + "). Afbryd og tilslut igen.");
    return;
  }
  setProgress(ui.connectProgress, null);
  if (id.kind === "cli") {
    setStatus("Det er ikke en companion", "error");
    showError(ui.connectError, "Enheden i den anden ende er en " + (id.role || "repeater") + " med CLI, ikke en companion. Den kan sættes op direkte på den almindelige opsætningsside - denne side skal have en companion, hvis radio bruges til at nå repeateren.");
    return;
  }
  if (id.kind === "unknown") {
    setStatus("Forbundet, men enheden svarer ikke", "error");
    showError(ui.connectError, link.kind === "ble"
      ? "Ingen svar over Bluetooth. Blev parringen (PIN) gennemført, og er det en MeshCore-companion? Afbryd og prøv igen - eller se loggen nederst."
      : "Enheden svarede hverken som companion eller repeater. Er det den rigtige port, er enheden tændt, og kører den MeshCore-firmware? En BLE- eller WiFi-companion har ingen USB-kommunikation - en BLE-companion tilsluttes via Bluetooth.");
    return;
  }
  state.companion = id;
  const s = id.selfInfo, d = id.deviceInfo;
  setStatus("Companion forbundet" + (link.kind === "ble" ? " via Bluetooth" : "") + (s && s.name ? ": " + s.name : ""), "connected");
  ui.companionInfo.textContent = "Companion: " + (s && s.name ? s.name : "(uden navn)") + (d ? " · " + d.board + " · " + (d.firmwareVersion || "") : "")
    + (s && s.radio ? " · radio " + s.radio.freq + " MHz / BW " + s.radio.bw + " kHz / SF " + s.radio.sf + " / CR 4/" + s.radio.cr : "")
    + ". Repeateren skal køre de samme radioindstillinger for at kunne nås.";
  ui.companionInfo.hidden = false;
  ui.contacts.hidden = false;
  await picker.start(); // contact list (for names), then a discovery
}

async function disconnect() {
  endLogin();
  if (state.link) await state.link.disconnect();
  state.link = null;
  state.companion = null;
  state.contact = null;
  picker.reset();
  ui.btnConnect.hidden = false;
  ui.btnConnect.disabled = false;
  ui.btnConnectBle.hidden = !bluetoothSupported();
  ui.btnConnectBle.disabled = false;
  ui.btnDisconnect.hidden = true;
  ui.companionInfo.hidden = true;
  ui.contacts.hidden = true;
  ui.contactTable.innerHTML = "";
  ui.login.hidden = true;
  setProgress(ui.connectProgress, null);
  setStatus("Ikke forbundet", "");
}

// --- 3. Login -----------------------------------------------------------------------

async function login() {
  if (!state.link || !state.contact) return;
  const password = ui.password.value;
  showError(ui.loginError, "");
  if (!password) { showError(ui.loginError, "Skriv repeaterens admin-adgangskode."); return; }
  endLogin();
  ui.btnLogin.disabled = true;
  ui.password.disabled = true;
  setLoginStatus("Logger ind på " + (state.contact.name || "repeateren") + " over mesh'et …", "busy");
  setProgress(ui.readProgress, { text: "Sender login og venter på svar fra repeateren (op til 3 forsøg) …" });
  const remote = new RemoteCli(state.link, state.contact, { onLog: log });
  let res;
  try {
    // A repeater found only by discovery must be a contact before the companion will send it a login.
    const known = await picker.ensureContact(state.contact);
    if (!known) throw new Error("companionen kunne ikke tilføje repeateren som kontakt");
    res = await remote.login(password);
  } catch (e) {
    res = { ok: false, reason: e && e.message ? e.message : String(e) };
  }
  setProgress(ui.readProgress, null);
  ui.btnLogin.disabled = false;
  ui.password.disabled = false;
  if (!res.ok) {
    setLoginStatus("Ikke logget ind", "error");
    showError(ui.loginError, res.reason === "password"
      ? "Repeateren afviste adgangskoden."
      : res.reason === "timeout"
        ? "Intet svar fra repeateren efter 3 forsøg. Er den tændt og inden for rækkevidde af companionen (samme radioindstillinger)? Prøv igen om lidt."
        : "Login mislykkedes: " + res.reason);
    return;
  }
  if (!res.isAdmin) {
    setLoginStatus("Logget ind som gæst - ikke nok", "error");
    showError(ui.loginError, "Repeateren accepterede adgangskoden, men kun som gæst (det var gæste-adgangskoden). CLI-kommandoer over mesh kræver admin-adgangskoden.");
    return;
  }
  state.remote = remote;
  ui.password.value = "";
  ui.btnReread.hidden = false;
  setLoginStatus("Logget ind på " + (state.contact.name || "repeateren") + " - læser indstillinger …", "busy");
  flow.setLink(remote);
  await flow.readSettings();
}

// Forgets the remote login and hides everything below section 3.
function endLogin() {
  if (state.remote) state.remote.disconnect();
  state.remote = null;
  flow.setLink(null);
  flow.reset();
  ui.btnReread.hidden = true;
  setLoginStatus("", "");
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
ui.btnLogin.addEventListener("click", login);
ui.password.addEventListener("keydown", e => { if (e.key === "Enter") login(); });
ui.btnReread.addEventListener("click", () => flow.readSettings());
installCopyButtons();
