// Tests for the automagical rules (automagical/checks.js) and the CLI reply
// parser (automagical/serial.js). Reply strings are in the exact formats the
// MeshCore repeater firmware produces (src/helpers/CommonCLI.cpp).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, scopesForPoint } from "../scopes.js";
import { loadData } from "./data.js";
import { evaluate, floodAdvertIntervalFor, hasDeviceLocation, needsReboot, parseState, parseVersion, planCommands, versionAtLeast } from "../automagical/checks.js";
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
  const r3 = evaluate(extra, loc, sc).find(x => x.id === "regions");
  assert.equal(r3.status, "ok");
  assert.match(r3.note, /dk-jylland/);
  // Unknown current regions -> still offered as a change (region def is idempotent)
  const unk = parseState({ ...GOOD, regionsAllowed: null });
  assert.equal(evaluate(unk, loc, sc).find(x => x.id === "regions").status, "change");
});

test("firmware without GPS support hides the advert-position finding", () => {
  const s = parseState({ ...GOOD, gpsAdvert: null });
  const f = evaluate(s, { lat: s.lat, lon: s.lon, source: "device" }, scopesForPoint(ds, s.lat, s.lon));
  assert.ok(!f.some(x => x.id === "gps.advert"));
});
