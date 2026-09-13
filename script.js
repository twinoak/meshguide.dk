// script.js - presentation for index.html: draws the map, runs the scope
// engine (scopes.js) on click and shows the result. The site is fully static:
// regions.json, cities.json and the postal code files are plain JSON fetched
// from the same host, and all scope logic runs in the browser.

import { buildDataset, scopesForPoint } from "./scopes.js";

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Kunne ikke hente " + url + ": " + r.status);
  return r.json();
}

// regions.json + every postal code file listed in postnumre/index.json. All
// files are loaded (not just the ones under the click), so that the neighbor
// derivation sees the whole dataset and is deterministic across landsdele -
// about 200 KB compressed in total.
async function loadDataset() {
  const regions = await fetchJSON("regions.json");
  const manifest = await fetchJSON("postnumre/index.json");
  const postnumreFiles = [];
  for (const f of manifest.files || []) {
    postnumreFiles.push(await fetchJSON("postnumre/" + f.file));
  }
  return buildDataset(regions, postnumreFiles);
}

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function cliBlock(label, text) {
  return '<div class="cli-block"><span class="cli-label">' +
    escapeHtml(label) + '</span><pre><code>' +
    escapeHtml(text) + '</code></pre></div>';
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

const CITY_ZOOM_MIN = 7;
const HIGHLIGHT_COLOR = "#ffffff";

function init(cities) {
  const mapEl = document.getElementById("map");
  if (!mapEl || typeof L === "undefined") return;

  const citiesGeo = toFeatureCollection(cities, "city");
  const regionCli = document.getElementById("regionCli");
  const regionTitle = document.getElementById("regionTitle");
  const hintEl = document.getElementById("mapHint");

  // Start loading the polygon data right away so it is (usually) ready by the
  // first click. The click handler awaits it; on failure it kicks off a new
  // attempt for the next click.
  let datasetPromise = loadDataset();

  const map = L.map(mapEl, {
    center: [56.0, 11.0],
    zoom: 7,
    minZoom: 6,
    maxZoom: 14,
    worldCopyJump: false
  });

  L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/dark",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragydere &copy; <a href="https://openfreemap.org/">OpenFreeMap</a>'
  }).addTo(map);

  // --- City markers -----------------------------------------------------
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

  // --- Click marker -----------------------------------------------------
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

  // --- Highlight of the hit polygons ------------------------------------
  // A fresh layer per click, tearing down the previous one. interactive:false
  // so a new click (even on top of a highlight) falls through to the map
  // click handler.
  let highlightLayer = null;
  function clearHighlight() {
    if (highlightLayer) { map.removeLayer(highlightLayer); highlightLayer = null; }
  }
  function drawHighlight(featureCollection) {
    clearHighlight();
    if (!featureCollection || !featureCollection.features || !featureCollection.features.length) return;
    highlightLayer = L.geoJSON(featureCollection, {
      interactive: false,
      style: {
        className: "mcdk-region",
        color: HIGHLIGHT_COLOR,
        weight: 1.25,
        fillColor: HIGHLIGHT_COLOR,
        fillOpacity: 0.1,
        opacity: 1
      }
    }).addTo(map);
  }

  function showHint(show) {
    if (hintEl) hintEl.hidden = !show;
  }

  // --- Result display ---------------------------------------------------
  function clearResult() {
    regionCli.style.display = "none";
    regionTitle.style.display = "none";
    document.getElementById("gps").hidden = true;
    clearHighlight();
    hideClickMarker();
    showHint(true);
  }
  function showResult(res, latlng) {
    regionCli.style.display = "";
    regionTitle.style.display = "";
    regionCli.innerHTML =
      cliBlock("Firmware 1.16.0+", res.cli.firmware_1_16_0_plus) +
      cliBlock("Firmware 1.12.0 - 1.15.0", res.cli.firmware_1_12_0_to_1_15_0);

    const lat = latlng.lat.toFixed(7);
    const lon = latlng.lng.toFixed(7);
    document.getElementById("gpsCoords").textContent = "set lat " + lat + "\nset lon " + lon + "\ngps advert prefs";
    document.getElementById("gps").hidden = false;
    drawHighlight(res.features);
    showHint(false);
  }
  function showError() {
    regionCli.style.display = "";
    regionTitle.style.display = "none";
    regionCli.innerHTML = cliBlock("Fejl", "Kunne ikke hente kortdata - prøv at klikke igen.");
    clearHighlight();
    showHint(false);
  }

  // --- Click -> scopes --------------------------------------------------
  // A sequence counter ensures a quick new click always wins over an older
  // one that was still waiting for the dataset to load.
  let clickSeq = 0;
  map.on("click", async e => {
    const seq = ++clickSeq;
    const { lat, lng } = e.latlng;
    showClickMarker(e.latlng);
    let dataset;
    try {
      dataset = await datasetPromise;
    } catch (err) {
      console.error(err);
      datasetPromise = loadDataset(); // retry in the background for the next click
      if (seq !== clickSeq) return;
      showError();
      return;
    }
    if (seq !== clickSeq) return; // a newer click is on its way
    const res = scopesForPoint(dataset, lat, lng);
    if (!res.hits.length) {
      clearResult();
      return;
    }
    showResult(res, e.latlng);
  });
}

// Random flood.advert.interval in the UI table.
const floodInterval = Math.floor(Math.random() * (85 - 60 + 1)) + 60;
document.querySelectorAll(".floodAdvertInterval").forEach(el => { el.textContent = floodInterval; });

// Expandable screenshot grid
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

// Module scripts run after the document has been parsed, so the DOM (and the
// deferred Leaflet/MapLibre scripts, which come earlier in the document) are
// ready here.
try {
  init(await fetchJSON("cities.json"));
} catch (e) {
  console.error(e);
}
