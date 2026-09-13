// automagical.js - UI for the Web Serial repeater configurator (proof of concept).
//
// Flow: connect over USB -> read the device's settings -> find its position
// (from the device, or by clicking on the map) -> compare with best practice
// (checks.js) -> apply the selected changes.

import { buildDataset, scopesForPoint } from "../scopes.js";
import { MeshCoreSerial, serialSupported } from "./serial.js";
import { READ_COMMANDS, evaluate, hasDeviceLocation, needsReboot, parseState, planCommands } from "./checks.js";

const $ = id => document.getElementById(id);
const HIGHLIGHT_COLOR = "#ffffff";

const ui = {
  status: $("status"), btnConnect: $("btnConnect"), btnDisconnect: $("btnDisconnect"), btnReread: $("btnReread"),
  connectError: $("connectError"), device: $("device"), deviceError: $("deviceError"), deviceTable: $("deviceTable"), regionTree: $("regionTree"),
  location: $("location"), locationText: $("locationText"), mapHint: $("mapHint"), btnPick: $("btnPick"), btnUseDevice: $("btnUseDevice"), scopesText: $("scopesText"),
  recommend: $("recommend"), findings: $("findings"), plan: $("plan"), btnApply: $("btnApply"), btnReboot: $("btnReboot"), applyStatus: $("applyStatus"), applyLog: $("applyLog"), rebootNote: $("rebootNote"),
  serialLog: $("serialLog")
};

const app = {
  serial: null,
  replies: null,     // raw replies keyed like READ_COMMANDS
  state: null,       // parseState(replies)
  location: null,    // { lat, lon, source: "device" | "map" }
  scopes: null,      // scopesForPoint() for the location
  findings: [],
  selected: new Set(),   // finding ids that will be applied
  deselected: new Set(), // finding ids the user unticked (kept across re-renders)
  input: { ownerInfo: "" },
  pickMode: false,
  dataset: null,
  map: null, marker: null, highlight: null
};

// --- Log ---------------------------------------------------------------------

function log(kind, text) {
  const el = document.createElement("div");
  el.className = kind;
  el.textContent = (kind === "tx" ? "> " : kind === "rx" ? "< " : "· ") + text;
  ui.serialLog.appendChild(el);
  while (ui.serialLog.childElementCount > 500) ui.serialLog.removeChild(ui.serialLog.firstChild);
  ui.serialLog.scrollTop = ui.serialLog.scrollHeight;
}

function setStatus(text, cls) {
  ui.status.textContent = text;
  ui.status.className = "am-status" + (cls ? " " + cls : "");
}

function showError(el, msg) {
  el.textContent = msg || "";
  el.hidden = !msg;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// --- Data ----------------------------------------------------------------------

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Kunne ikke hente " + url + ": " + r.status);
  return r.json();
}

async function loadDataset() {
  const regions = await fetchJSON("../regions.json");
  const manifest = await fetchJSON("../postnumre/index.json");
  const files = [];
  for (const f of manifest.files || []) files.push(await fetchJSON("../postnumre/" + f.file));
  return buildDataset(regions, files);
}
const datasetPromise = loadDataset();

// --- Map -----------------------------------------------------------------------

function initMap() {
  if (app.map || typeof L === "undefined") return;
  const map = L.map($("map"), { center: [56.0, 11.0], zoom: 7, minZoom: 6, maxZoom: 14, worldCopyJump: false });
  L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/dark",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragydere &copy; <a href="https://openfreemap.org/">OpenFreeMap</a>'
  }).addTo(map);
  map.on("click", e => {
    if (!app.pickMode && app.location && app.location.source === "device") return; // device position is authoritative until the user asks to change it
    setLocation(e.latlng.lat, e.latlng.lng, "map");
  });
  app.map = map;
}

function drawLocation() {
  const map = app.map;
  if (!map) return;
  if (app.highlight) { map.removeLayer(app.highlight); app.highlight = null; }
  if (app.marker) { map.removeLayer(app.marker); app.marker = null; }
  if (!app.location) return;
  const ll = [app.location.lat, app.location.lon];
  app.marker = L.circleMarker(ll, { radius: 5, color: "#0a1830", weight: 1, fillColor: app.location.source === "device" ? "#3fb950" : "#ffffff", fillOpacity: 1, interactive: false, pane: "markerPane" }).addTo(map);
  if (app.scopes && app.scopes.features.features.length) {
    app.highlight = L.geoJSON(app.scopes.features, {
      interactive: false,
      style: { className: "mcdk-region", color: HIGHLIGHT_COLOR, weight: 1.25, fillColor: HIGHLIGHT_COLOR, fillOpacity: 0.1, opacity: 1 }
    }).addTo(map);
  }
  if (map.getZoom() < 9) map.setView(ll, 9); else map.panTo(ll);
}

async function setLocation(lat, lon, source) {
  app.location = { lat, lon, source };
  app.pickMode = false;
  ui.mapHint.hidden = true;
  const ds = await datasetPromise;
  app.scopes = scopesForPoint(ds, lat, lon);
  ui.locationText.textContent = source === "device"
    ? `Repeateren har position ${lat}, ${lon} gemt. Klik "Vælg en anden position" hvis den er forkert.`
    : `Valgt position: ${lat.toFixed(6)}, ${lon.toFixed(6)} (sættes på enheden når du anvender anbefalingerne).`;
  ui.scopesText.textContent = app.scopes.scopes.length
    ? "Scopes: " + app.scopes.scopes.join(", ")
    : "Positionen ligger uden for alle kendte regioner - ingen scopes kan udledes.";
  ui.btnUseDevice.hidden = !(source === "map" && app.state && hasDeviceLocation(app.state));
  drawLocation();
  renderFindings();
}

// --- Device ----------------------------------------------------------------------

async function connect() {
  showError(ui.connectError, "");
  ui.btnConnect.disabled = true;
  setStatus("Forbinder …", "busy");
  const serial = new MeshCoreSerial({ onLog: log });
  try {
    await serial.connect();
  } catch (e) {
    ui.btnConnect.disabled = false;
    setStatus("Ikke forbundet", "");
    if (e && e.name === "NotFoundError") return; // user cancelled the port chooser
    showError(ui.connectError, "Kunne ikke åbne porten: " + (e && e.message ? e.message : e));
    return;
  }
  app.serial = serial;
  ui.btnConnect.hidden = true;
  ui.btnDisconnect.hidden = false;
  ui.btnReread.hidden = false;
  setStatus("Forbundet", "connected");
  await readDevice();
}

async function disconnect() {
  if (app.serial) await app.serial.disconnect();
  app.serial = null;
  ui.btnConnect.hidden = false;
  ui.btnConnect.disabled = false;
  ui.btnDisconnect.hidden = true;
  ui.btnReread.hidden = true;
  setStatus("Ikke forbundet", "");
}

async function readDevice() {
  const serial = app.serial;
  if (!serial) return;
  setStatus("Læser indstillinger …", "busy");
  ui.btnReread.disabled = true;
  showError(ui.deviceError, "");
  const replies = {};
  // Wake the CLI: a stray partial line on the device would otherwise swallow our first command.
  await serial.command("", { timeoutMs: 600 });
  for (const [key, cmd] of Object.entries(READ_COMMANDS)) {
    const r = await serial.command(cmd);
    if (r.value !== null) replies[key] = r.value;              // "get" style reply
    else if (r.ok && r.reply !== null) replies[key] = r.reply; // ver / board / region ...
    else replies[key] = null;                                  // unknown command or no reply
  }
  app.replies = replies;
  app.state = parseState(replies);
  ui.btnReread.disabled = false;

  if (!replies.ver && !replies.role) {
    setStatus("Forbundet, men enheden svarer ikke", "error");
    showError(ui.deviceError, "Enheden svarede ikke på CLI-kommandoer. Er det en repeater (ikke en companion), og er den tændt? Se den serielle log nederst.");
    ui.device.hidden = false;
    renderDevice();
    return;
  }
  setStatus("Forbundet: " + (app.state.name || "(uden navn)") + " · " + (app.state.board || "") + " · " + (app.state.version ? app.state.version.text : ""), "connected");
  ui.device.hidden = false;
  renderDevice();

  ui.location.hidden = false;
  initMap();
  if (hasDeviceLocation(app.state)) {
    await setLocation(app.state.lat, app.state.lon, "device");
  } else {
    app.location = null;
    app.scopes = null;
    app.pickMode = true;
    ui.mapHint.hidden = false;
    ui.locationText.textContent = "Repeateren har ingen position gemt. Klik på kortet hvor den står.";
    ui.scopesText.textContent = "";
    drawLocation();
    renderFindings();
  }
  ui.recommend.hidden = false;
  ui.recommend.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderDevice() {
  const s = app.state;
  const rows = [
    ["Board", s.board],
    ["Firmware", s.version ? s.version.text + (s.version.build ? " (build " + s.version.build + ")" : "") : null],
    ["Rolle", s.role],
    ["Navn", s.name],
    ["Public key", s.publicKey ? "<code>" + escapeHtml(s.publicKey) + "</code>" : null],
    ["Radio", s.radio ? s.radio.text : null],
    ["TX-effekt", s.txPower !== null ? s.txPower + " dBm" : null],
    ["Position", hasDeviceLocation(s) ? s.lat + ", " + s.lon : "ikke sat"],
    ["Position i adverts", s.gpsAdvert === null ? "(firmware uden GPS-understøttelse)" : s.gpsAdvert],
    ["region default", s.regionDefault],
    ["owner.info", s.ownerInfo]
  ];
  ui.deviceTable.innerHTML = rows.map(([k, v]) =>
    "<tr><th>" + escapeHtml(k) + "</th><td>" + (v === null || v === undefined || v === "" ? '<span class="muted">–</span>' : (k === "Public key" ? v : escapeHtml(v))) + "</td></tr>"
  ).join("");
  ui.regionTree.textContent = s.regionTree || "(kunne ikke aflæses)";
}

// --- Findings --------------------------------------------------------------------

function renderFindings() {
  if (!app.state) return;
  app.findings = evaluate(app.state, app.location, app.scopes, app.input);
  // Keep the user's (de)selections across re-renders; new "change" findings start selected.
  const known = new Set(app.findings.map(f => f.id));
  for (const id of [...app.selected]) if (!known.has(id)) app.selected.delete(id);
  for (const f of app.findings) {
    if (f.status === "change" && !app.deselected.has(f.id)) app.selected.add(f.id);
    if (f.status !== "change") app.selected.delete(f.id);
  }
  const STATUS = { ok: "OK", change: "Ændres", input: "Mangler input", unknown: "Kunne ikke aflæses", unsupported: "Ikke understøttet" };
  ui.findings.innerHTML = app.findings.map(f => {
    const cb = f.status === "change"
      ? `<input type="checkbox" data-id="${f.id}" ${app.selected.has(f.id) ? "checked" : ""} aria-label="Anvend ${escapeHtml(f.label)}">`
      : "";
    let recommended = escapeHtml(f.recommended);
    if (f.id === "owner.info" && (f.status === "input" || f.status === "change")) {
      recommended = `<input type="text" id="ownerInfoInput" maxlength="120" placeholder="fx OZ1ABC / 6dBi omni @9m / Solar+Batt / Tagmontering" value="${escapeHtml(app.input.ownerInfo)}">`;
    }
    const note = f.note ? `<div class="note">${escapeHtml(f.note)}</div>` : "";
    return `<tr class="${f.status}"><td>${cb}</td><td>${escapeHtml(f.label)}${note}</td><td><code>${escapeHtml(f.current)}</code></td><td>${recommended}</td><td class="status ${f.status}">${STATUS[f.status]}</td></tr>`;
  }).join("");
  for (const cb of ui.findings.querySelectorAll("input[type=checkbox]")) {
    cb.addEventListener("change", () => {
      if (cb.checked) { app.selected.add(cb.dataset.id); app.deselected.delete(cb.dataset.id); }
      else { app.selected.delete(cb.dataset.id); app.deselected.add(cb.dataset.id); }
      renderPlan();
    });
  }
  const oi = $("ownerInfoInput");
  if (oi) oi.addEventListener("change", () => { app.input.ownerInfo = oi.value; renderFindings(); });
  renderPlan();
}

function renderPlan() {
  const cmds = planCommands(app.findings, app.selected);
  ui.plan.textContent = cmds.length ? cmds.join("\n") : "(ingen ændringer valgt)";
  ui.btnApply.disabled = !cmds.length || !app.serial;
}

async function apply() {
  const serial = app.serial;
  if (!serial) return;
  const cmds = planCommands(app.findings, app.selected);
  if (!cmds.length) return;
  ui.btnApply.disabled = true;
  ui.applyLog.innerHTML = "";
  ui.applyStatus.textContent = "Sender …";
  let failed = 0;
  for (const cmd of cmds) {
    const r = await serial.command(cmd, { timeoutMs: 4000 });
    const li = document.createElement("li");
    const ok = r.ok || (r.reply !== null && cmd.startsWith("region def"));
    li.className = ok ? "ok" : "err";
    li.textContent = cmd + "  →  " + (r.reply === null ? "(intet svar)" : r.reply.split("\n")[0]);
    ui.applyLog.appendChild(li);
    if (!ok) failed++;
  }
  ui.applyStatus.textContent = failed ? `${failed} af ${cmds.length} kommandoer fejlede - se listen.` : "Alle ændringer anvendt.";
  if (needsReboot(cmds)) {
    ui.rebootNote.hidden = false;
    ui.btnReboot.hidden = false;
  }
  await readDevice();
}

async function reboot() {
  if (!app.serial) return;
  ui.btnReboot.disabled = true;
  await app.serial.command("reboot", { timeoutMs: 1000 });
  await disconnect();
  ui.btnReboot.hidden = true;
  ui.btnReboot.disabled = false;
  ui.rebootNote.hidden = true;
  setStatus("Repeateren genstarter - tilslut igen om et øjeblik", "");
}

// --- Wire up -----------------------------------------------------------------------

if (!serialSupported()) {
  $("noSerial").hidden = false;
  ui.btnConnect.disabled = true;
}
ui.btnConnect.addEventListener("click", connect);
ui.btnDisconnect.addEventListener("click", disconnect);
ui.btnReread.addEventListener("click", readDevice);
ui.btnPick.addEventListener("click", () => { app.pickMode = true; ui.mapHint.hidden = false; ui.locationText.textContent = "Klik på kortet hvor repeateren står."; });
ui.btnUseDevice.addEventListener("click", () => { if (app.state && hasDeviceLocation(app.state)) setLocation(app.state.lat, app.state.lon, "device"); });
ui.btnApply.addEventListener("click", apply);
ui.btnReboot.addEventListener("click", reboot);
