// app.js - meshguide.dk: the guide around the configurator.
//
// One page, routed on the URL hash, so a device connection survives the steps:
//
//   #/                      what do you want?
//   #/companion             companion: USB or Bluetooth?
//   #/companion/usb|ble     -> direct flow (identify, read, recommend, apply)
//   #/repeater              repeater: direct USB, or over the mesh via a companion?
//   #/repeater/usb          -> direct flow
//   #/repeater/remote       companion: USB or Bluetooth?
//   #/repeater/remote/usb|ble -> remote flow (contacts, login, then the same flow)
//   #/defaults              the map + the recommended settings
//   #radio-indstillinger    (and the other old front-page anchors) -> #/defaults, scrolled there
//
// Nothing about talking to devices lives here: lib/serial.js / ble.js / remote-cli.js
// do the talking, lib/checks.js holds the rules, lib/flow.js the read -> map ->
// recommend -> apply part. This file is the guide around them.

import { MeshCoreSerial, serialSupported } from "./lib/serial.js";
import { MeshCoreBle, bluetoothSupported } from "./lib/ble.js";
import { RemoteCli } from "./lib/remote-cli.js";
import { createContactPicker } from "./lib/contacts-ui.js";
import { $, BRAVE_BLE_FLAG, CANCEL_MESSAGES, createFlow, createLog, escapeHtml, fetchJSON, installCopyButtons, loadDataset, setProgress, showConnectError, showError } from "./lib/flow.js";
import { BEST_PRACTICE, formatRadio, roleLabel } from "./lib/checks.js";
import { scopesForPoint } from "./lib/scopes.js";

const ui = {
  crumbs: $("crumbs"),
  // direct
  directTitle: $("directTitle"), directIntro: $("directIntro"), directCheck: $("directCheck"), noSupport: $("noSupport"), connectError: $("connectError"), btnConnect: $("btnConnect"), connectHint: $("connectHint"), directBack: $("directBack"),
  // remote
  remoteIntro: $("remoteIntro"), remoteCheck: $("remoteCheck"), remoteNoSupport: $("remoteNoSupport"), remoteConnectError: $("remoteConnectError"), btnRemoteConnect: $("btnRemoteConnect"), remoteStatus: $("remoteStatus"), remoteProgress: $("remoteProgress"), companionInfo: $("companionInfo"),
  contacts: $("contacts"), contactsError: $("contactsError"), btnContacts: $("btnContacts"), btnDiscover: $("btnDiscover"), btnShowAll: $("btnShowAll"), discoverText: $("discoverText"), contactsText: $("contactsText"), contactsProgress: $("contactsProgress"), contactTable: $("contactTable"),
  login: $("login"), loginName: $("loginName"), loginError: $("loginError"), password: $("password"), btnLogin: $("btnLogin"),
  // guidance
  kindNotice: $("kindNotice"), kindText: $("kindText"), kindActions: $("kindActions"),
  // shared flow
  runbar: $("runbar"), status: $("status"), btnReread: $("btnReread"), btnDisconnect: $("btnDisconnect"), readProgress: $("readProgress"),
  device: $("device"), deviceError: $("deviceError"), deviceNote: $("deviceNote"), deviceTable: $("deviceTable"),
  location: $("location"), locationText: $("locationText"), map: $("map"), mapHint: $("mapHint"), btnPick: $("btnPick"), btnUseDevice: $("btnUseDevice"), scopesText: $("scopesText"),
  recommend: $("recommend"), findings: $("findings"), plan: $("plan"), btnApply: $("btnApply"), btnReboot: $("btnReboot"), applyStatus: $("applyStatus"), applyLog: $("applyLog"), rebootNote: $("rebootNote"), applyProgress: $("applyProgress"),
  logSection: $("logSection"), serialLog: $("serialLog"),
  // defaults
  defaultsMap: $("defaultsMap"), defaultsHint: $("defaultsHint"), defaultsCliTitle: $("defaultsCliTitle"), defaultsCli: $("defaultsCli"), defaultsGps: $("defaultsGps"), defaultsGpsCoords: $("defaultsGpsCoords")
};

const log = createLog(ui.serialLog);

function setStatus(text, cls) {
  ui.status.textContent = text;
  ui.status.className = "am-status" + (cls ? " " + cls : "");
}
function setRemoteStatus(text, cls) {
  ui.remoteStatus.textContent = text;
  ui.remoteStatus.className = "am-status" + (cls ? " " + cls : "");
}

const TRANSPORT_LABEL = { usb: "USB", ble: "Bluetooth" };

const state = {
  route: null,        // parsed route
  link: null,         // MeshCoreSerial | MeshCoreBle
  identity: null,     // link.identify() result
  remote: null,       // RemoteCli once logged in
  contact: null       // the selected repeater
};

// The repeater table: contact list + "repeaters nearby" (shared with remote.html).
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

// One flow for both ways of reaching a device; setMode() switches the remote
// rules (locked radio, mesh wording) on and off.
const flow = createFlow({
  ui, log, setStatus, mode: "direct",
  reread: () => reread(),
  onReboot: async () => {
    if (state.remote) { setStatus("Genstart sendt - repeateren er tilbage om lidt. Log ind igen bagefter.", ""); endLogin(); return; }
    await disconnect();
    render();
    setStatus("Enheden genstarter - tilslut igen om et øjeblik", "");
  }
});

// --- Routing -----------------------------------------------------------------------

// The old front page was one long page with these heading anchors; links to
// them (wiki, Facebook) still work: they open the defaults view at that heading.
const LEGACY_ANCHORS = new Set(["regioner", "region-scopes", "radio", "radio-indstillinger", "indstillinger", "diverse-indstillinger", "social", "bidrag"]);

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [a, b, c] = parts;
  if (!a) return { view: "start", parts };
  if (a === "defaults") return { view: "defaults", parts };
  if (LEGACY_ANCHORS.has(a) && parts.length === 1) return { view: "defaults", parts: ["defaults"], anchor: a };
  if (a === "companion") {
    if (!b) return { view: "companion", parts };
    if (b === "usb" || b === "ble") return { view: "direct", kind: "companion", transport: b, parts };
  }
  if (a === "repeater") {
    if (!b) return { view: "repeater", parts };
    if (b === "usb") return { view: "direct", kind: "repeater", transport: "usb", parts };
    if (b === "remote") {
      if (!c) return { view: "repeater-remote", parts };
      if (c === "usb" || c === "ble") return { view: "remote", transport: c, parts };
    }
  }
  return { view: "start", parts: [] };
}

const CRUMB_LABELS = { companion: "Companion", repeater: "Repeater", remote: "Via companion", usb: "USB", ble: "Bluetooth", defaults: "Anbefalinger" };

function renderCrumbs(route) {
  ui.crumbs.replaceChildren();
  ui.crumbs.hidden = route.view === "start";
  if (ui.crumbs.hidden) return;
  const home = document.createElement("a");
  home.href = "#/";
  home.textContent = "Start";
  ui.crumbs.append(home);
  let path = "#";
  route.parts.forEach((p, i) => {
    path += "/" + p;
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "›";
    ui.crumbs.append(sep);
    const last = i === route.parts.length - 1;
    const el = document.createElement(last ? "span" : "a");
    if (!last) el.href = path;
    el.className = last ? "current" : "";
    el.textContent = CRUMB_LABELS[p] || p;
    ui.crumbs.append(el);
  });
}

async function render() {
  const route = parseRoute();
  state.route = route;
  renderCrumbs(route);
  for (const el of document.querySelectorAll("section[data-view]")) el.hidden = el.dataset.view !== route.view;
  ui.contacts.hidden = true;
  ui.login.hidden = true;
  ui.kindNotice.hidden = true;

  const deviceView = route.view === "direct" || route.view === "remote";
  if (!deviceView) {
    await disconnect();
    hideFlow();
  } else if (state.link && state.link.kind !== route.transport) {
    await disconnect(); // the link we have is on the other transport
  }

  if (route.view === "direct") renderDirect(route);
  else if (route.view === "remote") renderRemote(route);
  else if (route.view === "defaults") renderDefaults();
  if (route.anchor) $(route.anchor).scrollIntoView();
  else window.scrollTo({ top: 0 });
}

function hideFlow() {
  ui.runbar.hidden = true;
  ui.device.hidden = true;
  ui.location.hidden = true;
  ui.recommend.hidden = true;
  ui.logSection.hidden = true;
}

// --- Direct: the device itself is on the other end of the link ----------------------

const DIRECT_TEXT = {
  "companion/usb": {
    title: "Forbind companionen via USB",
    intro: "Sæt companionen i computeren med et USB-kabel med data, og klik Tilslut. Browseren spørger hvilken port den skal bruge. Siden læser companionens indstillinger og skriver kun det du selv vælger til sidst.",
    check: [
      "<strong>Firmware er flashet</strong> - <code>companion_radio_usb</code> fra <a href=\"https://flasher.meshcore.io/\" target=\"_blank\" rel=\"noopener\">flasher.meshcore.io</a>. Er det en BLE-companion, har den ingen USB-kommunikation: <a href=\"#/companion/ble\">gå til Bluetooth</a>.",
      "<strong>Kun ét program ad gangen</strong> kan holde porten: luk flasheren, den serielle monitor og lignende først.",
      "<strong>Chrome, Edge eller Brave</strong> på en computer - ikke Firefox, Safari eller telefon."
    ]
  },
  "companion/ble": {
    title: "Forbind companionen via Bluetooth",
    intro: "Klik Tilslut og vælg companionen (MeshCore-…) i browserens liste. Computeren spørger om enhedens PIN - den vises på skærmen hvis enheden har en, ellers 123456 eller den PIN du har sat i appen.",
    check: [
      "<strong>Firmware er flashet</strong> - <code>companion_radio_ble</code> fra <a href=\"https://flasher.meshcore.io/\" target=\"_blank\" rel=\"noopener\">flasher.meshcore.io</a>, og enheden er tændt.",
      "<strong>Luk appen på telefonen</strong> - en companion har kun én Bluetooth-forbindelse ad gangen.",
      "<strong>Chrome eller Edge</strong> på en computer. Brave virker også, men har Web Bluetooth slået fra: indsæt <code>" + BRAVE_BLE_FLAG + "</code><button type=\"button\" class=\"am-copy\" data-copy=\"" + BRAVE_BLE_FLAG + "\">Kopiér</button> i adresselinjen, vælg Enabled og genstart browseren."
    ]
  },
  "repeater/usb": {
    title: "Forbind repeateren via USB",
    intro: "Sæt repeateren (eller room serveren) i computeren med et USB-kabel med data, og klik Tilslut. Siden læser dens indstillinger, finder dens placering og viser hvad der bør ændres - intet skrives før du klikker Anvend.",
    check: [
      "<strong>Firmware er flashet</strong> - repeater- eller room server-firmware fra <a href=\"https://flasher.meshcore.io/\" target=\"_blank\" rel=\"noopener\">flasher.meshcore.io</a>.",
      "<strong>Kun ét program ad gangen</strong> kan holde porten: luk flasheren, den serielle monitor og lignende først.",
      "<strong>Placering</strong>: har repeateren ingen position gemt, bliver du bedt om at klikke på kortet hvor den står - det bestemmer dens region scopes.",
      "<strong>Chrome, Edge eller Brave</strong> på en computer - ikke Firefox, Safari eller telefon."
    ]
  }
};

function renderDirect(route) {
  const key = route.kind + "/" + route.transport;
  const t = DIRECT_TEXT[key];
  ui.directTitle.textContent = t.title;
  ui.directIntro.textContent = t.intro;
  ui.directCheck.innerHTML = t.check.map(c => "<li>" + c + "</li>").join("");
  ui.directBack.href = route.kind === "companion" ? "#/companion" : "#/repeater";
  ui.btnConnect.textContent = "Tilslut via " + TRANSPORT_LABEL[route.transport];
  showError(ui.connectError, "");
  const supported = route.transport === "ble" ? bluetoothSupported() : serialSupported();
  ui.btnConnect.disabled = !supported;
  showError(ui.noSupport, supported ? "" : (route.transport === "ble"
    ? "Din browser har ikke Web Bluetooth. Brug Chrome eller Edge på en computer (i Brave: slå det til under " + BRAVE_BLE_FLAG + ")."
    : "Din browser har ikke Web Serial. Brug Chrome, Edge eller Brave på en computer."));
  ui.connectHint.textContent = "";
  flow.setMode("direct");
  if (state.link && state.link.kind === route.transport && state.identity) {
    // Arrived here from a "det er en anden slags enhed" notice: the link is already open.
    endLogin();
    flow.setLink(state.link);
    ui.btnConnect.hidden = true;
    setConnectedLook(true);
    ui.connectHint.textContent = "Forbindelsen fra før beholdes.";
    ui.runbar.hidden = false;
    ui.logSection.hidden = false;
    dispatchDirect();
  } else {
    ui.btnConnect.hidden = false;
  }
}

async function openLink(transport, errorEl, statusFn) {
  showError(errorEl, "");
  statusFn(transport === "ble" ? "Forbinder via Bluetooth … (vælg enheden, og indtast PIN hvis du bliver spurgt)" : "Forbinder …", "busy");
  const link = transport === "ble" ? new MeshCoreBle({ onLog: log }) : new MeshCoreSerial({ onLog: log });
  try {
    await link.connect();
  } catch (e) {
    statusFn("Ikke forbundet", "");
    if (e && CANCEL_MESSAGES.includes(e.message)) return null; // user closed the picker
    log("error", (transport === "ble" ? "Bluetooth: " : "Seriel: ") + (e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : e));
    showConnectError(errorEl, transport, e);
    return null;
  }
  return link;
}

async function connectDirect() {
  const route = state.route;
  ui.btnConnect.disabled = true;
  ui.runbar.hidden = false;
  ui.logSection.hidden = false;
  const link = await openLink(route.transport, ui.connectError, setStatus);
  if (!link) { ui.btnConnect.disabled = false; ui.runbar.hidden = true; return; }
  state.link = link;
  flow.setLink(link);
  ui.btnConnect.hidden = true;
  setConnectedLook(true);
  await identify();
  dispatchDirect();
}

// Once a link is open the introduction and checklist have done their job; fold
// them away so the device is what the page is about.
function setConnectedLook(on) {
  for (const el of document.querySelectorAll('section[data-view="direct"], section[data-view="remote"]')) el.classList.toggle("connected", on);
}

// Asks the device what it is; state.identity holds the answer.
async function identify() {
  setStatus("Identificerer firmware …", "busy");
  setProgress(ui.readProgress, { text: "Spørger enheden hvilken firmware den kører …" });
  ui.btnReread.disabled = true;
  try {
    state.identity = await state.link.identify();
  } catch (e) {
    console.error(e);
    state.identity = { kind: "error", error: e && e.message ? e.message : String(e) };
  }
  setProgress(ui.readProgress, null);
  ui.btnReread.disabled = false;
}

// Routes the identified device to the right flow - or explains that it is another
// kind than the one chosen, and offers to continue with the right guide (the link
// stays open).
function dispatchDirect() {
  const route = state.route;
  const id = state.identity;
  ui.kindNotice.hidden = true;
  ui.btnReread.hidden = false;
  if (!id || id.kind === "error") {
    flow.showUnknown("Kunne ikke tale med enheden" + (id && id.error ? " (" + id.error + ")" : "") + ". Er kablet stadig i? Prøv Genlæs enheden, eller Afbryd og tilslut igen.");
    return;
  }
  if (id.kind === "unknown") {
    flow.showUnknown(route.transport === "ble"
      ? "Ingen svar over Bluetooth. Blev parringen (PIN) gennemført, og er det en MeshCore-companion? Prøv Genlæs enheden - eller se loggen nederst."
      : "Enheden svarede hverken som repeater (tekst-CLI) eller companion (binær protokol). Er det den rigtige port, er enheden tændt, og kører den MeshCore-firmware? En BLE-companion har ingen USB-kommunikation - den tilsluttes via Bluetooth. Prøv Genlæs enheden - eller se loggen nederst.");
    return;
  }
  if (route.kind === "companion" && id.kind === "companion") { flow.showCompanion(id); return; }
  if (route.kind === "repeater" && id.kind === "cli") { flow.readSettings(); return; }

  // Not what was chosen - guide onwards, keeping the connection.
  hideFlowBody();
  if (id.kind === "cli") {
    showKindNotice("Enheden i den anden ende er en " + roleLabel(id.role).toLowerCase() + " (" + escapeHtml(id.version || "") + "), ikke en companion. Forbindelsen beholdes - fortsæt med repeater-guiden, så læses dens indstillinger nu.",
      [["Fortsæt som repeater", "#/repeater/usb", true]]);
  } else {
    const s = id.selfInfo;
    showKindNotice("Det er en companion" + (s && s.name ? " (" + escapeHtml(s.name) + ")" : "") + ", ikke en repeater. Du kan sætte companionen selv op - eller bruge dens radio til at nå repeateren over mesh'et. Forbindelsen beholdes.",
      [["Sæt companionen op", "#/companion/" + route.transport, true], ["Brug den til at nå repeateren over mesh'et", "#/repeater/remote/" + route.transport, false]]);
  }
}

function hideFlowBody() {
  ui.device.hidden = true;
  ui.location.hidden = true;
  ui.recommend.hidden = true;
}

function showKindNotice(text, actions) {
  ui.kindText.innerHTML = text;
  ui.kindActions.replaceChildren();
  for (const [label, href, primary] of actions) {
    const a = document.createElement("a");
    a.href = href;
    a.className = "social-btn" + (primary ? " editor" : "");
    a.textContent = label;
    ui.kindActions.append(a);
  }
  ui.kindNotice.hidden = false;
  setStatus("Forbundet - men det er en anden slags enhed", "");
}

async function reread() {
  if (!state.link) return;
  if (state.remote) { await flow.readSettings(); return; }
  await identify();
  dispatchDirect();
}

// --- Remote: a companion's radio reaches the repeater -------------------------------

const REMOTE_CHECK = [
  "<strong>Companionen skal have hørt repeateren</strong> - den skal stå i companionens kontaktliste (dens advert er modtaget). Ellers: vent på næste advert, eller tryk på repeaterens knap hvis du er i nærheden, og hent listen igen.",
  "<strong>Repeaterens admin-adgangskode.</strong> Gæste-adgangskoden giver ingen adgang til kommandoer. Adgangskoden sendes krypteret over radioen og gemmes ikke.",
  "<strong>Det tager tid</strong> - hver indstilling er en tur frem og tilbage over LoRa. Tabte pakker prøves 3 gange og springes så over; du kan altid genlæse.",
  "<strong>Radioindstillinger vises kun</strong> - en forkert frekvens, båndbredde eller SF ville afbryde forbindelsen til repeateren. Beskeder i companionens kø hentes undervejs og vises i loggen."
];

function renderRemote(route) {
  ui.remoteIntro.textContent = route.transport === "ble"
    ? "Klik Tilslut og vælg companionen (MeshCore-…) i browserens liste; computeren spørger om dens PIN. Luk appen på telefonen først - companionen har kun én Bluetooth-forbindelse ad gangen."
    : "Sæt companionen i computeren med et USB-kabel med data, og klik Tilslut. Luk flasheren, den serielle monitor og lignende først - kun ét program ad gangen kan holde porten.";
  const check = [...REMOTE_CHECK];
  if (route.transport === "ble") check.unshift("<strong>Chrome eller Edge.</strong> Brave har Web Bluetooth slået fra: indsæt <code>" + BRAVE_BLE_FLAG + "</code><button type=\"button\" class=\"am-copy\" data-copy=\"" + BRAVE_BLE_FLAG + "\">Kopiér</button> i adresselinjen, vælg Enabled og genstart browseren.");
  ui.remoteCheck.innerHTML = check.map(c => "<li>" + c + "</li>").join("");
  ui.btnRemoteConnect.textContent = "Tilslut via " + TRANSPORT_LABEL[route.transport];
  showError(ui.remoteConnectError, "");
  const supported = route.transport === "ble" ? bluetoothSupported() : serialSupported();
  ui.btnRemoteConnect.disabled = !supported;
  showError(ui.remoteNoSupport, supported ? "" : (route.transport === "ble"
    ? "Din browser har ikke Web Bluetooth. Brug Chrome eller Edge på en computer (i Brave: slå det til under " + BRAVE_BLE_FLAG + ")."
    : "Din browser har ikke Web Serial. Brug Chrome, Edge eller Brave på en computer."));
  flow.setMode("remote");
  flow.setLink(null);
  flow.reset();
  if (state.link && state.link.kind === route.transport && state.identity && state.identity.kind === "companion") {
    // Arrived from a notice on the direct page with an open companion link.
    ui.btnRemoteConnect.hidden = true;
    setConnectedLook(true);
    ui.logSection.hidden = false;
    afterCompanionConnected();
  } else {
    ui.btnRemoteConnect.hidden = false;
    ui.companionInfo.hidden = true;
    setRemoteStatus("Ikke forbundet", "");
  }
}

async function connectRemote() {
  const route = state.route;
  ui.btnRemoteConnect.disabled = true;
  ui.logSection.hidden = false;
  const link = await openLink(route.transport, ui.remoteConnectError, setRemoteStatus);
  if (!link) { ui.btnRemoteConnect.disabled = false; return; }
  state.link = link;
  ui.btnRemoteConnect.hidden = true;
  setConnectedLook(true);
  ui.runbar.hidden = false;
  ui.btnReread.hidden = true;
  setRemoteStatus("Identificerer firmware …", "busy");
  setProgress(ui.remoteProgress, { text: "Spørger enheden hvilken firmware den kører …" });
  try {
    state.identity = await link.identify();
  } catch (e) {
    state.identity = { kind: "error", error: e && e.message ? e.message : String(e) };
  }
  setProgress(ui.remoteProgress, null);
  const id = state.identity;
  if (id.kind === "cli") {
    setRemoteStatus("Det er ikke en companion", "error");
    showKindNotice("Enheden i kablet er en " + roleLabel(id.role).toLowerCase() + ", ikke en companion. Den kan sættes op direkte - forbindelsen beholdes.", [["Sæt den op direkte via USB", "#/repeater/usb", true]]);
    return;
  }
  if (id.kind !== "companion") {
    setRemoteStatus("Forbundet, men enheden svarer ikke", "error");
    showError(ui.remoteConnectError, route.transport === "ble"
      ? "Ingen svar over Bluetooth. Blev parringen (PIN) gennemført, og er det en MeshCore-companion? Afbryd og prøv igen - eller se loggen nederst."
      : "Enheden svarede hverken som companion eller repeater. Er det den rigtige port, er enheden tændt, og kører den MeshCore-firmware? En BLE-companion har ingen USB-kommunikation.");
    return;
  }
  const set = await link.companionSetTime();
  log("info", set ? "companionens ur sat til computerens tid" : "companionens ur er foran computerens - det beholdes (firmwaren stiller kun uret frem)");
  afterCompanionConnected();
}

async function afterCompanionConnected() {
  const link = state.link, id = state.identity;
  const s = id.selfInfo, d = id.deviceInfo;
  setRemoteStatus("Companion forbundet" + (link.kind === "ble" ? " via Bluetooth" : "") + (s && s.name ? ": " + s.name : ""), "connected");
  setStatus("Companion forbundet - vælg repeateren og log ind", "");
  ui.companionInfo.textContent = "Companion: " + (s && s.name ? s.name : "(uden navn)") + (d ? " · " + d.board + " · " + (d.firmwareVersion || "") : "")
    + (s && s.radio ? " · radio " + formatRadio(s.radio) : "") + ". Repeateren skal køre de samme radioindstillinger for at kunne nås.";
  ui.companionInfo.hidden = false;
  ui.runbar.hidden = false;
  ui.contacts.hidden = false;
  await picker.start(); // contact list (for names), then a discovery
}

async function login() {
  if (!state.link || !state.contact) return;
  const password = ui.password.value;
  showError(ui.loginError, "");
  if (!password) { showError(ui.loginError, "Skriv repeaterens admin-adgangskode."); return; }
  endLogin();
  ui.btnLogin.disabled = true;
  ui.password.disabled = true;
  setStatus("Logger ind på " + (state.contact.name || "repeateren") + " over mesh'et …", "busy");
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
    setStatus("Ikke logget ind", "error");
    showError(ui.loginError, res.reason === "password"
      ? "Repeateren afviste adgangskoden."
      : res.reason === "timeout"
        ? "Intet svar fra repeateren efter 3 forsøg. Er den tændt og inden for rækkevidde af companionen (samme radioindstillinger)? Prøv igen om lidt."
        : "Login mislykkedes: " + res.reason);
    return;
  }
  if (!res.isAdmin) {
    setStatus("Logget ind som gæst - ikke nok", "error");
    showError(ui.loginError, "Repeateren accepterede adgangskoden, men kun som gæst (det var gæste-adgangskoden). Kommandoer over mesh kræver admin-adgangskoden.");
    return;
  }
  state.remote = remote;
  ui.password.value = "";
  ui.btnReread.hidden = false;
  flow.setMode("remote");
  flow.setLink(remote);
  setStatus("Logget ind på " + (state.contact.name || "repeateren") + " - læser indstillinger …", "busy");
  await flow.readSettings();
}

// Forgets the remote login and clears everything read through it.
function endLogin() {
  if (state.remote) state.remote.disconnect();
  state.remote = null;
  flow.setLink(null);
  flow.reset();
  ui.btnReread.hidden = true;
}

// --- Shared ---------------------------------------------------------------------------

async function disconnect() {
  endLogin();
  if (state.link) await state.link.disconnect();
  state.link = null;
  state.identity = null;
  state.contact = null;
  picker.reset();
  flow.setLink(null);
  flow.reset();
  setConnectedLook(false);
  ui.btnConnect.hidden = false;
  ui.btnConnect.disabled = false;
  ui.btnRemoteConnect.hidden = false;
  ui.btnRemoteConnect.disabled = false;
  ui.companionInfo.hidden = true;
  ui.contacts.hidden = true;
  ui.login.hidden = true;
  ui.kindNotice.hidden = true;
  ui.runbar.hidden = true;
  ui.btnReread.hidden = true;
  ui.connectHint.textContent = "";
  setStatus("Ikke forbundet", "");
  setRemoteStatus("Ikke forbundet", "");
}

// --- Defaults: the map and the recommended settings --------------------------------

let defaultsInit = false;
let defaultsMapObj = null;

function cliBlock(label, text) {
  return '<div class="cli-block"><span class="cli-label">' + escapeHtml(label) + '</span><pre><code>' + escapeHtml(text) + '</code></pre></div>';
}

async function renderDefaults() {
  if (defaultsInit) { if (defaultsMapObj) defaultsMapObj.invalidateSize(); return; } // shown again after being hidden
  defaultsInit = true;
  // The front page shows one concrete flood.advert.interval, picked from the
  // recommended range, so people spread out instead of all copying the same number.
  const [lo, hi] = BEST_PRACTICE.floodAdvertInterval;
  const floodInterval = lo + Math.floor(Math.random() * (hi - lo + 1));
  for (const el of document.querySelectorAll(".floodAdvertInterval")) el.textContent = floodInterval;
  if (typeof L === "undefined") return;
  const datasetPromise = loadDataset();
  const map = L.map(ui.defaultsMap, { center: [56.0, 11.0], zoom: 7, minZoom: 6, maxZoom: 19, worldCopyJump: false }); // maxZoom: see lib/flow.js initMap
  defaultsMapObj = map;
  L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/dark",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragydere &copy; <a href="https://openfreemap.org/">OpenFreeMap</a>'
  }).addTo(map);

  // City markers (chat rooms).
  try {
    const cities = await fetchJSON(new URL("cities.json", import.meta.url));
    const layer = L.layerGroup();
    for (const [key, c] of Object.entries(cities)) {
      if (!c.geometry || c.geometry.type !== "Point") continue;
      const [lng, lat] = c.geometry.coordinates;
      const marker = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="mcdk-city-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }), keyboard: true, title: c.name });
      marker.bindPopup('<div class="mcdk-city-popup-body"><h4>' + escapeHtml(c.name) + "</h4><dl><dt>Chat</dt><dd><code>" + escapeHtml(c.localChat) + "</code></dd>" + (c.scope ? "<dt>Scope</dt><dd><code>" + escapeHtml(c.scope) + "</code></dd>" : "") + "</dl></div>", { className: "mcdk-city-popup" });
      marker.on("click", e => L.DomEvent.stopPropagation(e));
      layer.addLayer(marker);
      void key;
    }
    const sync = () => { if (map.getZoom() >= 7) { if (!map.hasLayer(layer)) layer.addTo(map); } else if (map.hasLayer(layer)) map.removeLayer(layer); };
    map.on("zoomend", sync);
    sync();
  } catch (e) {
    console.error(e);
  }

  let marker = null, highlight = null, seq = 0;
  map.on("click", async e => {
    const mySeq = ++seq;
    if (marker) marker.setLatLng(e.latlng);
    else marker = L.circleMarker(e.latlng, { radius: 4, color: "#0a1830", weight: 1, fillColor: "#ffffff", fillOpacity: 1, interactive: false, pane: "markerPane" }).addTo(map);
    const ds = await datasetPromise;
    if (mySeq !== seq) return;
    const res = scopesForPoint(ds, e.latlng.lat, e.latlng.lng);
    if (highlight) { map.removeLayer(highlight); highlight = null; }
    if (!res.hits.length) {
      ui.defaultsCli.hidden = true;
      ui.defaultsCliTitle.hidden = true;
      ui.defaultsGps.hidden = true;
      ui.defaultsHint.hidden = false;
      return;
    }
    highlight = L.geoJSON(res.features, { interactive: false, style: { className: "mcdk-region", color: "#ffffff", weight: 1.25, fillColor: "#ffffff", fillOpacity: 0.1, opacity: 1 } }).addTo(map);
    ui.defaultsCli.innerHTML =
      cliBlock("Firmware 1.16.0+", res.cli.firmware_1_16_0_plus) +
      cliBlock("Firmware 1.12.0 - 1.15.0", res.cli.firmware_1_12_0_to_1_15_0);
    ui.defaultsCli.hidden = false;
    ui.defaultsCliTitle.hidden = false;
    ui.defaultsGpsCoords.textContent = "set lat " + e.latlng.lat.toFixed(7) + "\nset lon " + e.latlng.lng.toFixed(7) + "\ngps advert prefs";
    ui.defaultsGps.hidden = false;
    ui.defaultsHint.hidden = true;
  });
}

// --- Wire up ----------------------------------------------------------------------------

ui.btnConnect.addEventListener("click", connectDirect);
ui.btnRemoteConnect.addEventListener("click", connectRemote);
ui.btnDisconnect.addEventListener("click", async () => { await disconnect(); render(); });
ui.btnReread.addEventListener("click", reread);
ui.btnLogin.addEventListener("click", login);
ui.password.addEventListener("keydown", e => { if (e.key === "Enter") login(); });
installCopyButtons();
window.addEventListener("hashchange", render);
render();
