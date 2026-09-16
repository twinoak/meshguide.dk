// data.js - loads the site's JSON data from disk (Node only).
//
// The browser does the equivalent with fetch() in lib/flow.js; the build step and
// the tests use this.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJSON(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

// { regions, cities, postnumreFiles } - postnumreFiles in manifest order.
export function loadData() {
  const regions = readJSON("regions.json");
  const cities = readJSON("cities.json");
  const manifest = readJSON("postnumre/index.json");
  const postnumreFiles = [];
  for (const f of manifest.files || []) {
    postnumreFiles.push(readJSON(join("postnumre", f.file)));
  }
  return { regions, cities, postnumreFiles };
}
