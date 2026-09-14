// Tests for the automagical rules (automagical/checks.js) and the CLI reply
// parser (automagical/serial.js). Reply strings are in the exact formats the
// MeshCore repeater firmware produces (src/helpers/CommonCLI.cpp).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, scopesForPoint } from "../scopes.js";
import { loadData } from "./data.js";
import { evaluate, floodAdvertIntervalFor, forwards, hasDeviceLocation, isRepeater, needsReboot, parseState, parseVersion, planCommands, roleLabel, versionAtLeast } from "../automagical/checks.js";
import { parseReply } from "../automagical/serial.js";

const { regions, postnumreFiles } = loadData();
const ds = buildDataset(regions, postnumreFiles);

// A well-configured repeater in Odense SØ (5220), as the CLI would report it.
const GOOD = {
  ver: "v1.17.1 (Build: 12 Sep 2026)",
  board: "Heltec V3",
  role: "repeater",
  name: "OZ1ABC-Rpt",
  publicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  radio: "869.618,62.5,8,8",
  tx: "22",
  lat: "55.3250007",
  lon: "10.4899998",
  dutycycle: "10.0%",
  advertInterval: "0",
  floodAdvertInterval: "72",
  guestPassword: "hello",
  pathHashMode: "1",
  loopDetect: "moderate",
  floodMaxUnscoped: "15",
  ownerInfo: "OZ1ABC / 6dBi omni @9m",
  repeat: "on",
  gpsAdvert: "prefs",
  regionDefault: " default scope is dk",
  regionsAllowed: "*,eu,europe,dk,dk-fyn-odense,dk-fyn,dk5,dk50,dk52,dk53,dk55,dk57,dk58,dk522,dk5220",
  regionTree: "* F\n eu F\n  dk F\n   dk-fyn-odense F"
};

test("parseReply: get, set, unknown, multi-line and echo handling", () => {
  assert.deepEqual(parseReply("get radio", ["get radio", "  -> > 869.618,62.5,8,8"]).value, "869.618,62.5,8,8");
  assert.equal(parseReply("get owner.info", ["  -> > "]).value, "");
  assert.equal(parseReply("set lat 55", ["  -> OK"]).ok, true);
  assert.equal(parseReply("set dutycycle 10", ["  -> OK - 10.0%"]).ok, true);
  assert.equal(parseReply("set radio 1,2,3,4", ["  -> Error, invalid radio params"]).ok, false);
  assert.equal(parseReply("region allowf x", ["  -> Err - unknown region"]).ok, false);
  const u = parseReply("gps advert", ["  -> Unknown command"]);
  assert.equal(u.unsupported, true); assert.equal(u.ok, false); assert.equal(u.value, null);
  assert.equal(parseReply("get foo", ["  -> unknown config: foo"]).unsupported, true);
  const tree = parseReply("region", ["  -> * F", " eu F", "  dk F", "   dk-fyn F", " europe F", ""]);
  assert.equal(tree.reply, "* F\n eu F\n  dk F\n   dk-fyn F\n europe F");
  assert.equal(tree.ok, true);
  assert.equal(parseReply("region default", ["  ->  default scope is dk"]).reply, " default scope is dk");
  assert.equal(parseReply("reboot", []).reply, null);
});

test("parseVersion / versionAtLeast", () => {
  assert.deepEqual(parseVersion("v1.17.1 (Build: 12 Sep 2026)"), { text: "v1.17.1", major: 1, minor: 17, patch: 1, build: "12 Sep 2026" });
  assert.equal(parseVersion("v1.16.0 (Build: x)").text, "v1.16.0");
  assert.ok(versionAtLeast(parseVersion("v1.16.0"), 1, 16));
  assert.ok(!versionAtLeast(parseVersion("v1.15.2"), 1, 16));
  assert.ok(versionAtLeast(parseVersion("v2.0.0"), 1, 16));
});

test("parseState reads the firmware's reply formats", () => {
  const s = parseState(GOOD);
  assert.equal(s.board, "Heltec V3");
  assert.equal(s.version.text, "v1.17.1");
  assert.deepEqual(s.radio, { freq: 869.618, bw: 62.5, sf: 8, cr: 8, text: "869.618,62.5,8,8" });
  assert.equal(s.txPower, 22);
  assert.equal(s.dutycycle, 10);
  assert.equal(s.regionDefault, "dk");
  assert.equal(s.regionsAllowed.length, 15);
  assert.ok(hasDeviceLocation(s));
  assert.equal(parseState({ ...GOOD, lat: "0.0", lon: "0.0" }).lat, 0);
  assert.ok(!hasDeviceLocation(parseState({ ...GOOD, lat: "0.0", lon: "0.0" })));
  assert.equal(parseState({ ...GOOD, regionsAllowed: "-none-" }).regionsAllowed.length, 0);
  assert.equal(parseState({ ...GOOD, regionsAllowed: null }).regionsAllowed, null);
  assert.equal(parseState({ ...GOOD, regionDefault: " default scope is <null>" }).regionDefault, "<null>");
  assert.equal(parseState({ ...GOOD, gpsAdvert: null }).gpsAdvert, null);
});

test("a well-configured repeater gets no recommendations", () => {
  const s = parseState(GOOD);
  const loc = { lat: s.lat, lon: s.lon, source: "device" };
  const f = evaluate(s, loc, scopesForPoint(ds, s.lat, s.lon));
  const notOk = f.filter(x => x.status !== "ok");
  assert.deepEqual(notOk, []);
  assert.deepEqual(planCommands(f, new Set(f.map(x => x.id))), []);
});

test("a factory-fresh repeater without a position asks for the map, then gets the full plan", () => {
  const fresh = {
    ...GOOD, name: "", lat: "0.0", lon: "0.0", dutycycle: "50.0%", advertInterval: "120", floodAdvertInterval: "0",
    guestPassword: "", pathHashMode: "0", loopDetect: "off", floodMaxUnscoped: "0", ownerInfo: "",
    gpsAdvert: "none", regionDefault: " default scope is <null>", regionsAllowed: "-none-", regionTree: "* F"
  };
  const s = parseState(fresh);
  // No position yet: location and regions need input, nothing to send for them.
  let f = evaluate(s, null, null);
  assert.equal(f.find(x => x.id === "location").status, "input");
  assert.equal(f.find(x => x.id === "regions").status, "input");
  assert.equal(f.find(x => x.id === "owner.info").status, "input");
  // The user clicks Odense SØ on the map and types an owner.info.
  const loc = { lat: 55.325, lon: 10.49, source: "map" };
  f = evaluate(s, loc, scopesForPoint(ds, loc.lat, loc.lon), { ownerInfo: "OZ1ABC / 6dBi omni @9m" });
  const byId = Object.fromEntries(f.map(x => [x.id, x]));
  assert.equal(byId.location.status, "change");
  assert.deepEqual(byId.location.commands, ["set lat 55.325000", "set lon 10.490000"]);
  assert.deepEqual(byId["gps.advert"].commands, ["gps advert prefs"]);
  assert.deepEqual(byId["region.default"].commands, ["region default dk"]);
  assert.deepEqual(byId.regions.commands, [
    "region def eu|* europe|eu dk dk-fyn-odense|dk dk-fyn|dk dk5|dk dk50|dk dk52|dk dk53|dk dk55|dk dk57|dk dk58|dk dk522|dk dk5220",
    "region save"
  ]);
  assert.deepEqual(byId.dutycycle.commands, ["set dutycycle 10"]);
  assert.deepEqual(byId["path.hash.mode"].commands, ["set path.hash.mode 1"]);
  assert.deepEqual(byId["advert.interval"].commands, ["set advert.interval 0"]);
  const fai = floodAdvertIntervalFor(GOOD.publicKey);
  assert.ok(fai >= 60 && fai <= 85);
  assert.deepEqual(byId["flood.advert.interval"].commands, ["set flood.advert.interval " + fai]);
  assert.deepEqual(byId["guest.password"].commands, ["set guest.password hello"]);
  assert.deepEqual(byId["loop.detect"].commands, ["set loop.detect moderate"]);
  assert.deepEqual(byId["flood.max.unscoped"].commands, ["set flood.max.unscoped 15"]);
  assert.deepEqual(byId["owner.info"].commands, ["set owner.info OZ1ABC / 6dBi omni @9m"]);
  assert.equal(byId.radio.status, "ok");
  // Plan order: position first, radio last; everything selected.
  const plan = planCommands(f, new Set(f.map(x => x.id)));
  assert.equal(plan[0], "set lat 55.325000");
  assert.ok(plan.indexOf("region default dk") < plan.indexOf("region save"));
  assert.ok(!needsReboot(plan));
  // Deselecting a finding drops its commands.
  const partial = planCommands(f, new Set(["location", "regions"]));
  assert.deepEqual(partial, ["set lat 55.325000", "set lon 10.490000", ...byId.regions.commands]);
});

test("wrong radio preset -> set radio, keeps a valid CR, needs reboot", () => {
  const s = parseState({ ...GOOD, radio: "868.0,125,7,5" });
  const f = evaluate(s, { lat: s.lat, lon: s.lon, source: "device" }, scopesForPoint(ds, s.lat, s.lon));
  const radio = f.find(x => x.id === "radio");
  assert.equal(radio.status, "change");
  assert.deepEqual(radio.commands, ["set radio 869.618,62.5,8,5"]);
  assert.ok(needsReboot(planCommands(f, new Set(["radio"]))));
  // CR 8 is also fine as-is
  assert.equal(evaluate(parseState({ ...GOOD, radio: "869.618,62.5,8,6" }), null, null).find(x => x.id === "radio").status, "ok");
});

test("regions: missing scopes on old firmware use put/allowf, on very old firmware are unsupported; extras are reported", () => {
  const loc = { lat: 55.325, lon: 10.49, source: "device" };
  const sc = scopesForPoint(ds, loc.lat, loc.lon);
  const old = parseState({ ...GOOD, ver: "v1.14.0 (Build: x)", regionsAllowed: "*,eu,dk" });
  const r1 = evaluate(old, loc, sc).find(x => x.id === "regions");
  assert.equal(r1.status, "change");
  assert.equal(r1.commands[0], "region put eu");
  assert.equal(r1.commands[1], "region allowf eu");
  assert.equal(r1.commands.at(-1), "region save");
  const ancient = parseState({ ...GOOD, ver: "v1.9.0 (Build: x)", regionsAllowed: null });
  assert.equal(evaluate(ancient, loc, sc).find(x => x.id === "regions").status, "unsupported");
  const extra = parseState({ ...GOOD, regionsAllowed: GOOD.regionsAllowed + ",dk-jylland" });
  const f3 = evaluate(extra, loc, sc);
  assert.equal(f3.find(x => x.id === "regions").status, "ok");
  assert.equal(f3.find(x => x.id === "regions.extra").current, "dk-jylland");
  // Unknown current regions -> still offered as a change (region def is idempotent)
  const unk = parseState({ ...GOOD, regionsAllowed: null });
  assert.equal(evaluate(unk, loc, sc).find(x => x.id === "regions").status, "change");
});

test("firmware without GPS support hides the advert-position finding", () => {
  const s = parseState({ ...GOOD, gpsAdvert: null });
  const f = evaluate(s, { lat: s.lat, lon: s.lon, source: "device" }, scopesForPoint(ds, s.lat, s.lon));
  assert.ok(!f.some(x => x.id === "gps.advert"));
});

// --- Companion (binary) protocol -------------------------------------------------

import { companionFrame, parseCompanionFrames, parseDeviceInfo, parseSelfInfo } from "../automagical/serial.js";

function deviceInfoFrame() {
  const p = new Uint8Array(82);
  p[0] = 13; p[1] = 8; p[2] = 100; p[3] = 8;
  new DataView(p.buffer).setUint32(4, 123456, true);
  new TextEncoder().encodeInto("12 Sep 2026", p.subarray(8, 20));
  new TextEncoder().encodeInto("Heltec V3", p.subarray(20, 60));
  new TextEncoder().encodeInto("v1.9.2", p.subarray(60, 80));
  p[80] = 0; p[81] = 1;
  return p;
}
function selfInfoFrame() {
  const name = new TextEncoder().encode("Thomas' companion");
  const p = new Uint8Array(58 + name.length);
  p[0] = 5; p[1] = 1; p[2] = 22; p[3] = 22;
  for (let i = 0; i < 32; i++) p[4 + i] = i;
  const dv = new DataView(p.buffer);
  dv.setInt32(36, Math.round(56.1629 * 1e6), true); dv.setInt32(40, Math.round(10.2039 * 1e6), true);
  p[44] = 0; p[45] = 1; p[46] = 0; p[47] = 0;
  dv.setUint32(48, 869618, true); dv.setUint32(52, 62500, true); p[56] = 8; p[57] = 8;
  p.set(name, 58);
  return p;
}

test("companion frames: framing, device info and self info parse", () => {
  const f = companionFrame(Uint8Array.from([22, 1]));
  assert.deepEqual([...f], [0x3C, 2, 0, 22, 1]);
  // A stream with junk, then two '>' frames back to back, split arbitrarily.
  const a = deviceInfoFrame(), b = selfInfoFrame();
  const wire = new Uint8Array([0x00, 0x41, 0x3E, a.length & 0xff, a.length >> 8, ...a, 0x3E, b.length & 0xff, b.length >> 8, ...b, 0x3E]);
  const frames = parseCompanionFrames(wire);
  assert.equal(frames.length, 2);
  const d = parseDeviceInfo(frames[0]);
  assert.deepEqual(d, { firmwareVerCode: 8, buildDate: "12 Sep 2026", board: "Heltec V3", firmwareVersion: "v1.9.2", repeatEnabled: false, pathHashMode: 1 });
  const s = parseSelfInfo(frames[1]);
  assert.equal(s.type, "companion");
  assert.equal(s.txPower, 22);
  assert.equal(s.publicKey, "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  assert.ok(Math.abs(s.lat - 56.1629) < 1e-6 && Math.abs(s.lon - 10.2039) < 1e-6);
  assert.deepEqual(s.radio, { freq: 869.618, bw: 62.5, sf: 8, cr: 8 });
  assert.equal(s.name, "Thomas' companion");
  // The wrong parser rejects the frame
  assert.equal(parseDeviceInfo(frames[1]), null);
  assert.equal(parseSelfInfo(frames[0]), null);
  // A text CLI reply contains '>' too but never forms a plausible frame
  assert.deepEqual(parseCompanionFrames(new TextEncoder().encode("  -> > 869.618,62.5,8,8\r\n")), []);
});

// --- Companion rules -------------------------------------------------------------

import { evaluateCompanion, hex, scopeKeyFor, commandText } from "../automagical/checks.js";
import { parseDefaultScope, setDefaultScopePayload, setPathHashModePayload } from "../automagical/serial.js";

test("companion: scope key derivation and frame payloads", async () => {
  const key = await scopeKeyFor("dk");
  assert.equal(hex(key), "4a447e7539b0418bd14cf28aa8241529"); // first 16 bytes of SHA-256("#dk")
  const p = setDefaultScopePayload("dk", key);
  assert.equal(p.length, 48);
  assert.equal(p[0], 63);
  assert.deepEqual([...p.slice(1, 4)], [0x64, 0x6b, 0x00]); // "dk" + NUL padding
  assert.equal(hex(p.slice(32)), hex(key));
  assert.deepEqual([...setPathHashModePayload(1)], [61, 0, 1]);
  // The GET reply round-trips
  const reply = new Uint8Array(48); reply[0] = 28; reply.set(p.slice(1), 1);
  assert.deepEqual(parseDefaultScope(reply), { name: "dk", key: hex(key) });
  assert.deepEqual(parseDefaultScope(Uint8Array.from([28])), { name: null, key: null });
  assert.equal(parseDefaultScope(Uint8Array.from([13])), null);
});

test("companion: path.hash.mode and default scope are checked and fixable", async () => {
  const key = await scopeKeyFor("dk");
  const base = { kind: "companion", deviceInfo: { pathHashMode: 1, board: "Heltec V3" }, selfInfo: null };
  // All good
  let f = evaluateCompanion({ ...base, defaultScope: { name: "dk", key: hex(key) } }, key);
  assert.deepEqual(f.map(x => x.id + ":" + x.status), ["path.hash.mode:ok", "region.default:ok"]);
  // Fresh companion: mode 0, no scope
  f = evaluateCompanion({ ...base, deviceInfo: { pathHashMode: 0 }, defaultScope: { name: null, key: null } }, key);
  assert.deepEqual(f.map(x => x.id + ":" + x.status), ["path.hash.mode:change", "region.default:change"]);
  const plan = planCommands(f, new Set(["path.hash.mode", "region.default"]));
  assert.deepEqual(plan.map(commandText), ["CMD_SET_DEFAULT_FLOOD_SCOPE dk (" + hex(key) + ")", "CMD_SET_PATH_HASH_MODE 1"]);
  assert.deepEqual([...plan[1].payload], [61, 0, 1]);
  assert.equal(plan[0].payload[0], 63);
  assert.ok(!needsReboot(plan));
  // Wrong scope name, and right name with a wrong key, both flagged
  assert.equal(evaluateCompanion({ ...base, defaultScope: { name: "eu", key: hex(key) } }, key).find(x => x.id === "region.default").status, "change");
  const wrongKey = evaluateCompanion({ ...base, defaultScope: { name: "dk", key: "00".repeat(16) } }, key).find(x => x.id === "region.default");
  assert.equal(wrongKey.status, "change");
  assert.match(wrongKey.note, /nøglen/);
  // Old firmware: unknown, nothing to send
  f = evaluateCompanion({ ...base, deviceInfo: { pathHashMode: null }, defaultScope: null }, key);
  assert.deepEqual(f.map(x => x.id + ":" + x.status), ["path.hash.mode:unknown", "region.default:unknown"]);
  assert.deepEqual(planCommands(f, new Set(["path.hash.mode", "region.default"])), []);
});


// --- Room servers ------------------------------------------------------------------

test("room server: room password untouched, forwarding rules only with repeat on", () => {
  const room = { ...GOOD, role: "room_server", name: "Odense Rum", guestPassword: "hemmelig", repeat: "off", loopDetect: "off", floodMaxUnscoped: "64" };
  const s = parseState(room);
  assert.equal(s.role, "room_server");
  assert.equal(s.repeat, "off");
  assert.ok(!isRepeater(s));
  assert.ok(!forwards(s));
  const loc = { lat: s.lat, lon: s.lon, source: "device" };
  const f = evaluate(s, loc, scopesForPoint(ds, s.lat, s.lon));
  const ids = f.map(x => x.id);
  assert.ok(!ids.includes("guest.password"), "room password is not a finding");
  assert.ok(!ids.includes("repeat"), "repeat is not recommended on for a room server");
  assert.ok(!ids.includes("loop.detect") && !ids.includes("flood.max.unscoped"), "forwarding rules skipped when repeat is off");
  for (const id of ["radio", "dutycycle", "path.hash.mode", "advert.interval", "flood.advert.interval", "location", "gps.advert", "region.default", "regions", "owner.info"]) assert.ok(ids.includes(id), id);
  assert.deepEqual(f.filter(x => x.status !== "ok"), [], "a well-configured room server has nothing to change");
  // Same room server with repeat on: the forwarding rules apply and flag off/64
  const fwd = evaluate(parseState({ ...room, repeat: "on" }), loc, scopesForPoint(ds, s.lat, s.lon));
  assert.equal(fwd.find(x => x.id === "loop.detect").status, "change");
  assert.deepEqual(fwd.find(x => x.id === "flood.max.unscoped").commands, ["set flood.max.unscoped 15"]);
  assert.ok(!fwd.some(x => x.id === "guest.password"));
});

test("repeater with repeat off gets 'set repeat on'; firmware without 'get repeat' is treated as forwarding", () => {
  const f = evaluate(parseState({ ...GOOD, repeat: "off" }), null, null);
  assert.deepEqual(f.find(x => x.id === "repeat").commands, ["set repeat on"]);
  assert.ok(f.some(x => x.id === "loop.detect"), "forwarding rules still shown for a repeater");
  const old = evaluate(parseState({ ...GOOD, repeat: null }), null, null);
  assert.ok(!old.some(x => x.id === "repeat"));
  assert.ok(old.some(x => x.id === "loop.detect"));
  assert.equal(roleLabel("room_server"), "Room server");
  assert.equal(roleLabel(null), "ukendt");
});

// --- Extra regions (replace instead of add) ------------------------------------------

test("extra regions: opt-in removal row with def-first, remove, save-last ordering", () => {
  const loc = { lat: 55.325, lon: 10.49, source: "device" };
  const sc = scopesForPoint(ds, loc.lat, loc.lon);
  const s = parseState({ ...GOOD, regionsAllowed: GOOD.regionsAllowed + ",dk-jylland,dk-jylland-x", regionsDenied: "dk-old" });
  const f = evaluate(s, loc, sc);
  const regions = f.find(x => x.id === "regions"), extra = f.find(x => x.id === "regions.extra");
  assert.equal(regions.status, "ok");
  assert.ok(!/fjernes ikke/.test(regions.note));
  assert.equal(extra.status, "change");
  assert.equal(extra.optIn, true, "unticked by default");
  assert.equal(extra.current, "dk-jylland, dk-jylland-x, dk-old"); // denied extras count too
  const cmds = extra.commands;
  assert.ok(cmds[0].startsWith("region def eu|* europe|eu dk "), "region def first (re-parents wanted regions)");
  const rm = cmds.find(c => typeof c === "object" && c.remove);
  assert.deepEqual(rm.remove, ["dk-jylland", "dk-jylland-x", "dk-old"]);
  assert.equal(cmds.at(-1), "region save");
  // Selected together with other findings, "region save" is deduplicated and moved last
  const plan = planCommands(f, new Set(["regions", "regions.extra", "dutycycle"]));
  assert.equal(plan.filter(c => c === "region save").length, 1);
  assert.equal(plan.at(-1), "region save");
  assert.ok(plan.findIndex(c => typeof c === "object" && c.remove) > plan.findIndex(c => typeof c === "string" && c.startsWith("region def")));
  // Not selected: nothing about removal in the plan
  const plan2 = planCommands(f, new Set(["dutycycle"]));
  assert.ok(!plan2.some(c => typeof c === "object"));
  // No extras -> no row
  assert.ok(!evaluate(parseState(GOOD), loc, sc).some(x => x.id === "regions.extra"));
  // Ancient firmware: reported but unsupported
  const old = evaluate(parseState({ ...GOOD, ver: "v1.9.0", regionsAllowed: GOOD.regionsAllowed + ",dk-x" }), loc, sc).find(x => x.id === "regions.extra");
  assert.equal(old.status, "unsupported");
});
