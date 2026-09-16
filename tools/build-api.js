#!/usr/bin/env node
// build-api.js - assembles the deployable site in an output directory.
//
//   node tools/build-api.js _site
//
// Copies the static site files and generates the static API from the same
// JSON data and the same lib/scopes.js the browser uses:
//
//   api/scopes.json          { "scopes": [...], "count": N }   (was /api/scopes?all)
//   api/chats.json           { "chats": [...] }                (was /api/chats?all)
//   api/chats/<alias>.json   { "chat": {...} }                 (was /api/chats?chat=<alias>)
//
// Everything is a pure function of regions.json, cities.json and postnumre/*,
// so the output is deterministic and can be rebuilt from any checkout.

import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { allScopes, buildDataset } from "../lib/scopes.js";
import { allChats, chatAliases } from "./chats.js";
import { ROOT, loadData } from "./data.js";

const out = resolve(process.argv[2] || "_site");

if (out === ROOT || ROOT.startsWith(out + "/") || ROOT.startsWith(out + "\\")) {
  console.error("refusing to build into the repo root");
  process.exit(1);
}

// Top-level entries that are part of the repo but not of the site.
const EXCLUDE = new Set([
  ".git", ".github", ".gitignore", ".claude", ".qwen", ".DS_Store",
  "node_modules", "package.json", "package-lock.json", "tools", "_site"
]);

function writeJSON(rel, value) {
  const path = join(out, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value) + "\n");
}

// A lookup alias becomes a file name, so it must be one path segment without
// characters that mean something in a URL or on a filesystem.
const SAFE_ALIAS = /^[\p{L}\p{N}._-]+$/u;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const name of readdirSync(ROOT)) {
  if (EXCLUDE.has(name) || join(ROOT, name) === out) continue;
  cpSync(join(ROOT, name), join(out, name), { recursive: true });
}

const { regions, cities, postnumreFiles } = loadData();
const ds = buildDataset(regions, postnumreFiles);

const scopes = allScopes(ds);
writeJSON("api/scopes.json", { scopes, count: scopes.length });

const chats = allChats(cities, postnumreFiles);
writeJSON("api/chats.json", { chats });

let files = 0;
const skipped = [];
for (const [alias, chat] of chatAliases(cities, postnumreFiles)) {
  if (!SAFE_ALIAS.test(alias)) { skipped.push(alias); continue; }
  writeJSON(join("api/chats", alias + ".json"), { chat });
  files++;
}

console.log(`${out}: ${scopes.length} scopes, ${chats.length} chats, ${files} chat lookup files`);
if (skipped.length) console.log("skipped aliases (not file-name safe): " + skipped.map(s => JSON.stringify(s)).join(", "));
