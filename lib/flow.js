// flow.js - the part of the configurator that does not care how the repeater
// is reached: read its settings -> find its position (from the device, or by a
// click on the map) -> compare with best practice (checks.js) -> apply the
// selected changes. app.js drives it over a direct link (USB / Bluetooth) or
// over a companion's radio (remote-cli.js). A link is anything with
// command(cmd, opts) returning the shape of MeshCoreSerial.command().

import { buildDataset, scopesForPoint } from "./scopes.js";
import { BEST_PRACTICE, DEFAULTS_ANCHOR, NAME_MAX_BYTES, OWNER_INFO_EXAMPLE, PASSWORD_MAX_BYTES, READ_COMMANDS, UNSUPPORTED, clockDriftText, passwordProblem, commandText, evaluate, evaluateCompanion, formatDanishTime, formatLatLon, forwards, hasDeviceLocation, isRepeater, lockFindings, nameProblem, needsReboot, parseClock, parseState, planCommands, roleLabel, scopeKeyFor } from "./checks.js";

const HIGHLIGHT_COLOR = "#ffffff";

// --- Small DOM helpers shared with app.js and contacts-ui.js ---------------------------------------

export function $(id) { return document.getElementById(id); }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function showError(el, msg) {
  el.textContent = msg || "";
  el.hidden = !msg;
}

// Progress bar: null hides it; { text } alone is indeterminate; { done, total, text } is a real fraction.
export function setProgress(el, state) {
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

// A log(kind, text) function writing into a <pre>; kind is tx | rx | info | error.
export function createLog(el) {
  return function log(kind, text) {
    const line = document.createElement("div");
    line.className = kind;
    line.textContent = (kind === "tx" ? "> " : kind === "rx" ? "< " : "· ") + text;
    el.appendChild(line);
    while (el.childElementCount > 500) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  };
}

// Chromium's exact messages when the user closes the device picker without choosing
// anything. Only these are silent. They are NotFoundErrors, but so is
// "Web Bluetooth API globally disabled." (Brave's default, or a Chrome policy), so
// the error name alone cannot tell a cancel from a blocked API.
export const CANCEL_MESSAGES = ["User cancelled the requestDevice() chooser.", "No port selected by the user."];
export const BLE_DISABLED_MESSAGE = "Web Bluetooth API globally disabled.";
// Pages are not allowed to link to browser-internal URLs (chrome://, brave://, edge://) -
// the navigation is blocked - so the address is shown with a copy button instead.
export const BRAVE_BLE_FLAG = "brave://flags/#brave-web-bluetooth-api";

// Fills `el` with the connect error. Text only, except the Brave case, which gets the
// flag address as <code> plus a copy button.
export function showConnectError(el, transport, e) {
  const msg = e && e.message ? e.message : String(e);
  el.replaceChildren();
  el.append((transport === "ble" ? "Kunne ikke forbinde via Bluetooth: " : "Kunne ikke åbne porten: ") + msg);
  if (transport === "ble" && msg === BLE_DISABLED_MESSAGE) {
    const code = document.createElement("code");
    code.textContent = BRAVE_BLE_FLAG;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "am-copy";
    btn.dataset.copy = BRAVE_BLE_FLAG;
    btn.textContent = "Kopiér";
    el.append(" Browseren har slået Web Bluetooth fra. I Brave: indsæt ", code, btn, " i adresselinjen, vælg Enabled og genstart browseren. I Chrome/Edge på en arbejdscomputer er det typisk en politik sat af en administrator.");
  } else if (transport === "ble") {
    el.append(" Er enheden tændt og inden for rækkevidde, og er den ikke allerede forbundet til appen på telefonen?");
  }
  el.hidden = false;
}

async function copyToClipboard(btn) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = "Kopieret";
  } catch (e) {
    btn.textContent = "Kunne ikke kopiere - markér teksten og kopiér selv";
  }
  setTimeout(() => { btn.textContent = label; }, 2500);
}

// One delegated handler for every <button data-copy="…"> on the page.
export function installCopyButtons() {
  document.addEventListener("click", (ev) => { const btn = ev.target.closest("button[data-copy]"); if (btn) copyToClipboard(btn); });
}

// --- Data --------------------------------------------------------------------------

export async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Kunne ikke hente " + url + ": " + r.status);
  return r.json();
}

// The site root, resolved from this module's own URL (lib/flow.js), so the data
// files are found no matter which page imports this.
const SITE_ROOT = new URL("../", import.meta.url);

export async function loadDataset() {
  const regions = await fetchJSON(new URL("regions.json", SITE_ROOT));
  const manifest = await fetchJSON(new URL("postnumre/index.json", SITE_ROOT));
  const files = [];
  for (const f of manifest.files || []) files.push(await fetchJSON(new URL("postnumre/" + f.file, SITE_ROOT)));
  return buildDataset(regions, files);
}

// --- The flow ------------------------------------------------------------------------
//
// ui: the elements listed in REQUIRED_UI (ids in index.html).
// setStatus(text, cls): the page's status line.
// mode: "direct" (USB/BLE to the device itself) or "remote" (through a companion);
//       remote locks the radio settings and words the error messages differently.
// onReboot(): called after a reboot command has been sent.
// reread(): re-reads the device after changes were applied (default: readSettings();
//       app.js re-identifies first, so a companion's DEVICE_INFO is fresh too).
const REQUIRED_UI = ["readProgress", "device", "deviceError", "deviceNote", "deviceTable", "location", "locationText", "mapHint", "btnPick", "btnUseDevice", "scopesText", "map",
  "recommend", "findings", "plan", "btnApply", "btnReboot", "applyStatus", "applyLog", "rebootNote", "applyProgress", "btnReread"];

export function createFlow({ ui, log, setStatus, mode = "direct", onReboot = async () => {}, reread = null }) {
  for (const k of REQUIRED_UI) if (!ui[k]) throw new Error("flow: mangler UI-element " + k);
  const datasetPromise = loadDataset();

  const app = {
    link: null,
    identity: null,
    companion: null,
    replies: null,     // raw replies keyed like READ_COMMANDS
    state: null,       // parseState(replies)
    location: null,    // { lat, lon, source: "device" | "map" }
    scopes: null,      // scopesForPoint() for the location
    findings: [],
    selected: new Set(),   // finding ids that will be applied
    deselected: new Set(), // finding ids the user unticked (kept across re-renders)
    input: { ownerInfo: "" },
    pickMode: false,
    expectedScopeKey: null,
    map: null, marker: null, highlight: null
  };

  let remote = mode === "remote";

  // Switches between direct and remote wording/rules at runtime (app.js keeps one flow
  // for both, since the buttons are wired once).
  function setMode(m) { remote = m === "remote"; }

  // --- Map ---

  function initMap() {
    if (app.map) { app.map.invalidateSize(); return; } // the container may have been hidden meanwhile
    if (typeof L === "undefined") return;
    // maxZoom: maplibre-gl-leaflet renders MapLibre one zoom level below Leaflet
    // (512 px vs 256 px tiles), and the OpenFreeMap tiles carry names for minor
    // streets from MapLibre zoom 14 - so Leaflet has to be allowed to at least
    // 15 before street names show up. The tiles stop at 14 but the style
    // overzooms them fine, so 19 is only a "how close" limit, not a tile limit.
    const map = L.map(ui.map, { center: [56.0, 11.0], zoom: 7, minZoom: 6, maxZoom: 19, worldCopyJump: false });
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
      ? `Enheden har position ${formatLatLon(lat, lon)} gemt. Klik "Vælg en anden position" hvis den er forkert.`
      : `Valgt position: ${formatLatLon(lat.toFixed(6), lon.toFixed(6))} (sættes på enheden når du anvender anbefalingerne).`;
    ui.scopesText.textContent = app.scopes.scopes.length
      ? "Scopes: " + app.scopes.scopes.join(", ")
      : "Positionen ligger uden for alle kendte regioner - ingen scopes kan udledes.";
    ui.btnUseDevice.hidden = !(source === "map" && app.state && hasDeviceLocation(app.state));
    drawLocation();
    renderFindings();
  }

  // --- Reading ---

  function reset() {
    showError(ui.deviceError, "");
    showError(ui.deviceNote, "");
    ui.deviceTable.innerHTML = "";
    ui.device.hidden = true;
    ui.location.hidden = true;
    ui.recommend.hidden = true;
    ui.rebootNote.hidden = true;
    ui.btnReboot.hidden = true;
    ui.applyLog.innerHTML = "";
    ui.applyStatus.textContent = "";
    setProgress(ui.readProgress, null);
    setProgress(ui.applyProgress, null);
    app.state = null;
    app.companion = null;
    app.replies = null;
    app.findings = [];
    renderPlan();
  }

  function setLink(link) {
    app.link = link;
    renderPlan();
  }

  // Reads the CLI settings over app.link, then shows device, location and recommendations.
  async function readSettings() {
    const link = app.link;
    if (!link) return;
    try {
      await readSettingsSteps(link);
    } catch (e) {
      console.error(e);
      setProgress(ui.readProgress, null);
      ui.btnReread.disabled = false;
      setStatus("Fejl under læsning: " + (e && e.message ? e.message : e), "error");
      showError(ui.deviceError, "Læsningen blev afbrudt (" + (e && e.message ? e.message : e) + "). "
        + (remote ? "Er companionen stadig forbundet, og er repeateren inden for rækkevidde? Prøv Genlæs enheden." : "Er kablet stadig i? Prøv Genlæs enheden, eller Afbryd og tilslut igen."));
    }
  }

  async function readSettingsSteps(link) {
    ui.btnReread.disabled = true;
    showError(ui.deviceError, "");
    showError(ui.deviceNote, "");
    ui.location.hidden = true;
    ui.recommend.hidden = true;
    ui.device.hidden = false;
    app.companion = null;

    const entries = Object.entries(READ_COMMANDS);
    const replies = {};
    let unanswered = 0;
    for (const [i, [key, cmd]] of entries.entries()) {
      setStatus("Læser indstillinger … (" + (i + 1) + "/" + entries.length + ")", "busy");
      setProgress(ui.readProgress, { done: i, total: entries.length, text: cmd });
      const r = await link.command(cmd);
      if (key === "clock") app.clockAt = Date.now();             // the clock reply is compared with our time at this moment
      if (r.value !== null) replies[key] = r.value;              // "get" style reply
      else if (r.ok && r.reply !== null) replies[key] = r.reply; // ver / board / region ...
      else if (r.reply !== null && (r.unsupported || /unsupported/i.test(r.reply))) replies[key] = UNSUPPORTED; // older firmware, or a board without the hardware
      else replies[key] = null;                                  // no reply, or an error
      if (r.reply === null) unanswered++;
    }
    app.replies = replies;
    app.state = parseState(replies);
    setProgress(ui.readProgress, null);
    ui.btnReread.disabled = false;

    setStatus(deviceStatusText(), "connected");
    renderDevice();
    const notes = [];
    if (app.state.role === "room_server") {
      notes.push("Room server: anbefalingerne er tilpasset - rummets adgangskode (guest.password) røres ikke, og reglerne for videresendelse (loop.detect, flood.max.unscoped) gælder kun hvis repeat er slået til" + (forwards(app.state) ? " (det er den)." : " (det er den ikke)."));
    } else if (app.state.role && !isRepeater(app.state)) {
      notes.push("Enheden melder sig som \"" + app.state.role + "\". Anbefalingerne herunder er lavet til repeatere og room servers - brug dem med omtanke.");
    }
    if (remote && unanswered) {
      notes.push(unanswered + " af " + entries.length + " kommandoer fik intet svar over mesh'et (efter 3 forsøg). De står som \"Kunne ikke aflæses\" herunder - prøv Genlæs enheden, eller ret dem senere.");
    }
    // Stale replies discarded since the last read (including those found right after login).
    const stale = link.stats ? link.stats.stale - (link.stats.staleReported || 0) : 0;
    if (link.stats) link.stats.staleReported = link.stats.stale;
    if (remote && stale) {
      notes.push(stale + " gamle CLI-svar lå i companionens kø og blev smidt væk (sene svar fra en tidligere aflæsning). Ser tallene forkerte ud, så klik Genlæs enheden.");
    }
    showError(ui.deviceNote, notes.join(" "));

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

  // Companion firmware on a direct link: no CLI, only the two companion settings.
  async function showCompanion(identity) {
    const link = app.link;
    setStatus("Læser companion-indstillinger …", "busy");
    setProgress(ui.readProgress, { text: "Læser standard-scope …" });
    ui.device.hidden = false;
    ui.location.hidden = true;
    identity.defaultScope = await link.companionGetDefaultScope();
    identity.clock = await link.companionGetTime();
    identity.clockAt = Date.now();
    setProgress(ui.readProgress, null);
    app.companion = identity;
    app.state = null;
    ui.btnReread.disabled = false;
    renderCompanion(identity);
    setStatus(companionStatusText(), "connected");
    showError(ui.deviceNote, "Dette er companion-firmware (den der bruges sammen med appen). Den har ingen CLI, så repeater-opsætningen gælder ikke - men de to indstillinger der betyder noget for det danske mesh, path.hash.mode og standard-scope (#dk), kan tjekkes og rettes herunder.");
    if (!app.expectedScopeKey) app.expectedScopeKey = await scopeKeyFor(BEST_PRACTICE.regionDefault);
    ui.recommend.hidden = false;
    renderFindings();
  }

  function showUnknown(message) {
    setProgress(ui.readProgress, null);
    ui.btnReread.disabled = false;
    ui.deviceTable.innerHTML = "";
    ui.device.hidden = false;
    setStatus("Forbundet, men enheden svarer ikke", "error");
    showError(ui.deviceError, message);
  }

  // --- Rendering ---

  function deviceStatusText() {
    const s = app.state;
    return (remote ? "Logget ind på: " : "Forbundet: ") + roleLabel(s.role) + " · " + (s.name || "(uden navn)") + " · " + (s.board || "") + " · " + (s.version ? s.version.text : "");
  }

  function companionStatusText() {
    const id = app.companion, s = id.selfInfo, d = id.deviceInfo;
    return "Forbundet" + (app.link && app.link.kind === "ble" ? " via Bluetooth" : "") + ": companion" + (s && s.name ? " · " + s.name : "") + (d ? " · " + d.board + " · " + (d.firmwareVersion || "") : "");
  }

  function renderRows(rows) {
    ui.deviceTable.innerHTML = rows.map(([k, v, raw]) =>
      "<tr><th>" + escapeHtml(k) + "</th><td>" + (v === null || v === undefined || v === "" ? '<span class="muted">–</span>' : (raw ? v : escapeHtml(v))) + "</td></tr>"
    ).join("");
    wireRename();
    wirePassword();
    wireClock();
  }

  // The admin password row: never shown, only replaced (the CLI cannot read it back).
  function passwordCell() {
    return '<span id="devicePassword">***</span>'
      + ' <button type="button" class="am-copy" id="btnPassword">Skift</button>'
      + ' <span class="am-rename" id="passwordForm" hidden><input type="text" id="passwordInput" maxlength="' + PASSWORD_MAX_BYTES + '" autocomplete="off" spellcheck="false" aria-label="Ny admin-adgangskode" placeholder="ny admin-adgangskode">'
      + ' <button type="button" class="am-copy" id="btnPasswordSave">Gem</button> <button type="button" class="am-copy" id="btnPasswordCancel">Annullér</button></span>'
      + ' <span class="muted" id="passwordNote"></span>';
  }

  // The clock row: the device's time as Danish wall-clock time, how far it is from
  // ours, a Synkronisér button, and a note for the outcome.
  function clockCell(epoch, atMs, resolution) {
    const shown = epoch === null || epoch === undefined
      ? '<span class="muted">–</span>'
      : escapeHtml(formatDanishTime(epoch)) + ' <span class="muted">dansk tid · ' + escapeHtml(clockDriftText(epoch, Math.floor(atMs / 1000), resolution)) + "</span>";
    return '<span id="deviceClock">' + shown + "</span>"
      + ' <button type="button" class="am-copy" id="btnClockSync">Synkronisér</button>'
      + ' <span class="muted" id="clockNote"></span>';
  }

  // The name row: the name, an Omdøb button, and the inline form it opens.
  function nameCell(name) {
    return '<span id="deviceName">' + (name ? escapeHtml(name) : '<span class="muted">(uden navn)</span>') + "</span>"
      + ' <button type="button" class="am-copy" id="btnRename">Omdøb</button>'
      + ' <span class="am-rename" id="renameForm" hidden><input type="text" id="renameInput" maxlength="' + NAME_MAX_BYTES + '" spellcheck="false" aria-label="Nyt navn">'
      + ' <button type="button" class="am-copy" id="btnRenameSave">Gem</button> <button type="button" class="am-copy" id="btnRenameCancel">Annullér</button></span>'
      + ' <span class="muted" id="renameNote"></span>';
  }

  function renderCompanion(id) {
    const d = id.deviceInfo, s = id.selfInfo;
    // Only what the recommendations below do not already show (a companion has no
    // map section, so its position is shown here).
    renderRows([
      ["Firmware", "Companion" + (d && d.firmwareVersion ? " " + d.firmwareVersion : "") + (d && d.buildDate ? " (build " + d.buildDate + ")" : "")],
      ["Board", d ? d.board : null],
      ["Type", s ? s.type : null],
      ["Navn", nameCell(s ? s.name : ""), true],
      ["Ur", clockCell(id.clock, id.clockAt, "second"), true],
      ["Public key", s ? "<code>" + escapeHtml(s.publicKey) + "</code>" : null, true],
      ["Position", s && (s.lat || s.lon) ? formatLatLon(s.lat, s.lon) : "ikke sat"]
    ]);
  }

  function renderDevice() {
    const s = app.state;
    // Only what the recommendations below do not already show - the position has
    // its own section and a row in the recommendations.
    renderRows([
      ["Firmware", s.version ? roleLabel(s.role) + " " + s.version.text + (s.version.build ? " (build " + s.version.build + ")" : "") : null],
      ["Board", s.board],
      ["Rolle", roleLabel(s.role)],
      ["Navn", nameCell(s.name), true],
      ["Adgangskode", passwordCell(), true],
      ["Ur", clockCell(s.clock, app.clockAt, "minute"), true],
      ["Public key", s.publicKey ? "<code>" + escapeHtml(s.publicKey) + "</code>" : null, true],
      ...(s.role === "room_server" ? [["Rummets adgangskode (guest.password)", s.guestPassword]] : [])
    ]);
  }

  // --- The admin password ---
  //
  // "password <ny>" over the CLI (also over the mesh, as admin - the current login
  // stays valid, the next one needs the new password). The firmware echoes
  // "password now: <ny>", which is what counts as success.

  function wirePassword() {
    const btn = $("btnPassword"), form = $("passwordForm"), input = $("passwordInput"), note = $("passwordNote");
    if (!btn) return;
    btn.addEventListener("click", () => {
      form.hidden = false;
      btn.hidden = true;
      $("devicePassword").hidden = true;
      note.textContent = "";
      input.value = "";
      input.focus();
    });
    const close = () => { form.hidden = true; btn.hidden = false; $("devicePassword").hidden = false; input.value = ""; };
    $("btnPasswordCancel").addEventListener("click", () => { close(); note.textContent = ""; });
    $("btnPasswordSave").addEventListener("click", () => setPassword(input.value, close));
    input.addEventListener("keydown", e => { if (e.key === "Enter") setPassword(input.value, close); if (e.key === "Escape") $("btnPasswordCancel").click(); });
  }

  async function setPassword(pw, close) {
    const link = app.link;
    const note = $("passwordNote"), form = $("passwordForm");
    if (!link) return;
    const problem = passwordProblem(pw);
    if (problem) { note.textContent = problem; return; }
    for (const el of form.querySelectorAll("input, button")) el.disabled = true;
    note.textContent = remote ? "Sender over mesh'et …" : "Sender …";
    const r = await link.command("password " + pw, { timeoutMs: remote ? 20000 : 4000 });
    for (const el of form.querySelectorAll("input, button")) el.disabled = false;
    const ok = r.reply !== null && r.reply.split("\n")[0] === "password now: " + pw;
    if (!ok) {
      note.textContent = "Adgangskoden blev ikke skiftet: " + (r.reply === null ? (remote ? "intet svar efter 3 forsøg" : "intet svar") : r.reply.split("\n")[0]) + ".";
      return;
    }
    close();
    note.textContent = "Adgangskoden er skiftet." + (remote ? " Brug den nye ved næste login over mesh'et." : "");
    log("info", "admin-adgangskode skiftet");
  }

  // --- The clock ---
  //
  // Synkronisér sets the device to the computer's time: a repeater/room server
  // gets "time <epoch>" (also over the mesh), a companion CMD_SET_DEVICE_TIME.
  // The firmware only moves a clock forwards, so a device that is ahead says so.
  // Afterwards the clock is read again and the row re-rendered.

  function wireClock() {
    const btn = $("btnClockSync");
    if (btn) btn.addEventListener("click", syncClock);
  }

  async function syncClock() {
    const link = app.link;
    if (!link) return;
    const btn = $("btnClockSync"), note = $("clockNote");
    btn.disabled = true;
    note.textContent = remote ? "Stiller uret over mesh'et …" : "Stiller uret …";
    const now = Math.floor(Date.now() / 1000);
    let ok, problem;
    if (app.companion) {
      ok = await link.companionSetTime(now);
      problem = ok ? "" : "companionens ur er foran computerens, og firmwaren stiller kun uret frem";
      app.companion.clock = await link.companionGetTime();
      app.companion.clockAt = Date.now();
      renderCompanion(app.companion);
    } else {
      const r = await link.command("time " + now, { timeoutMs: remote ? 20000 : 4000 });
      ok = r.reply !== null && /^OK/.test(r.reply);
      problem = r.reply === null ? (remote ? "intet svar efter 3 forsøg" : "intet svar")
        : /cannot go backwards/.test(r.reply) ? "enhedens ur er foran computerens, og firmwaren stiller kun uret frem"
        : r.reply.split("\n")[0];
      const c = await link.command("clock", { timeoutMs: remote ? 20000 : 4000 });
      app.state.clock = parseClock(c.reply);
      app.clockAt = Date.now();
      renderDevice();
    }
    $("clockNote").textContent = ok ? "Uret er stillet efter computerens." : "Uret kunne ikke stilles: " + problem + ".";
    log("info", ok ? "ur stillet til " + now : "ur ikke stillet: " + problem);
  }

  // --- Renaming ---
  //
  // A repeater/room server gets "set name <navn>" over its CLI (also over the
  // mesh, as admin); a companion gets CMD_SET_ADVERT_NAME. The firmware keeps 31
  // bytes and refuses [ ] \ : , ? * - nameProblem() applies the same rule before
  // anything is sent. The new name reaches the rest of the mesh with the device's
  // next advert.

  function currentName() {
    return app.companion ? (app.companion.selfInfo ? app.companion.selfInfo.name : "") : (app.state ? app.state.name : "");
  }

  function wireRename() {
    const btn = $("btnRename"), form = $("renameForm"), input = $("renameInput"), note = $("renameNote");
    if (!btn) return;
    btn.addEventListener("click", () => {
      form.hidden = false;
      btn.hidden = true;
      $("deviceName").hidden = true;
      note.textContent = "";
      input.value = currentName() || "";
      input.focus();
      input.select();
    });
    $("btnRenameCancel").addEventListener("click", () => { form.hidden = true; btn.hidden = false; $("deviceName").hidden = false; note.textContent = ""; });
    $("btnRenameSave").addEventListener("click", () => rename(input.value));
    input.addEventListener("keydown", e => { if (e.key === "Enter") rename(input.value); if (e.key === "Escape") $("btnRenameCancel").click(); });
  }

  async function rename(name) {
    const link = app.link;
    const note = $("renameNote"), form = $("renameForm");
    if (!link) return;
    const problem = nameProblem(name);
    if (problem) { note.textContent = problem; return; }
    if (name === currentName()) { form.hidden = true; $("btnRename").hidden = false; $("deviceName").hidden = false; return; }
    for (const el of form.querySelectorAll("input, button")) el.disabled = true;
    note.textContent = remote ? "Sender over mesh'et …" : "Sender …";
    let ok, reply;
    if (app.companion) {
      ok = await link.companionSetName(name);
      reply = ok ? "OK" : "companionen afviste navnet";
    } else {
      const r = await link.command("set name " + name, { timeoutMs: remote ? 20000 : 4000 });
      ok = r.ok && r.reply !== null;
      reply = r.reply === null ? (remote ? "intet svar efter 3 forsøg" : "intet svar") : r.reply.split("\n")[0];
    }
    for (const el of form.querySelectorAll("input, button")) el.disabled = false;
    if (!ok) { note.textContent = "Kunne ikke omdøbe: " + reply; return; }
    if (app.companion) { if (app.companion.selfInfo) app.companion.selfInfo.name = name; renderCompanion(app.companion); setStatus(companionStatusText(), "connected"); }
    else { app.state.name = name; renderDevice(); setStatus(deviceStatusText(), "connected"); }
    $("renameNote").textContent = "Omdøbt. Resten af mesh'et ser det nye navn ved enhedens næste advert.";
    log("info", "omdøbt til \"" + name + "\"");
  }

  const STATUS = { ok: "OK", change: "Ændres", locked: "Vises kun", input: "Mangler input", unknown: "Kunne ikke aflæses", unsupported: "Ikke understøttet" };
  // The little box-with-arrow that marks a link opening in a new tab.
  const EXTERNAL_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';

  function renderFindings() {
    if (app.companion) app.findings = evaluateCompanion(app.companion, app.expectedScopeKey);
    else if (app.state) app.findings = evaluate(app.state, app.location, app.scopes, app.input);
    else return;
    if (remote) app.findings = lockFindings(app.findings);
    // Keep the user's (de)selections across re-renders; new "change" findings start selected.
    const known = new Set(app.findings.map(f => f.id));
    for (const id of [...app.selected]) if (!known.has(id)) app.selected.delete(id);
    for (const f of app.findings) {
      if (f.status !== "change") { app.selected.delete(f.id); continue; }
      if (f.optIn) continue;                                   // opt-in rows are only applied if the user ticks them
      if (!app.deselected.has(f.id)) app.selected.add(f.id);
    }
    ui.findings.innerHTML = app.findings.map(f => {
      const cb = f.status === "change"
        ? `<input type="checkbox" data-id="${f.id}" ${app.selected.has(f.id) ? "checked" : ""} aria-label="Anvend ${escapeHtml(f.label)}">`
        : "";
      let recommended = escapeHtml(f.recommended);
      if (f.id === "owner.info" && (f.status === "input" || f.status === "change")) {
        recommended = `<input type="text" id="ownerInfoInput" maxlength="120" placeholder="fx ${escapeHtml(OWNER_INFO_EXAMPLE)}" value="${escapeHtml(app.input.ownerInfo)}">`;
      }
      const note = f.note ? `<div class="note">${escapeHtml(f.note)}</div>` : "";
      // A small "open in new tab" icon after the label leads to the setting's explanation on the defaults page.
      const anchor = DEFAULTS_ANCHOR[f.id];
      const label = escapeHtml(f.label) + (anchor ? ` <a class="am-def" href="#/defaults/${anchor}" target="_blank" rel="noopener" title="Læs om indstillingen (åbner i en ny fane)" aria-label="Læs om ${escapeHtml(f.label)} (åbner i en ny fane)">${EXTERNAL_ICON}</a>` : "");
      return `<tr class="${f.status}"><td>${cb}</td><td>${label}${note}</td><td><code>${escapeHtml(f.current)}</code></td><td>${recommended}</td><td class="status ${f.status}">${STATUS[f.status]}</td></tr>`;
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
    ui.btnApply.disabled = !cmds.length || !app.link;
  }

  // --- Applying ---

  async function apply() {
    const link = app.link;
    if (!link) return;
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
          const r = await link.command(cmd, { timeoutMs: remote ? 20000 : 4000 });
          ok = r.ok || (r.reply !== null && cmd.startsWith("region def"));
          reply = r.reply === null ? (remote ? "(intet svar efter 3 forsøg)" : "(intet svar)") : r.reply.split("\n")[0];
        } else if (cmd.remove) {
          const res = await removeRegions(link, cmd.remove);
          ok = res.ok;
          reply = (res.removed.length ? "fjernet: " + res.removed.join(", ") : "intet fjernet")
            + (Object.keys(res.errors).length ? " · fejl: " + Object.entries(res.errors).map(([n, e]) => n + " (" + e + ")").join(", ") : "");
        } else {
          ok = await link.companionSet(cmd.payload, cmd.text);
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
    ui.applyStatus.textContent = failed
      ? `${failed} af ${cmds.length} kommandoer fejlede - se listen.` + (remote ? " Genlæs enheden og prøv igen, eller ret dem manuelt." : "")
      : "Alle ændringer anvendt.";
    if (needsReboot(cmds)) {
      ui.rebootNote.hidden = false;
      ui.btnReboot.hidden = false;
    }
    if (reread) await reread();
    else await readSettings();
  }

  async function reboot() {
    if (!app.link) return;
    ui.btnReboot.disabled = true;
    await app.link.command("reboot", { timeoutMs: 1000, attempts: 1 }); // no reply expected
    ui.btnReboot.hidden = true;
    ui.btnReboot.disabled = false;
    ui.rebootNote.hidden = true;
    await onReboot();
  }

  // Removes regions in dependency order without knowing the tree: a region that
  // still has children answers "Err - not empty" and is retried after the others;
  // the loop stops when a pass removes nothing.
  async function removeRegions(link, names) {
    let pending = [...names];
    const removed = [];
    const errors = {};
    while (pending.length) {
      const again = [];
      for (const name of pending) {
        const r = await link.command("region remove " + name, { timeoutMs: remote ? 20000 : 4000 });
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

  // --- Wiring for the elements the flow owns ---

  ui.btnPick.addEventListener("click", () => { app.pickMode = true; ui.mapHint.hidden = false; ui.locationText.textContent = "Klik på kortet hvor enheden står."; });
  ui.btnUseDevice.addEventListener("click", () => { if (app.state && hasDeviceLocation(app.state)) setLocation(app.state.lat, app.state.lon, "device"); });
  ui.btnApply.addEventListener("click", apply);
  ui.btnReboot.addEventListener("click", reboot);

  return { app, setLink, setMode, reset, readSettings, showCompanion, showUnknown, renderFindings, renderPlan, apply, reboot };
}
