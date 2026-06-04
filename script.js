(function () {
  const regions = window.MCDK_REGIONS || {};
  const cities = window.MCDK_CITIES || {};
  const regionsGeo = toFeatureCollection(regions, "region");
  const citiesGeo = toFeatureCollection(cities, "city");

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

    const regionsLayer = L.geoJSON(regionsGeo, {
      style: feature => ({
        className: "mcdk-region",
        color: regionColor(feature.properties && feature.properties.region),
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
      valid.forEach(k => { cli += "\nregion put " + k; });
      regionCli.innerHTML = "<code>" + escapeHtml(cli + "\nregion save") + "</code>";

      regionsLayer.eachLayer(l => {
        const k = l.feature && l.feature.properties && l.feature.properties.region;
        const active = valid.includes(k);
        l.setStyle({ fillOpacity: active ? 0.1 : 0, weight: active ? 1.25 : 0, opacity: active ? 1 : 0 });
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
})();
