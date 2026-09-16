// Tests for the configurator's rules (lib/checks.js) and the CLI reply
// parser (lib/serial.js). Reply strings are in the exact formats the
// MeshCore repeater firmware produces (src/helpers/CommonCLI.cpp).

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset, scopesForPoint } from "../lib/scopes.js";
import { loadData } from "./data.js";
import { DEFAULTS_ANCHOR, NAME_MAX_BYTES, PASSWORD_MAX_BYTES, READ_COMMANDS, UNSUPPORTED, delaysFor, parseNeighbours, passwordProblem, clockDriftText, evaluate, floodAdvertIntervalFor, formatDanishTime, formatLatLon, forwards, hasDeviceLocation, isRepeater, nameProblem, needsReboot, parseClock, parseState, parseVersion, planCommands, roleLabel, versionAtLeast } from "../lib/checks.js";
import { parseReply, setAdvertNamePayload } from "../lib/serial.js";

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
  cad: "off",
  rxGain: "on",
  femRxGain: "off",
  agcResetInterval: "4",
  rxdelay: "3",
  txdelay: "1.2",
  directTxdelay: "0.6",
  neighbours: "a1b2c3d4:120:14\nb2c3d4e5:3600:2\nc3d4e5f6:86400:-8",   // two with SNR > 0, one negative
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
  assert.equal(s.dutycycle, 10);
  assert.equal(s.regionDefault, "dk");
  assert.equal(s.regionsAllowed.length, 15);
  assert.ok(hasDeviceLocation(s));
  assert.equal(parseState({ ...GOOD, lat: "0.0", lon: "0.0" }).lat, 0);
  assert.ok(!hasDeviceLocation(parseState({ ...GOOD, lat: "0.0", lon: "0.0" })));
  assert.equal(parseState({ ...GOOD, regionsAllowed: "-none-" }).regionsAllowed.length, 0);
  assert.equal(parseState({ ...GOOD, regionsAllowed: null }).regionsAllowed, null);
  assert.equal(parseState({ ...GOOD, regionDefault: " default scope is <null>" }).regionDefault, "<null>");
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
    cad: "on", rxGain: "off", femRxGain: "on", agcResetInterval: "0", rxdelay: "0", txdelay: "0.5", directTxdelay: "0.1999999", neighbours: "-none-", regionDefault: " default scope is <null>", regionsAllowed: "-none-", regionTree: "* F"
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
  assert.ok(!byId["gps.advert"] && !byId.repeat, "no advert-position or repeat rows");
  assert.deepEqual(byId.cad.commands, ["set cad off"]);
  assert.deepEqual(byId["radio.rxgain"].commands, ["set radio.rxgain on"]);
  assert.deepEqual(byId["radio.fem.rxgain"].commands, ["set radio.fem.rxgain off"]);
  assert.deepEqual(byId["agc.reset.interval"].commands, ["set agc.reset.interval 4"]);
  assert.deepEqual(byId.rxdelay.commands, ["set rxdelay 2"]);
  assert.deepEqual(byId.txdelay.commands, ["set txdelay 1"]);
  assert.deepEqual(byId["direct.txdelay"].commands, ["set direct.txdelay 0.4"]);
  assert.equal(byId["direct.txdelay"].current, "0.2", "the firmware's 0.1999999 is shown as 0.2");
  for (const id of ["rxdelay", "txdelay", "direct.txdelay"]) assert.equal(byId[id].note, "Relevante naboer: 0", id);
  assert.equal(byId["advert.interval"].label, "advert.interval");
  assert.equal(byId["flood.advert.interval"].label, "flood.advert.interval");
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
  assert.ok(plan.indexOf("set flood.max.unscoped 15") < plan.indexOf("set cad off") && plan.indexOf("set cad off") < plan.indexOf("set agc.reset.interval 4"), "the receiver settings come after the forwarding rules");
  assert.ok(!needsReboot(plan));
  // Deselecting a finding drops its commands.
  const partial = planCommands(f, new Set(["location", "regions"]));
  assert.deepEqual(partial, ["set lat 55.325000", "set lon 10.490000", ...byId.regions.commands]);
});

test("wrong radio preset -> set radio with the default CR 8, needs reboot; a right preset keeps its CR", () => {
  const s = parseState({ ...GOOD, radio: "868.0,125,7,5" });
  const f = evaluate(s, { lat: s.lat, lon: s.lon, source: "device" }, scopesForPoint(ds, s.lat, s.lon));
  const radio = f.find(x => x.id === "radio");
  assert.equal(radio.status, "change");
  assert.deepEqual(radio.commands, ["set radio 869.618,62.5,8,8"]);
  assert.ok(needsReboot(planCommands(f, new Set(["radio"]))));
  // The preset is right and CR is a per-node choice within 5-8: fine as-is, shown as-is.
  const cr6 = evaluate(parseState({ ...GOOD, radio: "869.618,62.5,8,6" }), null, null).find(x => x.id === "radio");
  assert.equal(cr6.status, "ok");
  assert.equal(cr6.recommended, "869.618 MHz · BW 62.5 kHz · SF 8 · CR 4/6");
  // CR outside 5-8 is not a valid LoRa setting: back to 8.
  assert.deepEqual(evaluate(parseState({ ...GOOD, radio: "869.618,62.5,8,4" }), null, null).find(x => x.id === "radio").commands, ["set radio 869.618,62.5,8,8"]);
});

test("the device clock: CLI reply parsed, shown as Danish time incl. summer/winter time, drift in words", () => {
  assert.equal(parseClock("18:07 - 16/9/2026 UTC"), Date.UTC(2026, 8, 16, 18, 7) / 1000);
  assert.equal(parseClock("08:05 - 1/1/2027 UTC"), Date.UTC(2027, 0, 1, 8, 5) / 1000);
  assert.equal(parseClock("> 22"), null);
  assert.equal(parseClock(null), null);
  assert.equal(formatDanishTime(Date.UTC(2026, 6, 1, 12, 0) / 1000), "01.07.2026 14:00");  // CEST
  assert.equal(formatDanishTime(Date.UTC(2026, 0, 15, 12, 0) / 1000), "15.01.2026 13:00"); // CET
  assert.equal(formatDanishTime(Date.UTC(2026, 9, 25, 0, 59) / 1000), "25.10.2026 02:59"); // last minute of summer time
  assert.equal(formatDanishTime(Date.UTC(2026, 9, 25, 1, 0) / 1000), "25.10.2026 02:00");  // first minute of winter time
  const now = 1789580000;
  const min = Math.floor(now / 60) * 60;                             // the CLI reply is cut to the minute; so is our side
  assert.equal(clockDriftText(min, now, "minute"), "passer");
  assert.equal(clockDriftText(min - 60, now, "minute"), "passer");     // the minute ticked over between the device and us
  assert.equal(clockDriftText(min - 120, now, "minute"), "2 min bagud");
  assert.equal(clockDriftText(min + 60, now, "minute"), "1 min foran");
  assert.equal(clockDriftText(min - 3600, now, "minute"), "1 t 0 min bagud");
  assert.equal(clockDriftText(now + 4, now, "second"), "passer");
  assert.equal(clockDriftText(now - 6, now, "second"), "6 s bagud");
  assert.equal(clockDriftText(now + 4500, now, "second"), "1 t 15 min foran");
  assert.equal(clockDriftText(now - 86400 * 845, now, "second"), "845 d bagud");
  assert.equal(READ_COMMANDS.clock, "clock");
  assert.equal(READ_COMMANDS.tx, undefined);
  assert.equal(parseState({ ...GOOD, clock: "18:07 - 16/9/2026 UTC" }).clock, Date.UTC(2026, 8, 16, 18, 7) / 1000);
  assert.equal(parseState(GOOD).txPower, undefined);
});

test("the admin password follows the firmware's size: 15 bytes; no blank or padded passwords", () => {
  assert.equal(passwordProblem("hemmelig1"), null);
  assert.equal(passwordProblem("a".repeat(PASSWORD_MAX_BYTES)), null);
  assert.match(passwordProblem(""), /tom/);
  assert.match(passwordProblem(" x"), /mellemrum/);
  assert.match(passwordProblem("x "), /mellemrum/);
  assert.equal(passwordProblem("min kode"), null);
  assert.match(passwordProblem("a".repeat(16)), /15 tegn/);
  assert.match(passwordProblem("æøåæøåæøå"), /15 tegn/); // 9 characters, 18 bytes
});

test("positions are shown with Danish compass letters, commands stay lat/lon", () => {
  assert.equal(formatLatLon(55.325, 10.49), "55.325° N, 10.49° Ø");
  assert.equal(formatLatLon("56.1963043", "10.2408895"), "56.1963043° N, 10.2408895° Ø");
  assert.equal(formatLatLon(-33.9, -70.6), "33.9° S, 70.6° V");
  const f = evaluate(parseState(GOOD), { lat: 55.325, lon: 10.49, source: "map" }, scopesForPoint(ds, 55.325, 10.49)).find(x => x.id === "location");
  assert.equal(f.label, "Position");
  assert.equal(f.recommended, "55.325000° N, 10.490000° Ø");
  assert.deepEqual(f.commands, ["set lat 55.325000", "set lon 10.490000"]);
});

test("device names follow the firmware's rule: 31 bytes, no [ ] \\ : , ? *", () => {
  assert.equal(nameProblem("Bakketoppen"), null);
  assert.equal(nameProblem("OZ1ABC Rpt #2"), null);
  assert.match(nameProblem(""), /tomt/);
  assert.match(nameProblem("   "), /tomt/);
  assert.match(nameProblem("a,b"), /ikke indeholde/);
  assert.match(nameProblem("a:b"), /ikke indeholde/);
  assert.match(nameProblem("[x]"), /ikke indeholde/);
  assert.equal(nameProblem("a".repeat(31)), null);
  assert.match(nameProblem("a".repeat(32)), /31 tegn/);
  assert.equal(nameProblem("Bakketoppen på Djursland ÆØ"), null);    // 27 characters, 30 bytes
  assert.match(nameProblem("Bakketoppen på Djursland ÆØÅ"), /31 tegn/); // 28 characters, 32 bytes
  assert.equal(nameProblem("x".repeat(NAME_MAX_BYTES)), null);
  const p = setAdvertNamePayload("Min companion");
  assert.equal(p[0], 8);
  assert.equal(new TextDecoder().decode(p.slice(1)), "Min companion");
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

test("cad, rxgain, fem rxgain and agc.reset.interval: an unsupported setting is left out, not shown", () => {
  const loc = { lat: 55.325, lon: 10.49, source: "device" };
  // A board without a front-end module answers "Error: unsupported": no row at all.
  const noFem = evaluate(parseState({ ...GOOD, femRxGain: UNSUPPORTED }), loc, scopesForPoint(ds, loc.lat, loc.lon));
  assert.ok(!noFem.some(x => x.id === "radio.fem.rxgain"));
  assert.ok(noFem.some(x => x.id === "radio.rxgain"), "the others stay");
  // Older firmware: "unknown config" for all four (and the delays) -> none of them shown, nothing planned.
  const old = evaluate(parseState({ ...GOOD, cad: UNSUPPORTED, rxGain: UNSUPPORTED, femRxGain: UNSUPPORTED, agcResetInterval: UNSUPPORTED, rxdelay: UNSUPPORTED, txdelay: UNSUPPORTED, directTxdelay: UNSUPPORTED }), loc, scopesForPoint(ds, loc.lat, loc.lon));
  for (const id of ["cad", "radio.rxgain", "radio.fem.rxgain", "agc.reset.interval", "rxdelay", "txdelay", "direct.txdelay"]) assert.ok(!old.some(x => x.id === id), id);
  assert.ok(!planCommands(old, new Set(old.map(x => x.id))).some(c => /cad|rxgain|agc|delay/.test(commandText(c))));
  // No reply at all -> "Kunne ikke aflæses".
  assert.equal(evaluate(parseState({ ...GOOD, cad: null }), loc, scopesForPoint(ds, loc.lat, loc.lon)).find(x => x.id === "cad").status, "unknown");
  // agc.reset.interval 8 is not 4.
  assert.deepEqual(evaluate(parseState({ ...GOOD, agcResetInterval: "8" }), loc, scopesForPoint(ds, loc.lat, loc.lon)).find(x => x.id === "agc.reset.interval").commands, ["set agc.reset.interval 4"]);
  // Every finding that has a page section links to it.
  const ids = evaluate(parseState(GOOD), loc, scopesForPoint(ds, loc.lat, loc.lon)).map(x => x.id);
  for (const id of ids) assert.ok(DEFAULTS_ANCHOR[id], "anchor for " + id);
});

test("rxdelay / txdelay / direct.txdelay follow the white paper's table on the neighbours heard with SNR > 0 within 7 days", () => {
  // The neighbours reply: id:seconds:snr×4 per line, "-none-" when empty.
  assert.deepEqual(parseNeighbours("-none-"), { count: 0, total: 0, truncated: false });
  assert.deepEqual(parseNeighbours("a1b2c3d4:120:14\nb2c3d4e5:3600:2\nc3d4e5f6:86400:-8"), { count: 2, total: 3, truncated: false });
  assert.deepEqual(parseNeighbours("a1b2c3d4:120:14\nb2c3d4e5:" + (8 * 86400) + ":20"), { count: 1, total: 2, truncated: false }, "heard 8 days ago does not count");
  assert.deepEqual(parseNeighbours("a1b2c3d4:120:0"), { count: 0, total: 1, truncated: false }, "SNR 0 is not > 0");
  assert.equal(parseNeighbours(null), null);
  // The firmware stops adding lines at 134 characters: such a reply is a lower bound.
  const long = Array.from({ length: 8 }, (_, i) => "0000000" + i + ":100000:12").join("\n"); // 8 x 18 chars + 7 newlines = 151
  assert.ok(long.length >= 134);
  assert.deepEqual(parseNeighbours(long), { count: 8, total: 8, truncated: true });
  // The table.
  assert.deepEqual(delaysFor(0), { txdelay: 1.0, directTxdelay: 0.4, rxdelay: 2 });
  assert.deepEqual(delaysFor(3), { txdelay: 1.2, directTxdelay: 0.6, rxdelay: 3 });
  assert.deepEqual(delaysFor(8), { txdelay: 1.7, directTxdelay: 0.8, rxdelay: 4 });
  assert.deepEqual(delaysFor(10), { txdelay: 1.9, directTxdelay: 0.9, rxdelay: 6 });
  assert.deepEqual(delaysFor(11), { txdelay: 2.0, directTxdelay: 0.9, rxdelay: 7 });
  assert.deepEqual(delaysFor(12), { txdelay: 2.0, directTxdelay: 0.9, rxdelay: 8 });
  assert.deepEqual(delaysFor(40), delaysFor(12), "12+ is the top tier");
  // GOOD has 2 neighbours with SNR > 0 -> 1.2 / 0.6 / 3, which it already has.
  const loc = { lat: 55.325, lon: 10.49, source: "device" };
  const f = evaluate(parseState(GOOD), loc, scopesForPoint(ds, loc.lat, loc.lon));
  for (const id of ["rxdelay", "txdelay", "direct.txdelay"]) assert.equal(f.find(x => x.id === id).status, "ok", id);
  assert.equal(f.find(x => x.id === "rxdelay").note, "Relevante naboer: 2");
  // Float noise from the firmware's ftoa is not a difference.
  assert.equal(evaluate(parseState({ ...GOOD, txdelay: "1.199999" }), loc, scopesForPoint(ds, loc.lat, loc.lon)).find(x => x.id === "txdelay").status, "ok");
  // A truncated list: the count is a minimum, and the note says so.
  const tf = evaluate(parseState({ ...GOOD, neighbours: long }), loc, scopesForPoint(ds, loc.lat, loc.lon));
  assert.equal(tf.find(x => x.id === "txdelay").recommended, "1.7");
  for (const id of ["rxdelay", "txdelay", "direct.txdelay"]) assert.equal(tf.find(x => x.id === id).note, "Relevante naboer: ≥ 8", id);
  // No neighbour list (old firmware or no reply): the rows are there but without a recommendation.
  for (const nb of [UNSUPPORTED, null]) {
    const u = evaluate(parseState({ ...GOOD, neighbours: nb }), loc, scopesForPoint(ds, loc.lat, loc.lon)).find(x => x.id === "rxdelay");
    assert.equal(u.status, "unknown");
    assert.equal(u.recommended, "–");
    assert.deepEqual(u.commands, []);
    assert.match(u.note, /Nabolisten kunne ikke hentes/);
  }
  // Plan order: the delays come after the receiver settings, before the radio.
  const fresh = evaluate(parseState({ ...GOOD, rxdelay: "0", txdelay: "0.5", directTxdelay: "0.2", agcResetInterval: "0", radio: "868.0,125,7,5" }), loc, scopesForPoint(ds, loc.lat, loc.lon));
  const plan = planCommands(fresh, new Set(fresh.map(x => x.id))).map(commandText);
  assert.ok(plan.indexOf("set agc.reset.interval 4") < plan.indexOf("set rxdelay 3") && plan.indexOf("set rxdelay 3") < plan.indexOf("set txdelay 1.2") && plan.indexOf("set direct.txdelay 0.6") < plan.indexOf("set radio 869.618,62.5,8,8"), plan.join(" | "));
});

// --- Companion (binary) protocol -------------------------------------------------

import { companionFrame, parseCompanionFrames, parseDeviceInfo, parseSelfInfo } from "../lib/serial.js";

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

import { evaluateCompanion, hex, scopeKeyFor, commandText } from "../lib/checks.js";
import { parseDefaultScope, setDefaultScopePayload, setPathHashModePayload } from "../lib/serial.js";

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
  for (const id of ["radio", "dutycycle", "path.hash.mode", "advert.interval", "flood.advert.interval", "location", "region.default", "regions", "owner.info", "cad", "radio.rxgain", "radio.fem.rxgain", "agc.reset.interval", "rxdelay", "txdelay", "direct.txdelay"]) assert.ok(ids.includes(id), id);
  assert.deepEqual(f.filter(x => x.status !== "ok"), [], "a well-configured room server has nothing to change");
  // Same room server with repeat on: the forwarding rules apply and flag off/64
  const fwd = evaluate(parseState({ ...room, repeat: "on" }), loc, scopesForPoint(ds, s.lat, s.lon));
  assert.equal(fwd.find(x => x.id === "loop.detect").status, "change");
  assert.deepEqual(fwd.find(x => x.id === "flood.max.unscoped").commands, ["set flood.max.unscoped 15"]);
  assert.ok(!fwd.some(x => x.id === "guest.password"));
});

test("repeat is read but not a finding; a repeater keeps the forwarding rules whatever repeat says", () => {
  const f = evaluate(parseState({ ...GOOD, repeat: "off" }), null, null);
  assert.ok(!f.some(x => x.id === "repeat"));
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

// --- Remote configuration through a companion (lib/remote-cli.js + serial.js) ---
import { formatRadio, lockFindings, REMOTE_LOCKED } from "../lib/checks.js";
import { addContactPayload, decodePathLen, extractFrames, loginPayload, nodeDiscoverPayload, parseAck, parseContact, parseContactMessage, parseCurrTime, parseDiscoverResponse, parseSent, setDeviceTimePayload, textMessagePayload } from "../lib/serial.js";

test("radio settings are shown human-readably, commands stay in CLI form", () => {
  assert.equal(formatRadio("869.618,62.5,8,8"), "869.618 MHz · BW 62.5 kHz · SF 8 · CR 4/8");
  assert.equal(formatRadio({ freq: 869.525, bw: 250, sf: 11, cr: 5 }), "869.525 MHz · BW 250 kHz · SF 11 · CR 4/5");
  assert.equal(formatRadio("garbage"), "garbage");
  assert.equal(formatRadio(null), "–");
  const f = evaluate(parseState({ ...GOOD, radio: "868.0,125,7,5" }), null, null).find(x => x.id === "radio");
  assert.equal(f.current, "868 MHz · BW 125 kHz · SF 7 · CR 4/5");
  assert.equal(f.recommended, "869.618 MHz · BW 62.5 kHz · SF 8 · CR 4/8");
  assert.deepEqual(f.commands, ["set radio 869.618,62.5,8,8"]);
});

test("remote mode locks the radio: shown as a difference, never planned", () => {
  const s = parseState({ ...GOOD, radio: "868.0,125,7,5", dutycycle: "50.0%" });
  const f = lockFindings(evaluate(s, null, null));
  const radio = f.find(x => x.id === "radio");
  assert.equal(radio.status, "locked");
  assert.deepEqual(radio.commands, []);
  assert.match(radio.note, /Ændres ikke via mesh/);
  assert.equal(f.find(x => x.id === "dutycycle").status, "change");             // others untouched
  const cmds = planCommands(f, new Set(["radio", "dutycycle"]));
  assert.deepEqual(cmds, ["set dutycycle 10"]);
  assert.ok(!needsReboot(cmds));
  assert.deepEqual([...REMOTE_LOCKED], ["radio"]);
  // an OK radio stays OK
  assert.equal(lockFindings(evaluate(parseState(GOOD), null, null)).find(x => x.id === "radio").status, "ok");
});

test("companion frames: contact list, sent, message and login payloads follow MyMesh.cpp", () => {
  // RESP_CODE_CONTACT as writeContactRespFrame() lays it out
  const c = new Uint8Array(148); const dv = new DataView(c.buffer);
  c[0] = 3; for (let i = 0; i < 32; i++) c[1 + i] = 0xa0 + (i % 16); c[33] = 2; c[34] = 0; c[35] = 0xFF;
  new TextEncoder().encodeInto("Bakketoppen", c.subarray(100, 132));
  dv.setUint32(132, 1789380000, true); dv.setInt32(136, 56162900, true); dv.setInt32(140, 10203900, true); dv.setUint32(144, 1789380001, true);
  const contact = parseContact(c);
  assert.equal(contact.name, "Bakketoppen");
  assert.equal(contact.type, "repeater");
  assert.equal(contact.outPathLen, -1);
  assert.equal(contact.outPathHashSize, null);
  assert.equal(contact.publicKey.slice(0, 4), "a0a1");
  // the path length byte packs the hash size: 0x4A is 10 hops of 2-byte hashes (what the app shows), not 74
  c[35] = 0x4A;
  assert.deepEqual([parseContact(c).outPathLen, parseContact(c).outPathHashSize], [10, 2]);
  assert.deepEqual(decodePathLen(0x00), { hops: 0, hashSize: 1 });
  assert.deepEqual(decodePathLen(0x83), { hops: 3, hashSize: 3 });
  assert.deepEqual(decodePathLen(0xFF), { hops: -1, hashSize: null });
  assert.equal(contact.lat, 56.1629);
  assert.equal(contact.lon, 10.2039);
  assert.equal(contact.lastAdvert, 1789380000);
  assert.equal(parseContact(new Uint8Array(100)), null);
  // RESP_CODE_SENT
  const s = new Uint8Array(10); s[0] = 6; s[1] = 1; new DataView(s.buffer).setUint32(2, 77, true); new DataView(s.buffer).setUint32(6, 4200, true);
  assert.deepEqual(parseSent(s), { flood: true, ack: 77, estTimeoutMs: 4200 });
  const a = new Uint8Array(9); a[0] = 0x82; new DataView(a.buffer).setUint32(1, 77, true); new DataView(a.buffer).setUint32(5, 1234, true);
  assert.deepEqual(parseAck(a), { ack: 77, tripMs: 1234 });
  assert.equal(parseAck(Uint8Array.from([0x83])), null);
  const ct = new Uint8Array(5); ct[0] = 9; new DataView(ct.buffer).setUint32(1, 1789380000, true);
  assert.equal(parseCurrTime(ct), 1789380000);
  // CLI reply as a legacy (7) and a v3 (16) message frame
  const text = new TextEncoder().encode("> 869.618,62.5,8,8");
  const m7 = new Uint8Array(13 + text.length); m7[0] = 7; m7.set([1, 2, 3, 4, 5, 6], 1); m7[7] = 0xFF; m7[8] = 1; new DataView(m7.buffer).setUint32(9, 1789380002, true); m7.set(text, 13);
  const p7 = parseContactMessage(m7);
  assert.deepEqual([p7.prefix, p7.pathLen, p7.txtType, p7.senderTimestamp, p7.text], ["010203040506", -1, 1, 1789380002, "> 869.618,62.5,8,8"]);
  const m16 = new Uint8Array(16 + text.length); m16[0] = 16; m16[1] = 40; m16.set([1, 2, 3, 4, 5, 6], 4); m16[10] = 0x42; m16[11] = 1; new DataView(m16.buffer).setUint32(12, 1789380003, true); m16.set(text, 16);
  const p16 = parseContactMessage(m16);
  assert.deepEqual([p16.prefix, p16.pathLen, p16.txtType, p16.text], ["010203040506", 2, 1, "> 869.618,62.5,8,8"]);
  assert.equal(parseContactMessage(Uint8Array.from([10])), null);
  // CMD_SEND_LOGIN and CMD_SEND_TXT_MSG payloads
  const key = "ab".repeat(32);
  const login = loginPayload(key, "hemmelig");
  assert.equal(login[0], 26);
  assert.equal(login.length, 33 + 8);
  assert.deepEqual([...login.slice(1, 33)], Array(32).fill(0xab));
  assert.equal(new TextDecoder().decode(login.slice(33)), "hemmelig");
  const msg = textMessagePayload(key, "get radio", { attempt: 2, timestamp: 0x01020304 });
  assert.deepEqual([...msg.slice(0, 13)], [2, 0, 2, 4, 3, 2, 1, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab]); // PLAIN by default, little-endian timestamp
  assert.equal(new TextDecoder().decode(msg.slice(13)), "get radio");
  assert.equal(textMessagePayload(key, "x", { txtType: 1 })[1], 1);
  assert.throws(() => textMessagePayload(key, "x".repeat(161)), /for lang/);
  assert.equal(textMessagePayload(key, "x".repeat(160)).length, 173); // MAX_TEXT_LEN fits in a frame
  assert.ok(textMessagePayload(key, "region def " + "dk5230 ".repeat(21).trim()).length <= 176); // a full region def line fits
  const t = setDeviceTimePayload(1789380000);
  assert.deepEqual([t[0], new DataView(t.buffer).getUint32(1, true)], [6, 1789380000]);
});

test("frame stream: partial frames are kept for the next chunk, garbage is skipped", () => {
  const a = Uint8Array.from([0x3E, 3, 0, 1, 2, 3, 0x3E, 4, 0, 9, 9]);      // one full frame, one half frame
  const r1 = extractFrames(a);
  assert.deepEqual(r1.frames.map(f => [...f]), [[1, 2, 3]]);
  assert.deepEqual([...r1.rest], [0x3E, 4, 0, 9, 9]);
  const r2 = extractFrames(Uint8Array.from([...r1.rest, 9, 9, 0x3E, 1, 0, 0x83])); // rest completed, then a push frame
  assert.deepEqual(r2.frames.map(f => [...f]), [[9, 9, 9, 9], [0x83]]);
  assert.equal(r2.rest.length, 0);
  const r3 = extractFrames(Uint8Array.from([0x52, 0x65, 0x3E, 0x20, 0x41, 0x3E, 1, 0, 5])); // "Re> A" text noise, then a frame
  assert.deepEqual(r3.frames.map(f => [...f]), [[5]]);
});

test("repeaters nearby: NODE_DISCOVER_REQ payload, response push, and adding the found key as a contact", () => {
  const req = nodeDiscoverPayload(0x11223344);
  assert.deepEqual([...req], [55, 0x80, 0x04, 0x44, 0x33, 0x22, 0x11, 0, 0, 0, 0]); // repeaters only (1 << ADV_TYPE_REPEATER), since 0
  // PUSH_CODE_CONTROL_DATA carrying a NODE_DISCOVER_RESP from a repeater
  const key = "ab".repeat(32);
  const push = new Uint8Array(4 + 6 + 32);
  push[0] = 0x8E; push[1] = 30; push[2] = (-95 & 0xff); push[3] = 0;          // companion heard it at SNR 7.5, RSSI -95
  push[4] = 0x92; push[5] = (-13 & 0xff);                                    // repeater, heard the request at SNR -3.25
  new DataView(push.buffer).setUint32(6, 0x11223344, true);
  for (let i = 0; i < 32; i++) push[10 + i] = 0xab;
  const r = parseDiscoverResponse(push);
  assert.deepEqual([r.type, r.tag, r.snr, r.rssi, r.reqSnr, r.publicKey], ["repeater", 0x11223344, 7.5, -95, -3.25, key]);
  assert.equal(parseDiscoverResponse(Uint8Array.from([0x8E, 0, 0, 0, 0x80, 4, 1, 2, 3, 4])), null); // a request, not a response
  assert.equal(parseDiscoverResponse(Uint8Array.from([0x83])), null);
  // CMD_ADD_UPDATE_CONTACT: full key, repeater, no path (0xFF), empty name
  const add = addContactPayload(key);
  assert.equal(add.length, 144);
  assert.equal(add[0], 9);
  assert.deepEqual([...add.slice(1, 33)], Array(32).fill(0xab));
  assert.deepEqual([add[33], add[34], add[35]], [2, 0, 0xFF]);
  assert.ok(add.slice(36, 100).every(b => b === 0) && add.slice(100, 132).every(b => b === 0));
});
