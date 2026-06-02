(function () {
  const regions = window.MCDK_REGIONS || {};
  const cities = window.MCDK_CITIES || {};
  const regionsGeo = window.MCDK_REGIONS_GEOJSON || { type: "FeatureCollection", features: [] };
  const citiesGeo = window.MCDK_CITIES_GEOJSON || { type: "FeatureCollection", features: [] };

  const regionCli = document.getElementById("regionCli");
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

    const regionsLayer = L.geoJSON(regionsGeo, {
      style: feature => ({
        className: "mcdk-region",
        color: "#0a1830",
        weight: 1.2,
        fillColor: regionColor(feature.properties && feature.properties.region),
        fillOpacity: 0,
        opacity: 0
      }),
      onEachFeature: (feature, layer) => {
        const key = feature.properties && feature.properties.region;
        layer.on("click", e => {
          // Skift event-handling: vis alle regioner under klikket (overlap-support).
          const hits = hitTestRegions(e.latlng);
          render(hits.length ? hits : (key ? [key] : []));
          showClickMarker(e.latlng);
          e.stopPropagation();
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

    // Hint overlay — vis når ingen regioner er valgt.
    const hintEl = document.getElementById("mapHint");
    function showHint(show) {
      if (hintEl) hintEl.hidden = !show;
    }

    function render(keys) {
      const arr = Array.isArray(keys) ? keys : (keys ? [keys] : []);
      const valid = arr.filter(k => regions[k]);
      if (valid.length === 0) {
        regionCli.style.display = "none";
        regionTitle.style.display = "none";
        regionsLayer.eachLayer(l => l.setStyle({ fillOpacity: 0, weight: 1.2, opacity: 0 }));
        showHint(true);
        return;
      }

      regionCli.style.display = "";
      regionTitle.style.display = "";

      let cli = "region put eu\nregion put dk";
      valid.forEach(k => { cli += "\nregion put " + regions[k].channel; });
      regionCli.innerHTML = "<code>" + escapeHtml(cli + "\nregion save") + "</code>";

      regionsLayer.eachLayer(l => {
        const k = l.feature && l.feature.properties && l.feature.properties.region;
        const active = valid.includes(k);
        l.setStyle({ fillOpacity: active ? 0.2 : 0, weight: active ? 1 : 0, opacity: active ? 1 : 0 });
        if (active) l.bringToFront();
      });
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

  // Horizontal scroll via mousewheel with momentum.
  const grid = document.querySelector(".screenshot-grid");
  if (grid) {
    let vel = 0, rafId = null;

    function animate() {
      if (Math.abs(vel) < 0.5) { vel = 0; rafId = null; return; }
      vel *= 0.9;
      grid.scrollLeft += vel;
      rafId = requestAnimationFrame(animate);
    }

    function startMomentum() {
      if (!rafId) rafId = requestAnimationFrame(animate);
    }

    grid.addEventListener("wheel", e => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        vel += e.deltaX * 0.05;
      } else {
        vel += e.deltaY * 0.03;
      }
      startMomentum();
      e.preventDefault();
    }, { passive: false });

    // Touch support with momentum.
    let touchStartX, touchScrollLeft, touchVel = 0, lastTouchX, lastTime;
    grid.addEventListener("touchstart", e => {
      touchStartX = e.touches[0].clientX;
      touchScrollLeft = grid.scrollLeft;
      touchVel = 0;
      lastTouchX = touchStartX;
      lastTime = performance.now();
    }, { passive: true });
    grid.addEventListener("touchmove", e => {
      const x = e.touches[0].clientX;
      const now = performance.now();
      const dt = now - lastTime || 1;
      touchVel = (x - lastTouchX) / dt * 2;
      lastTouchX = x;
      lastTime = now;
      grid.scrollLeft = touchScrollLeft + (x - touchStartX);
    }, { passive: true });
    grid.addEventListener("touchend", () => {
      vel = touchVel;
      startMomentum();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
