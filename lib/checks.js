// checks.js - the "best practice" rules for a Danish MeshCore repeater (and
// room server).
//
// Pure functions: parse the raw CLI replies into a typed device state, then
// compare that state (plus the chosen location and its scopes) with the
// recommendations on the front page, producing a list of findings with the
// exact CLI commands that would fix each one. No DOM, no serial - so this can
// be unit tested in Node (tools/checks.test.js).
//
// Roles (from "get role"): "repeater" gets every rule. "room_server" shares the
// CLI but differs in two ways that matter: its guest.password is the room's
// join password (never touched), and it does not forward by default (repeat
// off), so the forwarding rules (loop.detect, flood.max.unscoped) only apply
// when repeat is on. Other roles (sensor, ...) are treated like a room server.

import { FIXED_SCOPE_PARENTS, regionDefLines } from "./scopes.js";
import { setDefaultScopePayload, setPathHashModePayload } from "./serial.js";

// The recommendations (the ones the defaults view explains), in one place.
export const BEST_PRACTICE = Object.freeze({
  radio: { freq: 869.618, bw: 62.5, sf: 8, cr: 8, crRange: [5, 8] },
  dutycycle: 10,
  pathHashModeMin: 1,
  advertInterval: 0,
  floodAdvertInterval: [60, 85],
  guestPassword: "hello",
  regionDefault: "dk",
  loopDetect: "moderate",
  floodMaxUnscoped: 15
});

// The get/other commands that describe a repeater. Order matters only for display.
export const READ_COMMANDS = Object.freeze({
  ver: "ver",
  board: "board",
  role: "get role",
  name: "get name",
  publicKey: "get public.key",
  radio: "get radio",
  tx: "get tx",
  lat: "get lat",
  lon: "get lon",
  dutycycle: "get dutycycle",
  advertInterval: "get advert.interval",
  floodAdvertInterval: "get flood.advert.interval",
  guestPassword: "get guest.password",
  pathHashMode: "get path.hash.mode",
  loopDetect: "get loop.detect",
  floodMaxUnscoped: "get flood.max.unscoped",
  ownerInfo: "get owner.info",
  repeat: "get repeat",
  gpsAdvert: "gps advert",
  regionDefault: "region default",
  regionsAllowed: "region list allowed",
  regionsDenied: "region list denied"
});

// "v1.17.1 (Build: 12 Sep 2026)" -> { text: "v1.17.1", major, minor, patch, build }
export function parseVersion(s) {
  if (!s) return null;
  const m = /v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(s);
  if (!m) return { text: s, major: 0, minor: 0, patch: 0, build: null };
  const b = /\(Build: ([^)]*)\)/.exec(s);
  return { text: "v" + m[1] + "." + m[2] + "." + (m[3] || "0"), major: +m[1], minor: +m[2], patch: +(m[3] || 0), build: b ? b[1] : null };
}

export function versionAtLeast(v, major, minor) {
  if (!v) return false;
  return v.major > major || (v.major === major && v.minor >= minor);
}

function num(s) {
  if (s === null || s === undefined) return null;
  const n = parseFloat(String(s).replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

// replies: { key: string | null } where null means the firmware did not understand
// the command (or gave no reply). Values are the raw text after "> " for get
// commands and the whole reply for the others.
export function parseState(replies) {
  const r = replies;
  const radio = r.radio ? r.radio.split(",").map(num) : null;
  const list = v => v && v !== "-none-" ? v.split(",").map(s => s.trim()).filter(Boolean) : (v === "-none-" ? [] : null);
  const allowed = list(r.regionsAllowed);
  const denied = list(r.regionsDenied);
  const def = r.regionDefault ? /default scope is (?:now )?(\S+)/.exec(r.regionDefault) : null;
  return {
    version: parseVersion(r.ver),
    board: r.board || null,
    role: r.role || null,
    name: r.name ?? null,
    publicKey: r.publicKey || null,
    radio: radio && radio.length === 4 && radio.every(x => x !== null)
      ? { freq: radio[0], bw: radio[1], sf: radio[2], cr: radio[3], text: r.radio }
      : null,
    txPower: num(r.tx),
    lat: num(r.lat),
    lon: num(r.lon),
    dutycycle: num(r.dutycycle),
    advertInterval: num(r.advertInterval),
    floodAdvertInterval: num(r.floodAdvertInterval),
    guestPassword: r.guestPassword ?? null,
    pathHashMode: num(r.pathHashMode),
    loopDetect: r.loopDetect || null,
    floodMaxUnscoped: num(r.floodMaxUnscoped),
    ownerInfo: r.ownerInfo ?? null,
    repeat: r.repeat === "on" || r.repeat === "off" ? r.repeat : null,   // null on firmware without "get repeat"
    gpsAdvert: r.gpsAdvert || null,            // "none" | "prefs" | "share" | null (no GPS support in firmware)
    regionDefault: def ? def[1] : null,        // "<null>" when unset
    regionsAllowed: allowed,                    // ["*", "eu", "dk", ...] or null
    regionsDenied: denied                       // regions present but with flood denied, or null
  };
}

export const ROLE_LABELS = Object.freeze({ repeater: "Repeater", room_server: "Room server", sensor: "Sensor" });

export function roleLabel(role) {
  return ROLE_LABELS[role] || role || "ukendt";
}

export function isRepeater(state) {
  return state.role === "repeater";
}

// Does this node forward floods? Repeaters do unless repeat is explicitly off;
// everything else only when repeat is explicitly on.
export function forwards(state) {
  if (isRepeater(state)) return state.repeat !== "off";
  return state.repeat === "on";
}

export function hasDeviceLocation(state) {
  return state.lat !== null && state.lon !== null && (state.lat !== 0 || state.lon !== 0);
}

// Deterministic per device, spread over the recommended range: the same
// repeater always gets the same interval, but different repeaters differ.
export function floodAdvertIntervalFor(publicKey) {
  const [lo, hi] = BEST_PRACTICE.floodAdvertInterval;
  let h = 0;
  for (const c of String(publicKey || "")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return lo + (h % (hi - lo + 1));
}

function close(a, b, eps = 0.001) {
  return a !== null && Math.abs(a - b) <= eps;
}

function fmt(v) {
  return v === null || v === undefined || v === "" ? "–" : String(v);
}

// The owner.info example shown on the defaults page and as the input placeholder.
export const OWNER_INFO_EXAMPLE = "min@email.dk / 6dBi omni @9m / Solar+Batt / Tagmontering";

// A position as people read it: "55.325000° N, 10.490000° Ø" (S/V south of the
// equator / west of Greenwich). Numbers or numeric strings are shown as given,
// so a device's own "56.1963043" keeps its digits.
export function formatLatLon(lat, lon) {
  const la = Number(lat), lo = Number(lon);
  const ns = la < 0 ? "S" : "N", ew = lo < 0 ? "V" : "Ø";
  return `${String(lat).replace(/^-/, "")}° ${ns}, ${String(lon).replace(/^-/, "")}° ${ew}`;
}

// The device name: char node_name[32] in the firmware (31 characters, counted in
// bytes), and CommonCLI's isValidName() refuses [ ] \ : , ? *. Returns the
// problem as text, or null when the name is fine.
export const NAME_MAX_BYTES = 31;
export function nameProblem(name) {
  if (!name.trim()) return "Navnet må ikke være tomt.";
  if (/[\[\]\\:,?*]/.test(name)) return "Navnet må ikke indeholde [ ] \\ : , ? eller *.";
  if (new TextEncoder().encode(name).length > NAME_MAX_BYTES) return "Navnet må højst være " + NAME_MAX_BYTES + " tegn (æ, ø og å tæller dobbelt).";
  return null;
}

// Human-readable radio settings: "869.618 MHz · BW 62.5 kHz · SF 8 · CR 4/8".
// Accepts the CLI string "freq,bw,sf,cr" or a { freq, bw, sf, cr } object;
// anything that is not four numbers is returned unchanged.
export function formatRadio(r) {
  if (r === null || r === undefined || r === "") return "–";
  const parts = typeof r === "string" ? r.split(",").map(num) : [r.freq, r.bw, r.sf, r.cr].map(v => (typeof v === "number" ? v : num(v)));
  if (parts.length !== 4 || parts.some(v => v === null || v === undefined || Number.isNaN(v))) return String(r);
  const [freq, bw, sf, cr] = parts;
  return `${freq} MHz · BW ${bw} kHz · SF ${sf} · CR 4/${cr}`;
}

// Settings that are never changed over the mesh: a wrong radio setting cuts the
// link to the repeater, so remote mode only shows the difference.
export const REMOTE_LOCKED = Object.freeze(["radio"]);

// Turns "change" findings for the given ids into "locked" ones: the difference
// is still shown, but nothing is sent. Other findings pass through untouched.
export function lockFindings(findings, lockedIds = REMOTE_LOCKED) {
  const locked = new Set(lockedIds);
  return findings.map(f => locked.has(f.id) && f.status === "change"
    ? { ...f, status: "locked", commands: [], note: "Ændres ikke via mesh - en forkert radioindstilling afbryder forbindelsen. Ret den lokalt via USB." }
    : f);
}

// state: from parseState(). location: { lat, lon, source: "device" | "map" } or
// null. scopes: the result of scopesForPoint() for that location, or null.
// input: { ownerInfo } - free-text values the user typed for "input" findings.
//
// Returns findings, each { id, label, current, recommended, status, commands, note }
// where status is "ok" | "change" | "input" | "unknown" | "unsupported".
export function evaluate(state, location, scopes, input = {}) {
  const BP = BEST_PRACTICE;
  const out = [];
  const add = f => { out.push({ commands: [], note: "", ...f }); };

  // --- Radio -----------------------------------------------------------------
  if (!state.radio) {
    add({ id: "radio", label: "Radio (EU/UK Narrow)", current: "–", recommended: formatRadio(BP.radio), status: "unknown" });
  } else {
    const r = state.radio;
    // CR is the one radio parameter that may differ between nodes (see the
    // defaults page), so a preset that is right apart from a CR in 5-8 is fine as
    // it is. A wrong preset is set to the default CR 8 - the old CR belonged to
    // the old preset.
    const crOk = r.cr >= BP.radio.crRange[0] && r.cr <= BP.radio.crRange[1];
    const ok = close(r.freq, BP.radio.freq) && close(r.bw, BP.radio.bw, 0.01) && r.sf === BP.radio.sf && crOk;
    const cr = ok ? r.cr : BP.radio.cr;
    const rec = `${BP.radio.freq},${BP.radio.bw},${BP.radio.sf},${cr}`;
    add({
      id: "radio", label: "Radio (EU/UK Narrow)", current: formatRadio(r), recommended: formatRadio(rec),
      status: ok ? "ok" : "change",
      commands: ok ? [] : ["set radio " + rec],
      note: ok ? "" : "Kræver genstart af enheden."
    });
  }

  // --- Duty cycle ------------------------------------------------------------
  add({
    id: "dutycycle", label: "Dutycycle", current: state.dutycycle === null ? "–" : state.dutycycle + " %", recommended: BP.dutycycle + " %",
    status: state.dutycycle === null ? "unknown" : (close(state.dutycycle, BP.dutycycle, 0.05) ? "ok" : "change"),
    commands: state.dutycycle !== null && !close(state.dutycycle, BP.dutycycle, 0.05) ? ["set dutycycle " + BP.dutycycle] : []
  });

  // --- path.hash.mode --------------------------------------------------------
  add({
    id: "path.hash.mode", label: "path.hash.mode", current: fmt(state.pathHashMode), recommended: "≥ " + BP.pathHashModeMin,
    status: state.pathHashMode === null ? "unknown" : (state.pathHashMode >= BP.pathHashModeMin ? "ok" : "change"),
    commands: state.pathHashMode !== null && state.pathHashMode < BP.pathHashModeMin ? ["set path.hash.mode " + BP.pathHashModeMin] : []
  });

  // --- advert.interval -------------------------------------------------------
  add({
    id: "advert.interval", label: "advert.interval (0-hop adverts)", current: fmt(state.advertInterval), recommended: String(BP.advertInterval),
    status: state.advertInterval === null ? "unknown" : (state.advertInterval === BP.advertInterval ? "ok" : "change"),
    commands: state.advertInterval !== null && state.advertInterval !== BP.advertInterval ? ["set advert.interval " + BP.advertInterval] : []
  });

  // --- flood.advert.interval -------------------------------------------------
  {
    const [lo, hi] = BP.floodAdvertInterval;
    const cur = state.floodAdvertInterval;
    const ok = cur !== null && cur >= lo && cur <= hi;
    const rec = floodAdvertIntervalFor(state.publicKey);
    add({
      id: "flood.advert.interval", label: "flood.advert.interval (timer)", current: fmt(cur), recommended: `${rec} (${lo}–${hi})`,
      status: cur === null ? "unknown" : (ok ? "ok" : "change"),
      commands: cur !== null && !ok ? ["set flood.advert.interval " + rec] : []
    });
  }

  // --- repeat (repeaters must forward) ----------------------------------------
  if (isRepeater(state) && state.repeat !== null) {
    add({
      id: "repeat", label: "repeat (videresendelse)", current: state.repeat, recommended: "on",
      status: state.repeat === "on" ? "ok" : "change",
      commands: state.repeat === "on" ? [] : ["set repeat on"],
      note: state.repeat === "on" ? "" : "En repeater med repeat off videresender ingenting."
    });
  }

  // --- guest.password (repeaters only: on a room server it is the room's join password) ---
  if (isRepeater(state)) {
    add({
      id: "guest.password", label: "guest.password", current: fmt(state.guestPassword), recommended: BP.guestPassword,
      status: state.guestPassword === null ? "unknown" : (state.guestPassword === BP.guestPassword ? "ok" : "change"),
      commands: state.guestPassword !== null && state.guestPassword !== BP.guestPassword ? ["set guest.password " + BP.guestPassword] : []
    });
  }

  // --- forwarding rules: repeaters always (repeat on is recommended above), others only when they forward ---
  if (isRepeater(state) || forwards(state)) {
    add({
      id: "loop.detect", label: "loop.detect", current: fmt(state.loopDetect), recommended: BP.loopDetect,
      status: state.loopDetect === null ? "unknown" : (state.loopDetect === BP.loopDetect ? "ok" : "change"),
      commands: state.loopDetect !== null && state.loopDetect !== BP.loopDetect ? ["set loop.detect " + BP.loopDetect] : []
    });
    add({
      id: "flood.max.unscoped", label: "flood.max.unscoped", current: fmt(state.floodMaxUnscoped), recommended: String(BP.floodMaxUnscoped),
      status: state.floodMaxUnscoped === null ? "unknown" : (state.floodMaxUnscoped === BP.floodMaxUnscoped ? "ok" : "change"),
      commands: state.floodMaxUnscoped !== null && state.floodMaxUnscoped !== BP.floodMaxUnscoped ? ["set flood.max.unscoped " + BP.floodMaxUnscoped] : []
    });
  }

  // --- Location --------------------------------------------------------------
  if (!location) {
    add({ id: "location", label: "Position", current: "ikke sat", recommended: "klik på kortet", status: "input" });
  } else if (location.source === "device") {
    add({ id: "location", label: "Position", current: formatLatLon(location.lat, location.lon), recommended: "sat på enheden", status: "ok" });
  } else {
    const lat = location.lat.toFixed(6), lon = location.lon.toFixed(6);
    add({
      id: "location", label: "Position", current: hasDeviceLocation(state) ? formatLatLon(state.lat, state.lon) : "ikke sat", recommended: formatLatLon(lat, lon),
      status: "change", commands: ["set lat " + lat, "set lon " + lon]
    });
  }

  // --- gps advert (only firmware built with GPS support knows this) ----------
  if (state.gpsAdvert !== null) {
    add({
      id: "gps.advert", label: "Position i adverts", current: state.gpsAdvert, recommended: "prefs",
      status: state.gpsAdvert === "prefs" ? "ok" : "change",
      commands: state.gpsAdvert === "prefs" ? [] : ["gps advert prefs"]
    });
  }

  // --- region default --------------------------------------------------------
  add({
    id: "region.default", label: "region default", current: fmt(state.regionDefault), recommended: BP.regionDefault,
    status: state.regionDefault === null ? "unknown" : (state.regionDefault === BP.regionDefault ? "ok" : "change"),
    commands: state.regionDefault !== null && state.regionDefault !== BP.regionDefault ? ["region default " + BP.regionDefault] : []
  });

  // --- Region scopes ---------------------------------------------------------
  if (!scopes || !scopes.scopes.length) {
    add({ id: "regions", label: "Region scopes", current: state.regionsAllowed ? state.regionsAllowed.join(", ") : "–", recommended: "kræver en position inden for kortets regioner", status: "input" });
  } else {
    const expected = [...Object.keys(FIXED_SCOPE_PARENTS), ...scopes.scopes];
    const have = state.regionsAllowed ? new Set(state.regionsAllowed) : null;
    const missing = have ? expected.filter(s => !have.has(s)) : expected;
    const present = have ? [...have, ...(state.regionsDenied || [])] : [];
    const extra = [...new Set(present.filter(s => s !== "*" && !expected.includes(s)))];
    // The commands that put every wanted region in place (re-parenting ones
    // that already exist), for firmware that has region scopes at all.
    let define = null;
    let note = "";
    if (versionAtLeast(state.version, 1, 16)) {
      define = regionDefLines(expected);
    } else if (versionAtLeast(state.version, 1, 12)) {
      define = [];
      for (const s of expected) define.push("region put " + s, "region allowf " + s);
    } else {
      note = "Firmware " + (state.version ? state.version.text : "?") + " understøtter ikke region scopes - opdater til 1.16 eller nyere.";
    }
    add({
      id: "regions", label: "Region scopes", current: have ? [...have].join(", ") : "kunne ikke aflæses",
      recommended: expected.join(", "),
      status: !missing.length ? "ok" : (define ? "change" : "unsupported"),
      commands: missing.length && define ? [...define, "region save"] : [], note
    });
    // Regions the device has beyond the recommended set. Removing them is opt-in
    // (unticked by default): the region def lines run first so any wanted region
    // that hangs under an extra is re-parented, then the extras are removed,
    // children before parents (see removeRegions in flow.js).
    if (extra.length && define) {
      add({
        id: "regions.extra", label: "Ekstra region scopes", current: extra.join(", "), recommended: "fjernes - enheden får kun de anbefalede scopes",
        status: "change", optIn: true,
        commands: [...define, { text: "region remove " + extra.join(", "), remove: extra }, "region save"],
        note: "Fravalgt som standard: sæt flueben for at erstatte enhedens scopes i stedet for kun at tilføje. Underregioner fjernes før deres forældre."
      });
    } else if (extra.length) {
      add({ id: "regions.extra", label: "Ekstra region scopes", current: extra.join(", "), recommended: "fjernes", status: "unsupported", note });
    }
  }

  // --- owner.info ------------------------------------------------------------
  if (state.ownerInfo === null) {
    add({ id: "owner.info", label: "owner.info", current: "–", recommended: "kontakt, antenne, strøm, montering", status: "unknown" });
  } else if (state.ownerInfo.trim()) {
    add({ id: "owner.info", label: "owner.info", current: state.ownerInfo, recommended: "sat", status: "ok" });
  } else {
    const text = (input.ownerInfo || "").trim();
    add({
      id: "owner.info", label: "owner.info", current: "tom", recommended: text || "fx " + OWNER_INFO_EXAMPLE,
      status: text ? "change" : "input",
      commands: text ? ["set owner.info " + text.replace(/\n/g, "|")] : []
    });
  }

  return out;
}

// A command is a CLI line (string), a companion frame { text, payload } or a
// region removal step { text, remove: [names] } (run by removeRegions()).
export function commandText(c) {
  return typeof c === "string" ? c : c.text;
}

// The commands to send for the selected findings, in a sensible order:
// position first (so the region default/scopes make sense), the radio last
// (it asks for a reboot). Deduplicated, order preserved.
export function planCommands(findings, selectedIds) {
  const order = ["location", "gps.advert", "region.default", "regions", "regions.extra", "owner.info", "dutycycle", "path.hash.mode", "advert.interval", "flood.advert.interval", "guest.password", "repeat", "loop.detect", "flood.max.unscoped", "radio"];
  const byId = new Map(findings.map(f => [f.id, f]));
  const cmds = [];
  const seen = new Set();
  for (const id of order) {
    const f = byId.get(id);
    if (!f || !selectedIds.has(id)) continue;
    for (const c of f.commands) {
      const t = commandText(c);
      if (!seen.has(t)) { seen.add(t); cmds.push(c); }
    }
  }
  // One "region save" at the very end, after every region change.
  if (seen.has("region save")) {
    const i = cmds.indexOf("region save");
    cmds.splice(i, 1);
    cmds.push("region save");
  }
  return cmds;
}

export function needsReboot(commands) {
  return commands.some(c => typeof c === "string" && c.startsWith("set radio "));
}

// --- Companion firmware ---------------------------------------------------------
//
// A companion has no CLI, but two settings matter for the Danish mesh and can
// be read and written over its binary protocol: path.hash.mode (in the
// DEVICE_INFO frame) and the default flood scope, which should be "dk" - the
// same scope the repeaters use as `region default`. The scope is stored on
// the device as a name plus a 16-byte transport key derived from the name.

// The transport key for a public "#hashtag" scope: the first 16 bytes of
// SHA-256 over "#" + name (TransportKeyStore::getAutoKeyFor).
export async function scopeKeyFor(name) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("#" + name));
  return new Uint8Array(digest).slice(0, 16);
}

export function hex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

// identity: the result of MeshCoreSerial.identify() for a companion, plus
// defaultScope ({ name, key } / { name: null } / null) from companionGetDefaultScope().
// expectedKey: scopeKeyFor(BEST_PRACTICE.regionDefault), computed by the caller.
export function evaluateCompanion(identity, expectedKey) {
  const BP = BEST_PRACTICE;
  const out = [];
  const add = f => { out.push({ commands: [], note: "", ...f }); };

  const mode = identity.deviceInfo ? identity.deviceInfo.pathHashMode : null;
  add({
    id: "path.hash.mode", label: "path.hash.mode", current: mode === null ? "–" : String(mode), recommended: "≥ " + BP.pathHashModeMin,
    status: mode === null ? "unknown" : (mode >= BP.pathHashModeMin ? "ok" : "change"),
    commands: mode !== null && mode < BP.pathHashModeMin ? [{ text: "CMD_SET_PATH_HASH_MODE " + BP.pathHashModeMin, payload: setPathHashModePayload(BP.pathHashModeMin) }] : [],
    note: mode === null ? "Firmwaren er for gammel til at melde path.hash.mode." : ""
  });

  const scope = identity.defaultScope;
  const want = BP.regionDefault;
  const wantKey = hex(expectedKey);
  const setCmd = { text: "CMD_SET_DEFAULT_FLOOD_SCOPE " + want + " (" + wantKey + ")", payload: setDefaultScopePayload(want, expectedKey) };
  if (scope === null) {
    add({ id: "region.default", label: "Standard-scope (default region)", current: "–", recommended: "#" + want, status: "unknown", note: "Firmwaren svarede ikke på CMD_GET_DEFAULT_FLOOD_SCOPE." });
  } else if (scope.name === null) {
    add({ id: "region.default", label: "Standard-scope (default region)", current: "ikke sat", recommended: "#" + want, status: "change", commands: [setCmd] });
  } else if (scope.name !== want) {
    add({ id: "region.default", label: "Standard-scope (default region)", current: "#" + scope.name, recommended: "#" + want, status: "change", commands: [setCmd] });
  } else if (scope.key !== wantKey) {
    add({ id: "region.default", label: "Standard-scope (default region)", current: "#" + scope.name + " (forkert nøgle " + scope.key + ")", recommended: "#" + want, status: "change", commands: [setCmd], note: "Navnet er rigtigt, men nøglen passer ikke til #" + want + " - sættes igen." });
  } else {
    add({ id: "region.default", label: "Standard-scope (default region)", current: "#" + scope.name, recommended: "#" + want, status: "ok" });
  }
  return out;
}
