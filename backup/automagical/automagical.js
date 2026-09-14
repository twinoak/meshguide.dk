// automagical.js - UI for the Web Serial repeater configurator (proof of concept).
//
// Flow: connect over USB -> read the device's settings -> find its position
// (from the device, or by clicking on the map) -> compare with best practice
// (checks.js) -> apply the selected changes.

import { buildDataset, scopesForPoint } from "../scopes.js";
import { MeshCoreSerial, serialSupported } from "./serial.js";
import { BEST_PRACTICE, READ_COMMANDS, commandText, evaluate, evaluateCompanion, forwards, hasDeviceLocation, isRepeater, needsReboot, parseState, planCommands, roleLabel, scopeKeyFor } from "./checks.js";

const $ = id => document.getElementById(id);
const HIGHLIGHT_COLOR = "#ffffff";

const ui = {
  status: $("status"), btnConnect: $("btnConnect"), btnDisconnect: $("btnDisconnect"), btnReread: $("btnReread"),
  connectError: $("connectError"), device: $("device"), deviceError: $("deviceError"), deviceNote: $("deviceNote"), deviceTable: $("deviceTable"),
  location: $("location"), locationText: $("locationText"), mapHint: $("mapHint"), btnPick: $("btnPick"), btnUseDevice: $("btnUseDevice"), scopesText: $("scopesText"),
  recommend: $("recommend"), findings: $("findings"), plan: $("plan"), btnApply: $("btnApply"), btnReboot: $("btnReboot"), applyStatus: $("applyStatus"), applyLog: $("applyLog"), rebootNote: $("rebootNote"),
  serialLog: $("serialLog"),
  readProgress: $("readProgress"), applyProgress: $("applyProgress")
};

// Progress bar: null hides it; { text } alone is indeterminate; { done, total, text } is a real fraction.
function setProgress(el, state) {
  const bar = el.querySelector(".am-bar"), fill = el.querySelector(".am-bar-fill"), text = el.querySelector(".text");
  if (!state) { el.hidden = true; bar.classList.remove("indeterminate"); fill.style.width = "0"; text.textContent = ""; return; }
  el.hidden = false;
  if (state.total) {
    bar.classList.remove("indeterminate");
    fill.style.width = Math.round(100 * state.done / state.total) + "%";
    text.textContent = (state.text ? state.text + " " : "") + state.done + "/" + state.total;
  } else {
    bar.classList.add("indeterminate");
    fill.style.width = "";
    text.textContent = state.text || "";
  }
}

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
    ? `Enheden har position ${lat}, ${lon} gemt. Klik "Vælg en anden position" hvis den er forkert.`
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
  try {
    await readDeviceSteps();
  } catch (e) {
    console.error(e);
    setProgress(ui.readProgress, null);
    ui.btnReread.disabled = false;
    setStatus("Fejl under læsning: " + (e && e.message ? e.message : e), "error");
    showError(ui.deviceError, "Læsningen blev afbrudt (" + (e && e.message ? e.message : e) + "). Er kablet stadig i? Prøv Genlæs enheden, eller Afbryd og tilslut igen.");
  }
}

async function readDeviceSteps() {
  const serial = app.serial;
  if (!serial) return;
  setStatus("Identificerer firmware …", "busy");
  setProgress(ui.readProgress, { text: "Spørger enheden hvilken firmware den kører …" });
  ui.btnReread.disabled = true;
  showError(ui.deviceError, "");
  showError(ui.deviceNote, "");
  ui.location.hidden = true;
  ui.recommend.hidden = true;
  ui.device.hidden = false;

  // Which firmware is this? Text CLI (repeater/room/sensor) or the companion's binary protocol?
  const id = await serial.identify();
  app.identity = id;
  if (id.kind === "companion") {
    setStatus("Læser companion-indstillinger …", "busy");
    setProgress(ui.readProgress, { text: "Læser standard-scope …" });
    id.defaultScope = await serial.companionGetDefaultScope();
    setProgress(ui.readProgress, null);
    app.companion = id;
    app.state = null;
    ui.btnReread.disabled = false;
    renderCompanion(id);
    const s = id.selfInfo;
    setStatus("Forbundet: companion" + (s && s.name ? " · " + s.name : "") + (id.deviceInfo ? " · " + id.deviceInfo.board + " · " + (id.deviceInfo.firmwareVersion || "") : ""), "connected");
    showError(ui.deviceNote, "Dette er companion-firmware (den der bruges sammen med appen). Den har ingen CLI, så repeater-opsætningen gælder ikke - men de to indstillinger der betyder noget for det danske mesh, path.hash.mode og standard-scope (#dk), kan tjekkes og rettes herunder.");
    if (!app.expectedScopeKey) app.expectedScopeKey = await scopeKeyFor(BEST_PRACTICE.regionDefault);
    ui.recommend.hidden = false;
    renderFindings();
    return;
  }
  if (id.kind === "unknown") {
    setProgress(ui.readProgress, null);
    ui.btnReread.disabled = false;
    ui.deviceTable.innerHTML = "";
    setStatus("Forbundet, men enheden svarer ikke", "error");
    showError(ui.deviceError, "Enheden svarede hverken som repeater (tekst-CLI) eller companion (binær protokol). Er det den rigtige port, er enheden tændt, og kører den MeshCore-firmware? Prøv Genlæs enheden - eller se den serielle log nederst.");
    return;
  }

  app.companion = null;
  const entries = Object.entries(READ_COMMANDS);
  const replies = {};
  for (const [i, [key, cmd]] of entries.entries()) {
    setStatus("Læser indstillinger … (" + (i + 1) + "/" + entries.length + ")", "busy");
    setProgress(ui.readProgress, { done: i, total: entries.length, text: cmd });
    const r = await serial.command(cmd);
    if (r.value !== null) replies[key] = r.value;              // "get" style reply
    else if (r.ok && r.reply !== null) replies[key] = r.reply; // ver / board / region ...
    else replies[key] = null;                                  // unknown command or no reply
  }
  app.replies = replies;
  app.state = parseState(replies);
  setProgress(ui.readProgress, null);
  ui.btnReread.disabled = false;

  setStatus("Forbundet: " + roleLabel(app.state.role) + " · " + (app.state.name || "(uden navn)") + " · " + (app.state.board || "") + " · " + (app.state.version ? app.state.version.text : ""), "connected");
  renderDevice();
  if (app.state.role === "room_server") {
    showError(ui.deviceNote, "Room server: anbefalingerne er tilpasset - rummets adgangskode (guest.password) røres ikke, og reglerne for videresendelse (loop.detect, flood.max.unscoped) gælder kun hvis repeat er slået til" + (forwards(app.state) ? " (det er den)." : " (det er den ikke)."));
  } else if (app.state.role && !isRepeater(app.state)) {
    showError(ui.deviceNote, "Enheden melder sig som \"" + app.state.role + "\". Anbefalingerne herunder er lavet til repeatere og room servers - brug dem med omtanke.");
  }

  ui.location.hidden = false;
  initMap();
  if (hasDeviceLocation(app.state)) {
    await setLocation(app.state.lat, app.state.lon, "device");
  } else {
    app.location = null;
    app.scopes = null;
    app.pickMode = true;
    ui.mapHint.hidden = false;
    ui.locationText.textContent = "Enheden har ingen position gemt. Klik på kortet hvor den står.";
    ui.scopesText.textContent = "";
    drawLocation();
    renderFindings();
  }
  ui.recommend.hidden = false;
  ui.recommend.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderRows(rows) {
  ui.deviceTable.innerHTML = rows.map(([k, v, raw]) =>
    "<tr><th>" + escapeHtml(k) + "</th><td>" + (v === null || v === undefined || v === "" ? '<span class="muted">–</span>' : (raw ? v : escapeHtml(v))) + "</td></tr>"
  ).join("");
}

function renderCompanion(id) {
  const d = id.deviceInfo, s = id.selfInfo;
  // Only what the recommendations below do not already show.
  renderRows([
    ["Firmware", "Companion" + (d && d.firmwareVersion ? " " + d.firmwareVersion : "") + (d && d.buildDate ? " (build " + d.buildDate + ")" : "")],
    ["Board", d ? d.board : null],
    ["Type", s ? s.type : null],
    ["Navn", s ? s.name : null],
    ["Public key", s ? "<code>" + escapeHtml(s.publicKey) + "</code>" : null, true],
    ["Position", s && (s.lat || s.lon) ? s.lat + ", " + s.lon : "ikke sat"]
  ]);
}

function renderDevice() {
  const s = app.state;
  // Only what the recommendations below do not already show.
  renderRows([
    ["Firmware", s.version ? roleLabel(s.role) + " " + s.version.text + (s.version.build ? " (build " + s.version.build + ")" : "") : null],
    ["Board", s.board],
    ["Rolle", roleLabel(s.role)],
    ["Navn", s.name],
    ["Public key", s.publicKey ? "<code>" + escapeHtml(s.publicKey) + "</code>" : null, true],
    ["Position", hasDeviceLocation(s) ? s.lat + ", " + s.lon : "ikke sat"],
    ...(s.role === "room_server" ? [["Rummets adgangskode (guest.password)", s.guestPassword]] : [])
  ]);
}

// --- Findings --------------------------------------------------------------------

function renderFindings() {
  if (app.companion) app.findings = evaluateCompanion(app.companion, app.expectedScopeKey);
  else if (app.state) app.findings = evaluate(app.state, app.location, app.scopes, app.input);
  else return;
  // Keep the user's (de)selections across re-renders; new "change" findings start selected.
  const known = new Set(app.findings.map(f => f.id));
  for (const id of [...app.selected]) if (!known.has(id)) app.selected.delete(id);
  for (const f of app.findings) {
    if (f.status !== "change") { app.selected.delete(f.id); continue; }
    if (f.optIn) continue;                                   // opt-in rows are only applied if the user ticks them
    if (!app.deselected.has(f.id)) app.selected.add(f.id);
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
  ui.plan.textContent = cmds.length ? cmds.map(commandText).join("\n") : "(ingen ændringer valgt)";
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
  try {
    for (const [i, cmd] of cmds.entries()) {
      setProgress(ui.applyProgress, { done: i, total: cmds.length, text: commandText(cmd) });
      let ok, reply;
      if (typeof cmd === "string") {
        const r = await serial.command(cmd, { timeoutMs: 4000 });
        ok = r.ok || (r.reply !== null && cmd.startsWith("region def"));
        reply = r.reply === null ? "(intet svar)" : r.reply.split("\n")[0];
      } else if (cmd.remove) {
        const res = await removeRegions(serial, cmd.remove);
        ok = res.ok;
        reply = (res.removed.length ? "fjernet: " + res.removed.join(", ") : "intet fjernet")
          + (Object.keys(res.errors).length ? " · fejl: " + Object.entries(res.errors).map(([n, e]) => n + " (" + e + ")").join(", ") : "");
      } else {
        ok = await serial.companionSet(cmd.payload, cmd.text);
        reply = ok ? "OK" : "fejl (se seriel log)";
      }
      const li = document.createElement("li");
      li.className = ok ? "ok" : "err";
      li.textContent = commandText(cmd) + "  →  " + reply;
      ui.applyLog.appendChild(li);
      if (!ok) failed++;
    }
  } catch (e) {
    console.error(e);
    setProgress(ui.applyProgress, null);
    ui.btnApply.disabled = false;
    ui.applyStatus.textContent = "Afbrudt: " + (e && e.message ? e.message : e);
    return;
  }
  setProgress(ui.applyProgress, null);
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
  setStatus("Enheden genstarter - tilslut igen om et øjeblik", "");
}

// Removes regions in dependency order without knowing the tree: a region that
// still has children answers "Err - not empty" and is retried after the others;
// the loop stops when a pass removes nothing.
async function removeRegions(serial, names) {
  let pending = [...names];
  const removed = [];
  const errors = {};
  while (pending.length) {
    const again = [];
    for (const name of pending) {
      const r = await serial.command("region remove " + name, { timeoutMs: 4000 });
      if (r.ok) removed.push(name);
      else if (/not empty/i.test(r.reply || "")) again.push(name);
      else errors[name] = r.reply || "intet svar";
    }
    if (again.length === pending.length) {
      for (const n of again) errors[n] = "har stadig underregioner";
      break;
    }
    pending = again;
  }
  return { ok: Object.keys(errors).length === 0, removed, errors };
}

// --- Wire up -----------------------------------------------------------------------

if (!serialSupported()) {
  $("noSerial").hidden = false;
  ui.btnConnect.disabled = true;
}
ui.btnConnect.addEventListener("click", connect);
ui.btnDisconnect.addEventListener("click", disconnect);
ui.btnReread.addEventListener("click", readDevice);
ui.btnPick.addEventListener("click", () => { app.pickMode = true; ui.mapHint.hidden = false; ui.locationText.textContent = "Klik på kortet hvor enheden står."; });
ui.btnUseDevice.addEventListener("click", () => { if (app.state && hasDeviceLocation(app.state)) setLocation(app.state.lat, app.state.lon, "device"); });
ui.btnApply.addEventListener("click", apply);
ui.btnReboot.addEventListener("click", reboot);
