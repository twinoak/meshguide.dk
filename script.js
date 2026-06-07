(async function () {
  function toFeatureCollection(dict, propKey) {
    return {
      type: "FeatureCollection",
      features: Object.entries(dict)
        .filter(([, v]) => v && v.geometry)
        .map(([k, v]) => ({
          type: "Feature",
          properties: { [propKey]: k },
          geometry: v.geometry
        }))
    };
  }

  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("Kunne ikke hente " + url + ": " + r.status);
    return r.json();
  }

  // Postnumre indlaeses doven foerst naar brugeren klikker paa kortet — det
  // sparer ~80 KB gzipped paa initial load for en feature, der typisk kun bruges
  // én gang per besoeg.
  let postnumre = {};
  let postnumreGeo = { type: "FeatureCollection", features: [] };
  let postnumrePromise = null;
  function loadPostnumre() {
    if (!postnumrePromise) {
      postnumrePromise = fetchJSON("postnumre.json").then(data => {
        postnumre = data;
        postnumreGeo = toFeatureCollection(data, "region");
      }).catch(err => {
        console.warn("Kunne ikke hente postnumre.json:", err);
        postnumrePromise = null; // tillader retry ved naeste klik
      });
    }
    return postnumrePromise;
  }

  // --- Nabo-udledning -------------------------------------------------------
  // dk5x-laget (det 2-cifrede) skal ikke kun daekke ens eget postnummer, men
  // ogsaa nabo-postnumrene der stoeder op til (eller ligger taet paa) det. Vi
  // udleder naboerne ud fra polygon-geometrien ved klik: et postnummer er nabo
  // hvis dets graense ligger inden for NEIGHBOR_DIST_M af det klikkede.
  const NEIGHBOR_DIST_M = 2000;
  const M_PER_DEG = 111320; // meter pr. grad bredde (og laengde ved aekvator)
  const neighborCache = new Map();

  function ringsOf(geom) {
    if (!geom) return [];
    if (geom.type === "Polygon") return geom.coordinates;
    if (geom.type === "MultiPolygon") return geom.coordinates.flatMap(p => p);
    return [];
  }
  function geomBBox(geom) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    ringsOf(geom).forEach(ring => ring.forEach(([x, y]) => {
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }));
    return [minx, miny, maxx, maxy];
  }
  // Afstand fra punkt til linjestykke i meter (lokal equirektangulaer projektion).
  function segDistM(p, a, b, sx, sy) {
    const px = p[0] * sx, py = p[1] * sy;
    const ax = a[0] * sx, ay = a[1] * sy, bx = b[0] * sx, by = b[1] * sy;
    const dx = bx - ax, dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  // Mindste afstand fra g1's hjoerner til g2's kanter; afbryder tidligt <= limit.
  function boundaryDistM(g1, g2, sx, sy, limit) {
    let best = Infinity;
    const r2 = ringsOf(g2);
    for (const ring of ringsOf(g1)) {
      for (const p of ring) {
        for (const ring2 of r2) {
          for (let i = 0; i < ring2.length - 1; i++) {
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
  // De distinkte 2-cifrede prefixer (dkXY) for postnumre der graenser op til key.
  function neighborPrefixesFor(key) {
    if (neighborCache.has(key)) return neighborCache.get(key);
    const self = postnumre[key];
    if (!self || !self.geometry) {
      neighborCache.set(key, []);
      return [];
    }
    const bb = geomBBox(self.geometry);
    const refLat = (bb[1] + bb[3]) / 2;
    const sx = M_PER_DEG * Math.cos(refLat * Math.PI / 180);
    const sy = M_PER_DEG;
    const padLon = NEIGHBOR_DIST_M / sx, padLat = NEIGHBOR_DIST_M / sy;
    const seen = new Set();
    Object.keys(postnumre).forEach(k => {
      if (k === key) return;
      const m = /^dk(\d{4})$/.exec(k);
      if (!m) return;
      const e = postnumre[k];
      if (!e || !e.geometry) return;
      const ob = geomBBox(e.geometry);
      if (ob[0] > bb[2] + padLon || ob[2] < bb[0] - padLon ||
          ob[1] > bb[3] + padLat || ob[3] < bb[1] - padLat) return;
      const d = Math.min(
        boundaryDistM(self.geometry, e.geometry, sx, sy, NEIGHBOR_DIST_M),
        boundaryDistM(e.geometry, self.geometry, sx, sy, NEIGHBOR_DIST_M)
      );
      if (d <= NEIGHBOR_DIST_M) seen.add(`dk${m[1].slice(0, 2)}`);
    });
    const result = [...seen].sort();
    neighborCache.set(key, result);
    return result;
  }

  // Udleder alle scopes som en repeater i en given region skal saette.
  // For postnummer-noegler (dk####) foelges MeshCore-DK's lag-konvention:
  // dk5 (hele landsdelen) -> dk5x (2-cifret) -> dk5xx (3-cifret) -> dk5230.
  // Paa dk5x-laget indgaar eget 2-cifrede prefix PLUS nabo-postnumrenes (se
  // ovenfor), sorteret. dk50 e.l. optraeder altsaa kun naar 50-omraadet reelt
  // er nabo — ikke pr. automatik paa alle 5xxx-postnumre.
  function scopesFor(key) {
    const m = /^dk(\d{4})$/.exec(key);
    if (!m) return [key];
    const d = m[1];
    const layer2 = [...new Set([`dk${d.slice(0, 2)}`, ...neighborPrefixesFor(key)])].sort();
    return [`dk${d[0]}`, ...layer2, `dk${d.slice(0, 3)}`, `dk${d}`];
  }

  // Region-træet er fladt: * -> eu -> dk -> alle øvrige scopes. Hvert egentligt
  // scope (dk5, dk52, dk5230, nabo-præfikser ...) hænger direkte under dk, så
  // vi slipper for at udlede dybere forælder/barn-relationer.
  function parentScope(key) {
    if (key === "eu") return "*";
    if (key === "dk") return "eu";
    return "dk";
  }

  // Bygger 'region def'-linjer for en ordnet scope-liste (forælder altid før
  // barn). Hver knude placeres under den logiske cursor; formen name|jump
  // popper cursoren tilbage op, så søskende kan sættes. Linjer holdes <= 160
  // tegn (repeaterens serielle grænse) — passer alt på én linje, bliver det
  // én enkelt 'region def'. Skal der splittes, leder fortsættelseslinjer med
  // eu|<knude> for at genplacere cursoren uden at ændre træet (eu's forælder
  // er reelt *, så et gen-put under roden er en no-op).
  function regionDefLines(scopes) {
    const LIMIT = 160;
    const PREFIX = "region def ";
    const lines = [];
    let i = 0;
    let lead = null;
    while (i < scopes.length) {
      const parts = lead ? [lead] : [];
      const minParts = parts.length;
      while (i < scopes.length) {
        const node = scopes[i];
        let jump = null;
        if (i < scopes.length - 1) {
          const np = parentScope(scopes[i + 1]);
          if (np !== node) jump = np;
        }
        const token = jump ? node + "|" + jump : node;
        if (PREFIX.length + parts.concat(token).join(" ").length > LIMIT &&
            parts.length > minParts) break;
        parts.push(token);
        i++;
      }
      lines.push(PREFIX + parts.join(" "));
      lead = i < scopes.length ? "eu|" + parentScope(scopes[i]) : null;
    }
    return lines;
  }

  function cliBlock(label, text) {
    return '<div class="cli-block"><span class="cli-label">' +
      escapeHtml(label) + '</span><pre><code>' +
      escapeHtml(text) + '</code></pre></div>';
  }

  let regions, cities, regionsGeo, citiesGeo;
  try {
    [regions, cities] = await Promise.all([
      fetchJSON("regions.json"),
      fetchJSON("cities.json")
    ]);
  } catch (e) {
    console.error(e);
    return;
  }
  regionsGeo = toFeatureCollection(regions, "region");
  citiesGeo = toFeatureCollection(cities, "city");

  const regionCli = document.getElementById("regionCli");
  const regionTitle = document.getElementById("regionTitle");
  const mapEl = document.getElementById("map");

  const DEFAULT_REGION_COLOR = "#ffffff";
  const CITY_ZOOM_MIN = 8;

  function regionColor() { return DEFAULT_REGION_COLOR; }

  function init() {
    if (!mapEl || typeof L === "undefined") return;

    const map = L.map(mapEl, {
      center: [56.0, 11.0],
      zoom: 7,
      minZoom: 6,
      maxZoom: 14,
      worldCopyJump: false
    });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragydere &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 20
    }).addTo(map);

    function regionLayerStyle(feature) {
      return {
        className: "mcdk-region",
        color: regionColor(feature.properties && feature.properties.region),
        weight: 1.2,
        fillColor: regionColor(feature.properties && feature.properties.region),
        fillOpacity: 0,
        opacity: 0
      };
    }
    function attachClick(layer, key) {
      layer.on("click", e => {
        const ll = e.latlng;
        const hits = hitTestRegions(ll);
        render(hits.length ? hits : (key ? [key] : []));
        showClickMarker(ll);
        L.DomEvent.stopPropagation(e);
        loadPostnumre().then(() => {
          ensurePostnumreLayer();
          render(hitTestRegions(ll));
        });
      });
    }

    const regionsLayer = L.geoJSON(regionsGeo, {
      style: regionLayerStyle,
      onEachFeature: (feature, layer) => {
        attachClick(layer, feature.properties && feature.properties.region);
      }
    }).addTo(map);

    // Bygges foerst naar postnumre.json er hentet (typisk ved foerste klik).
    let postnumreLayer = null;
    function ensurePostnumreLayer() {
      if (postnumreLayer || !postnumreGeo.features.length) return;
      postnumreLayer = L.geoJSON(postnumreGeo, {
        style: regionLayerStyle,
        onEachFeature: (feature, layer) => {
          attachClick(layer, feature.properties && feature.properties.region);
        }
      }).addTo(map);
    }

    function hitTestRegions(latlng) {
      const pt = [latlng.lng, latlng.lat];
      const hits = [];
      regionsGeo.features.forEach(f => {
        const k = f.properties && f.properties.region;
        if (k && pointInFeature(pt, f)) hits.push(k);
      });
      postnumreGeo.features.forEach(f => {
        const k = f.properties && f.properties.region;
        if (k && pointInFeature(pt, f)) hits.push(k);
      });
      return hits;
    }

    const citiesLayer = L.layerGroup();
    citiesGeo.features.forEach(f => {
      const key = f.properties && f.properties.city;
      const meta = cities[key];
      if (!meta || !f.geometry || f.geometry.type !== "Point") return;
      const [lng, lat] = f.geometry.coordinates;
      const icon = L.divIcon({
        className: "",
        html: '<div class="mcdk-city-marker"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });
      const marker = L.marker([lat, lng], { icon, keyboard: true, title: meta.name });
      marker.bindPopup(cityPopupHtml(meta), { className: "mcdk-city-popup" });
      marker.on("click", e => L.DomEvent.stopPropagation(e));
      citiesLayer.addLayer(marker);
    });

    function syncCityLayer() {
      if (map.getZoom() >= CITY_ZOOM_MIN) {
        if (!map.hasLayer(citiesLayer)) citiesLayer.addTo(map);
      } else {
        if (map.hasLayer(citiesLayer)) map.removeLayer(citiesLayer);
      }
    }
    map.on("zoomend", syncCityLayer);
    syncCityLayer();

    let clickMarker = null;
    function showClickMarker(latlng) {
      if (clickMarker) {
        clickMarker.setLatLng(latlng);
      } else {
        clickMarker = L.circleMarker(latlng, {
          radius: 4,
          color: "#0a1830",
          weight: 1,
          fillColor: "#ffffff",
          fillOpacity: 1,
          interactive: false,
          pane: "markerPane"
        }).addTo(map);
      }
    }
    function hideClickMarker() {
      if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }
    }

    map.on("click", () => { render(null); hideClickMarker(); });

    // Hint overlay — vis når ingen regioner er valgt.
    const hintEl = document.getElementById("mapHint");
    function showHint(show) {
      if (hintEl) hintEl.hidden = !show;
    }

    function clearLayerStyles(layer) {
      if (!layer) return;
      layer.eachLayer(l => l.setStyle({ fillOpacity: 0, weight: 1.2, opacity: 0 }));
    }
    function highlightLayer(layer, valid) {
      if (!layer) return;
      layer.eachLayer(l => {
        const k = l.feature && l.feature.properties && l.feature.properties.region;
        const active = valid.includes(k);
        l.setStyle({ fillOpacity: active ? 0.1 : 0, weight: active ? 1.25 : 0, opacity: active ? 1 : 0 });
        if (active) l.bringToFront();
      });
    }

    function render(keys) {
      const arr = Array.isArray(keys) ? keys : (keys ? [keys] : []);
      const valid = arr.filter(k => regions[k] || postnumre[k]);
      if (valid.length === 0) {
        regionCli.style.display = "none";
        regionTitle.style.display = "none";
        clearLayerStyles(regionsLayer);
        clearLayerStyles(postnumreLayer);
        showHint(true);
        return;
      }

      regionCli.style.display = "";
      regionTitle.style.display = "";

      // Udfold hver hit-noegle til dens fulde scope-hierarki (dk5230 -> dk5,
      // dk50, dk52, dk523, dk5230) og bevar deres indbyrdes rækkefoelge.
      const seen = new Set();
      const scopes = [];
      valid.forEach(k => {
        scopesFor(k).forEach(s => {
          if (!seen.has(s)) { seen.add(s); scopes.push(s); }
        });
      });

      const allScopes = ["eu", "dk"].concat(scopes);
      const oldCli = allScopes.map(s => "region put " + s + "\nregion allowf " + s).join("\n") + "\nregion save";
      const newCli = regionDefLines(allScopes).join("\n") + "\nregion save";
      regionCli.innerHTML =
        cliBlock("Firmware 1.16.0+", newCli) +
        cliBlock("Firmware 1.12.0 - 1.15.0", oldCli);

      highlightLayer(regionsLayer, valid);
      highlightLayer(postnumreLayer, valid);
      showHint(false);
    }

  }

  function cityPopupHtml(c) {
    let html = '<div class="mcdk-city-popup-body">';
    html += "<h4>" + escapeHtml(c.name) + "</h4>";
    html += "<dl>";
    html += "<dt>Chat</dt><dd><code>" + escapeHtml(c.localChat) + "</code></dd>";
    if (c.scope) html += "<dt>Scope</dt><dd><code>" + escapeHtml(c.scope) + "</code></dd>";
    html += "</dl>";
    html += "</div>";
    return html;
  }

  // Point-in-polygon for GeoJSON Polygon/MultiPolygon. Punkt og ringe i [lng, lat].
  function pointInFeature(pt, feature) {
    const g = feature.geometry;
    if (!g) return false;
    if (g.type === "Polygon") return pointInPolygon(pt, g.coordinates);
    if (g.type === "MultiPolygon") return g.coordinates.some(poly => pointInPolygon(pt, poly));
    return false;
  }
  function pointInPolygon(pt, rings) {
    if (!rings.length) return false;
    if (!pointInRing(pt, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(pt, rings[i])) return false;
    }
    return true;
  }
  function pointInRing(pt, ring) {
    const x = pt[0], y = pt[1];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Tilfaeldigt flood.advert.interval i UI-tabellen, bibeholdt fra gammel script.js.
  const floodInterval = Math.floor(Math.random() * (85 - 60 + 1)) + 60;
  document.querySelectorAll(".floodAdvertInterval").forEach(el => { el.textContent = floodInterval; });

  // Expandable screenshot grids: show only the first row teaser, with a one-shot reveal button.
  const SHOW_LABEL = "Vis alle billeder";
  document.querySelectorAll(".screenshot-grid").forEach(grid => {
    grid.classList.add("collapsed");

    const wrap = document.createElement("div");
    wrap.className = "screenshot-grid-wrap";
    grid.parentNode.insertBefore(wrap, grid);
    wrap.appendChild(grid);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "screenshot-expand";
    btn.textContent = SHOW_LABEL;
    wrap.appendChild(btn);

    const expand = () => {
      grid.classList.remove("collapsed");
      btn.remove();
      window.removeEventListener("resize", refresh);
      if (ro) ro.disconnect();
    };
    btn.addEventListener("click", expand);

    const refresh = () => {
      const first = grid.firstElementChild;
      if (!first) return;
      grid.style.setProperty("--row-h", first.offsetHeight + "px");
      const fits = grid.scrollHeight <= first.offsetHeight + 1;
      if (fits) expand();
    };
    let ro = null;
    requestAnimationFrame(refresh);
    window.addEventListener("resize", refresh);
    if (window.ResizeObserver) {
      ro = new ResizeObserver(refresh);
      ro.observe(grid);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Radio coding-rate dropdown → CLI output
  const crSelect = document.getElementById("crSelect");
  const radioCli = document.getElementById("radioCli");
  if (crSelect && radioCli) {
    crSelect.addEventListener("change", () => {
      radioCli.textContent = "set radio 869.618,62.5,8," + crSelect.value;
    });
  }
})();
