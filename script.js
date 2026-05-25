(function () {
  const regions = window.MCDK_REGIONS || {};
  const cities = window.MCDK_CITIES || {};
  const regionsGeo = window.MCDK_REGIONS_GEOJSON || { type: "FeatureCollection", features: [] };
  const citiesGeo = window.MCDK_CITIES_GEOJSON || { type: "FeatureCollection", features: [] };

  const info = document.getElementById("regionInfo");
  const list = document.getElementById("regionList");
  const mapEl = document.getElementById("map");

  // Per-region farver. Tilfoej en linje hvis du tilfoejer en ny region.
  const REGION_COLORS = {
    "dk-nrj":   "#2da8a083",
    "dk-mdj":   "#4a8be083",
    "dk-oj":    "#b760d683",
    "dk-sdk":   "#5fbf5f93",
    "dk-fyn":   "#e8a23a83",
    "dk-sjl":   "#e85a5a83",
    "dk-lo-fa": "#e879c883",
    "dk-bhm":   "#c89a4a83",
    "dk-ls":    "#8fb8d683",
    "dk-aht":   "#d68f8f83",
    "dk-sms":   "#a0d68f83",
    "dk-3kant": "#d6b88f83"
  };
  const DEFAULT_REGION_COLOR = "#4a8db883";
  const CITY_ZOOM_MIN = 9;

  function regionColor(key) { return REGION_COLORS[key] || DEFAULT_REGION_COLOR; }

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

    const regionsLayer = L.geoJSON(regionsGeo, {
      style: feature => ({
        className: "mcdk-region",
        color: "#0a1830",
        weight: 1.2,
        fillColor: regionColor(feature.properties && feature.properties.region),
        fillOpacity: 0.45
      }),
      onEachFeature: (feature, layer) => {
        const key = feature.properties && feature.properties.region;
        layer.on("click", e => {
          // Skift event-handling: vis alle regioner under klikket (overlap-support).
          const hits = hitTestRegions(e.latlng);
          render(hits.length ? hits : (key ? [key] : []));
          showClickMarker(e.latlng);
          L.DomEvent.stopPropagation(e);
        });
      }
    }).addTo(map);

    function hitTestRegions(latlng) {
      const pt = [latlng.lng, latlng.lat];
      const hits = [];
      regionsGeo.features.forEach(f => {
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

    // Region-liste under kortet.
    Object.keys(regions).forEach(key => {
      const li = document.createElement("li");
      li.textContent = regions[key].name;
      li.dataset.region = key;
      li.addEventListener("click", () => {
        render([key]);
        // Hvis vi har geometri, zoom til den.
        const layer = findRegionLayer(regionsLayer, key);
        if (layer && layer.getBounds && layer.getBounds().isValid()) {
          map.fitBounds(layer.getBounds(), { padding: [20, 20] });
        }
      });
      list.appendChild(li);
    });

    function render(keys) {
      const arr = Array.isArray(keys) ? keys : (keys ? [keys] : []);
      const valid = arr.filter(k => regions[k]);
      if (valid.length === 0) {
        info.innerHTML = "<h3>Vælg en region</h3>";
        regionsLayer.eachLayer(l => l.setStyle({ fillOpacity: 0.45, weight: 1.2 }));
        [...list.children].forEach(li => li.classList.remove("active"));
        return;
      }

      const primary = regions[valid[0]];
      let html = "<h3>" + valid.map(k => escapeHtml(regions[k].name)).join(" + ") + "</h3>";

      if (valid.length > 1) {
        html += "<p><strong>Overlap:</strong> denne placering er dækket af " + valid.length + " regioner. Inkludér alle scopes.</p>";
      }

      html += "<dl>";
      valid.forEach(k => {
        const r = regions[k];
        html += "<dt>" + escapeHtml(r.name) + "</dt><dd><code>" + escapeHtml(r.channel) + "</code> – " + escapeHtml(r.coverage) + "</dd>";
      });
      html += "</dl>";

      if (primary.notes && primary.notes !== "Ingen noter.") {
        html += "<p><em>" + escapeHtml(primary.notes) + "</em></p>";
      }

      let cli = "region put eu *\nregion put dk eu";
      valid.forEach(k => { cli += "\nregion put " + regions[k].channel + " dk"; });
      html += "<pre><code>" + escapeHtml(cli) + "</code></pre>";
      html += "<pre><code>region save</code></pre>";

      info.innerHTML = html;

      regionsLayer.eachLayer(l => {
        const k = l.feature && l.feature.properties && l.feature.properties.region;
        const active = valid.includes(k);
        l.setStyle({ fillOpacity: active ? 0.7 : 0.15, weight: active ? 2.5 : 1 });
        if (active) l.bringToFront();
      });
      [...list.children].forEach(li => li.classList.toggle("active", valid.includes(li.dataset.region)));
    }

  }

  function cityPopupHtml(c) {
    let html = '<div class="mcdk-city-popup-body">';
    html += "<h4>" + escapeHtml(c.name) + "</h4>";
    html += "<dl>";
    html += "<dt>Lokal-chat</dt><dd><code>" + escapeHtml(c.localChat) + "</code></dd>";
    if (c.scope) html += "<dt>Scope</dt><dd><code>" + escapeHtml(c.scope) + "</code></dd>";
    html += "</dl>";
    if (c.notes) html += "<p><em>" + escapeHtml(c.notes) + "</em></p>";
    html += "</div>";
    return html;
  }

  function findRegionLayer(geoLayer, key) {
    let found = null;
    geoLayer.eachLayer(l => {
      const k = l.feature && l.feature.properties && l.feature.properties.region;
      if (k === key) found = l;
    });
    return found;
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
