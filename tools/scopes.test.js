// Regression tests for the scope engine and the chat registry.
//
//   npm test
//
// The point fixtures are the exact responses of the former PHP API
// (api/scopes.php, September 2026) for the same points, so the JS port is
// pinned to the behaviour the site had before it went fully static. If a rule
// is changed on purpose, update the fixtures here in the same commit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { allScopes, buildDataset, regionDefLines, scopesForPoint } from "../lib/scopes.js";
import { allChats, chatAliases } from "./chats.js";
import { loadData } from "./data.js";

const { regions, cities, postnumreFiles } = loadData();
const ds = buildDataset(regions, postnumreFiles);

const put = scopes => scopes.map(s => `region put ${s}\nregion allowf ${s}`).join("\n") + "\nregion save";

const POINTS = [
  {
    name: "Odense centre - region + city region + postal code, with neighbors",
    lat: 55.3959, lon: 10.3883,
    hits: ["dk-fyn-odense", "dk-fyn", "dk5000"],
    scopes: ["dk-fyn-odense", "dk-fyn", "dk5", "dk50", "dk52", "dk53", "dk54", "dk500", "dk5000"],
    def: "region def eu|* europe|eu dk dk-fyn-odense|dk dk-fyn|dk dk5|dk dk50|dk dk52|dk dk53|dk dk54|dk dk500|dk dk5000\nregion save"
  },
  {
    name: "Nyborg - dk42 (Korsør, Sjælland file) is a neighbor across Storebælt",
    lat: 55.3154, lon: 10.7961,
    hits: ["dk-fyn-nyborg", "dk-fyn", "dk5800"],
    scopes: ["dk-fyn-nyborg", "dk-fyn", "dk5", "dk42", "dk53", "dk55", "dk58", "dk580", "dk5800"],
    def: "region def eu|* europe|eu dk dk-fyn-nyborg|dk dk-fyn|dk dk5|dk dk42|dk dk53|dk dk55|dk dk58|dk dk580|dk dk5800\nregion save"
  },
  {
    name: "Aarhus - regions only (no postal code data for Jylland yet)",
    lat: 56.1629, lon: 10.2039,
    hits: ["dk-aarhus", "dk-mj", "dk-oj", "dk-jylland"],
    scopes: ["dk-aarhus", "dk-mj", "dk-oj", "dk-jylland"],
    def: "region def eu|* europe|eu dk dk-aarhus|dk dk-mj|dk dk-oj|dk dk-jylland\nregion save"
  },
  {
    name: "Copenhagen - overlapping regions incl. oresund/se12",
    lat: 55.6760916, lon: 12.568838,
    hits: ["dk-sjl", "se12", "oresund", "dk-kbh"],
    scopes: ["dk-sjl", "se12", "oresund", "dk-kbh"],
    def: "region def eu|* europe|eu dk dk-sjl|dk se12|dk oresund|dk dk-kbh\nregion save"
  }
];

for (const p of POINTS) {
  test(p.name, () => {
    const res = scopesForPoint(ds, p.lat, p.lon);
    assert.equal(res.lat, p.lat);
    assert.equal(res.lon, p.lon);
    assert.deepEqual(res.hits, p.hits);
    assert.deepEqual(res.scopes, p.scopes);
    assert.equal(res.cli.firmware_1_16_0_plus, p.def);
    assert.equal(res.cli.firmware_1_12_0_to_1_15_0, put(["eu", "europe", "dk", ...p.scopes]));
    assert.deepEqual(res.features.features.map(f => f.properties.region), p.hits);
    for (const f of res.features.features) assert.ok(f.geometry && f.geometry.type);
  });
}

test("a point outside every polygon gives empty hits and no CLI", () => {
  const res = scopesForPoint(ds, 56, 6);
  assert.deepEqual(res, {
    lat: 56, lon: 6, hits: [], scopes: [], cli: null,
    features: { type: "FeatureCollection", features: [] }
  });
});

test("the scope universe is sorted, unique and contains the fixed scopes and every prefix layer", () => {
  const all = allScopes(ds);
  assert.deepEqual(all, [...new Set(all)].sort());
  for (const s of ["eu", "europe", "dk", "dk5", "dk50", "dk500", "dk5000", "dk-fyn", "dk-kbh"]) assert.ok(all.includes(s), s);
  assert.equal(all.length, 425);
});

test("region def lines are split at the 160-byte limit exactly like the PHP engine did", () => {
  const input = ["eu", "europe", "dk", "dk72", "dk-cymcvmpduqq", "dk3191", "dk-zbp", "dk-qamcibgiieftsi", "dk-sgclwsenlxydf",
    "dk-sonv", "dk63", "dk-qtmwudcuchem", "dk-zijtagkgf", "dk-raihrlzig", "dk-idicqgjt", "dk2", "dk3362", "dk-vyurvedubv",
    "dk-ndqvsxaunzfsi", "dk-pijcbxsio", "dk-amnsqvxfow", "dk13", "dk-ngnv", "dk9922", "dk8273"];
  const lines = regionDefLines(input);
  assert.deepEqual(lines, [
    "region def eu|* europe|eu dk dk72|dk dk-cymcvmpduqq|dk dk3191|dk dk-zbp|dk dk-qamcibgiieftsi|dk dk-sgclwsenlxydf|dk dk-sonv|dk dk63|dk dk-qtmwudcuchem|dk",
    "region def eu|dk dk-zijtagkgf|dk dk-raihrlzig|dk dk-idicqgjt|dk dk2|dk dk3362|dk dk-vyurvedubv|dk dk-ndqvsxaunzfsi|dk dk-pijcbxsio|dk dk-amnsqvxfow|dk dk13|dk",
    "region def eu|dk dk-ngnv|dk dk9922|dk dk8273"
  ]);
  for (const l of lines) assert.ok(new TextEncoder().encode(l).length <= 160, l);
});

test("chat registry: city chats first, then postal layers, colliding keys resolved in favour of the city", () => {
  const chats = allChats(cities, postnumreFiles);
  assert.equal(chats.length, 410);
  assert.deepEqual(chats.slice(0, Object.keys(cities).length).map(c => c.key), Object.keys(cities));
  assert.equal(new Set(chats.map(c => c.key)).size, chats.length);
  const dk5000 = chats.find(c => c.key === "dk5000");
  assert.deepEqual(dk5000, {
    key: "dk5000", name: "dk5000", scope: "dk5000", localChat: "#dk5000",
    geometry: { type: "Point", coordinates: [10.401, 55.4216] }
  });
  assert.ok(chats.some(c => c.key === "dk5"), "aggregate layer dk5");
  assert.ok(chats.some(c => c.key === "dk50"), "aggregate layer dk50");
});

test("chat lookup aliases: key, handle, name, digits", () => {
  const a = chatAliases(cities, postnumreFiles);
  assert.equal(a.get("odense").key, "odense");
  assert.equal(a.get("dk-fyn-odense").key, "odense"); // handle without #
  assert.equal(a.get("dk").key, "dk");
  assert.equal(a.get("danmark").key, "danmark");
  assert.equal(a.get("Ålborg").key, "aalborg");        // ASCII-only lowercase, as the PHP API matched
  assert.equal(a.get("ålborg").key, "aalborg");        // full lowercase
  assert.equal(a.get("dk5000").key, "dk5000");
  assert.equal(a.get("5000").key, "dk5000");
  assert.equal(a.get("dk5").key, "dk5");
  assert.equal(a.get("50").key, "dk50");
  assert.equal(a.get("nowhere"), undefined);
  assert.equal(a.get("12345"), undefined);
});
