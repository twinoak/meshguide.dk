// scopes.js - the scope engine for the MeshCore-DK map.
//
// Pure functions only: no DOM, no fetch, no Node APIs. The same module is
// imported by the browser (flow.js and app.js, on map click) and by the build step
// (tools/build-api.js, which writes the static /api JSON files), so there is
// exactly one source of the scope rules. If a rule changes (NEIGHBOR_DIST_M,
// the layer convention, regionDefLines) it changes HERE.
//
// A "dataset" is the decoded regions.json plus all postnumre/*.json files
// merged, with precomputed bounding boxes - see buildDataset(). The caller
// decides how the JSON gets loaded (fetch in the browser, fs in Node).

export const M_PER_DEG = 111320;      // meters per degree latitude (and longitude at the equator)
export const NEIGHBOR_DIST_M = 2000;  // a postal code is a neighbor if the border lies <= this
export const DEF_LIMIT = 160;         // the repeater's serial line limit, in bytes

// The fixed top-level scopes that are not derived from geometry, with their
// parent in the scope tree: * -> {eu, europe} -> dk -> everything else. 'eu'
// and 'europe' are both in use and redundant (like #dk/#danmark), but both must
// exist. This is the only source of the fixed scopes - both the static
// scopes.json and the CLI blocks read from here.
export const FIXED_SCOPE_PARENTS = Object.freeze({
  eu: "*",
  europe: "*",
  dk: "eu"
});

const POSTAL_KEY = /^dk(\d{4})$/;

// --- Geometry primitives ----------------------------------------------------

export function ringsOf(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return geom.coordinates;
  if (geom.type === "MultiPolygon") {
    const out = [];
    for (const poly of geom.coordinates) for (const ring of poly) out.push(ring);
    return out;
  }
  return [];
}

// [minx, miny, maxx, maxy]; Infinity/-Infinity when the geometry has no points.
export function geomBBox(geom) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const ring of ringsOf(geom)) {
    for (const pt of ring) {
      const x = pt[0], y = pt[1];
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
  }
  return [minx, miny, maxx, maxy];
}

// Ray-casting point-in-polygon. Point and rings in [lng, lat].
function pointInRing(x, y, ring) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(x, y, rings) {
  if (!rings.length) return false;
  if (!pointInRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(x, y, rings[i])) return false; // hole
  }
  return true;
}

export function pointInGeom(x, y, geom) {
  if (!geom) return false;
  if (geom.type === "Polygon") return pointInPolygon(x, y, geom.coordinates);
  if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      if (pointInPolygon(x, y, poly)) return true;
    }
    return false;
  }
  return false;
}

// Distance from point to line segment in meters (local equirectangular projection).
function segDistM(p, a, b, sx, sy) {
  const px = p[0] * sx, py = p[1] * sy;
  const ax = a[0] * sx, ay = a[1] * sy;
  const bx = b[0] * sx, by = b[1] * sy;
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Smallest distance from g1's corners to g2's edges; short-circuits <= limit.
function boundaryDistM(g1, g2, sx, sy, limit) {
  let best = Infinity;
  const r2 = ringsOf(g2);
  for (const ring of ringsOf(g1)) {
    for (const p of ring) {
      for (const ring2 of r2) {
        const m = ring2.length;
        for (let i = 0; i < m - 1; i++) {
          const d = segDistM(p, ring2[i], ring2[i + 1], sx, sy);
          if (d < best) {
            best = d;
            if (best <= limit) return best;
          }
        }
      }
    }
  }
  return best;
}

// --- Dataset ----------------------------------------------------------------

// regions: decoded regions.json. postnumreFiles: the decoded postnumre/*.json
// files in manifest order; on a duplicate key the first file wins.
export function buildDataset(regions, postnumreFiles) {
  const postnumre = {};
  for (const file of postnumreFiles) {
    if (!file || typeof file !== "object") continue;
    for (const [k, v] of Object.entries(file)) {
      if (postnumre[k] === undefined) postnumre[k] = v;
    }
  }
  const rbb = {};
  for (const [k, v] of Object.entries(regions)) {
    if (v && v.geometry) rbb[k] = geomBBox(v.geometry);
  }
  const pbb = {};
  for (const [k, v] of Object.entries(postnumre)) {
    if (v && v.geometry) pbb[k] = geomBBox(v.geometry);
  }
  return { regions, postnumre, rbb, pbb, neighborCache: new Map() };
}

// --- Scope derivation -------------------------------------------------------

// The layer convention for a 4-digit postal code: dk5230 -> dk5, dk52, dk523, dk5230.
export function postalLayers(digits) {
  return ["dk" + digits[0], "dk" + digits.slice(0, 2), "dk" + digits.slice(0, 3), "dk" + digits];
}

// The distinct 2-digit prefixes (dkXY) for postal codes bordering key.
function neighborPrefixesFor(ds, key) {
  const cached = ds.neighborCache.get(key);
  if (cached) return cached;

  const self = ds.postnumre[key];
  if (!self || !self.geometry) {
    ds.neighborCache.set(key, []);
    return [];
  }

  const bb = ds.pbb[key] || geomBBox(self.geometry);
  const refLat = (bb[1] + bb[3]) / 2;
  const sx = M_PER_DEG * Math.cos(refLat * Math.PI / 180);
  const sy = M_PER_DEG;
  const padLon = NEIGHBOR_DIST_M / sx;
  const padLat = NEIGHBOR_DIST_M / sy;

  const seen = new Set();
  for (const [k, e] of Object.entries(ds.postnumre)) {
    if (k === key) continue;
    const m = POSTAL_KEY.exec(k);
    if (!m) continue;
    if (!e || !e.geometry) continue;
    const ob = ds.pbb[k] || geomBBox(e.geometry);
    if (ob[0] > bb[2] + padLon || ob[2] < bb[0] - padLon ||
        ob[1] > bb[3] + padLat || ob[3] < bb[1] - padLat) continue;
    const d = Math.min(
      boundaryDistM(self.geometry, e.geometry, sx, sy, NEIGHBOR_DIST_M),
      boundaryDistM(e.geometry, self.geometry, sx, sy, NEIGHBOR_DIST_M)
    );
    if (d <= NEIGHBOR_DIST_M) seen.add("dk" + m[1].slice(0, 2));
  }
  const res = [...seen].sort();
  ds.neighborCache.set(key, res);
  return res;
}

// Expands a hit key into its full scope hierarchy. For postal code keys
// (dk####) the layer convention dk5 -> dk5x -> dk5xx -> dk5230 is followed; at
// dk5x the own 2-digit prefix PLUS the neighbors' are included, sorted.
export function scopesFor(ds, key) {
  const m = POSTAL_KEY.exec(key);
  if (!m) return [key];
  const d = m[1];
  const layer2 = [...new Set(["dk" + d.slice(0, 2), ...neighborPrefixesFor(ds, key)])].sort();
  return ["dk" + d[0], ...layer2, "dk" + d.slice(0, 3), "dk" + d];
}

// The entire scope universe: the fixed top-level scopes (eu, europe, dk) plus
// every region key plus every postal code expanded to its prefix layers
// (dk5230 -> dk5, dk52, dk523, dk5230), flattened into one deduplicated,
// sorted list. Neighbor derivation is NOT included - it is point-specific and
// makes no sense for the whole dataset; but because a postal code like 5000
// exists, its 2-digit prefix dk50 shows up on its own.
export function allScopes(ds) {
  const seen = new Set(Object.keys(FIXED_SCOPE_PARENTS));
  for (const k of Object.keys(ds.regions)) seen.add(k);
  for (const k of Object.keys(ds.postnumre)) {
    const m = POSTAL_KEY.exec(k);
    if (!m) { seen.add(k); continue; }
    for (const s of postalLayers(m[1])) seen.add(s);
  }
  return [...seen].sort();
}

// Flat region tree: * -> {eu, europe} -> dk -> all other scopes.
export function parentScope(key) {
  return Object.hasOwn(FIXED_SCOPE_PARENTS, key) ? FIXED_SCOPE_PARENTS[key] : "dk";
}

const utf8 = new TextEncoder();
function byteLength(s) {
  return utf8.encode(s).length;
}

// Builds 'region def' lines (<= DEF_LIMIT bytes) for an ordered scope list
// (parent always before child). Each node is placed under the logical cursor;
// the form name|jump pops the cursor back up so siblings can be placed. If a
// split is needed, continuation lines lead with eu|<node> to reposition the
// cursor without changing the tree (eu's parent is really *, so re-putting it
// under the root is a no-op).
export function regionDefLines(scopes) {
  const prefix = "region def ";
  const lines = [];
  const n = scopes.length;
  let i = 0;
  let lead = null;
  while (i < n) {
    const parts = lead !== null ? [lead] : [];
    const minParts = parts.length;
    while (i < n) {
      const node = scopes[i];
      let jump = null;
      if (i < n - 1) {
        const np = parentScope(scopes[i + 1]);
        if (np !== node) jump = np;
      }
      const token = jump !== null ? node + "|" + jump : node;
      const candidate = [...parts, token];
      if (byteLength(prefix + candidate.join(" ")) > DEF_LIMIT && parts.length > minParts) break;
      parts.push(token);
      i++;
    }
    lines.push(prefix + parts.join(" "));
    lead = i < n ? "eu|" + parentScope(scopes[i]) : null;
  }
  return lines;
}

// --- Point lookup -----------------------------------------------------------

// Everything for one point: the hit polygons (regions + postal codes), the
// expanded scope hierarchy, the finished CLI blocks for the repeater (two
// firmware variants; null when nothing is hit) and the geometry of the hit
// polygons so the caller can draw the highlight.
export function scopesForPoint(ds, lat, lon) {
  // Hit test: regions first, then postal codes. The bbox pre-filter rejects
  // distant polygons with four comparisons before the ray-cast.
  const hits = [];
  for (const [k, v] of Object.entries(ds.regions)) {
    const bb = ds.rbb[k];
    if (!bb || lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
    if (pointInGeom(lon, lat, v.geometry)) hits.push(k);
  }
  for (const [k, v] of Object.entries(ds.postnumre)) {
    const bb = ds.pbb[k];
    if (!bb || lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
    if (pointInGeom(lon, lat, v.geometry)) hits.push(k);
  }

  // Expand hits into the ordered, unique scope hierarchy.
  const seen = new Set();
  const scopes = [];
  for (const k of hits) {
    for (const s of scopesFor(ds, k)) {
      if (!seen.has(s)) { seen.add(s); scopes.push(s); }
    }
  }

  const features = [];
  for (const k of hits) {
    const entry = ds.regions[k] ?? ds.postnumre[k];
    if (entry && entry.geometry) {
      features.push({ type: "Feature", properties: { region: k }, geometry: entry.geometry });
    }
  }

  let cli = null;
  if (scopes.length) {
    const all = [...Object.keys(FIXED_SCOPE_PARENTS), ...scopes];
    const oldCli = all.map(s => "region put " + s + "\nregion allowf " + s).join("\n") + "\nregion save";
    const newCli = regionDefLines(all).join("\n") + "\nregion save";
    cli = {
      firmware_1_16_0_plus: newCli,
      firmware_1_12_0_to_1_15_0: oldCli
    };
  }

  return {
    lat,
    lon,
    hits,
    scopes,
    cli,
    features: { type: "FeatureCollection", features }
  };
}
