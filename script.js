(async function () {
  // Al scope-logik bor nu server-side i api/scopes.php (kilden til reglerne).
  // Denne fil er ren præsentation: den tegner kortet, sender klik til API'et og
  // viser det tilbagesendte resultat. Der hentes ingen polygon-data til klienten
  // længere - API'et returnerer selv geometrien for de ramte polygoner, så vi
  // kan tegne highlightet uden at downloade regions.json/postnumre.

  const API_URL = "api/scopes";

  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("Kunne ikke hente " + url + ": " + r.status);
    return r.json();
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

  let cities;
  try {
    cities = await fetchJSON("cities.json");
  } catch (e) {
    console.error(e);
    return;
  }
  const citiesGeo = toFeatureCollection(cities, "city");

  const CITY_ZOOM_MIN = 7;
  const HIGHLIGHT_COLOR = "#ffffff";

  function init() {
    const mapEl = document.getElementById("map");
    if (!mapEl || typeof L === "undefined") return;

    const regionCli = document.getElementById("regionCli");
    const regionTitle = document.getElementById("regionTitle");
    const hintEl = document.getElementById("mapHint");

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

    // --- Bymarkører -------------------------------------------------------
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

    // --- Klik-markør ------------------------------------------------------
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

    // --- Highlight af de ramte polygoner ----------------------------------
    // Geometrien kommer fra API-svaret; vi bygger et frisk lag pr. klik og
    // river det forrige ned. interactive:false så et nyt klik (også oven på
    // et highlight) falder igennem til map-klik-handleren.
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

    // --- Resultat-visning -------------------------------------------------
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
      regionCli.innerHTML = cliBlock("Fejl", "Kunne ikke hente scopes - prøv at klikke igen.");
      clearHighlight();
      showHint(false);
    }

    // --- Klik -> API ------------------------------------------------------
    // En rækkefølge-tæller sikrer at et hurtigt nyt klik altid vinder over et
    // ældre, langsommere svar (ellers kunne et forsinket svar overskrive et
    // nyere resultat).
    let clickSeq = 0;
    map.on("click", async e => {
      const seq = ++clickSeq;
      const { lat, lng } = e.latlng;
      showClickMarker(e.latlng);
      let res;
      try {
        res = await fetchJSON(API_URL + "?lat=" + lat + "&lon=" + lng);
      } catch (err) {
        if (seq !== clickSeq) return;
        console.error(err);
        showError();
        return;
      }
      if (seq !== clickSeq) return; // et nyere klik er undervejs
      if (!res.hits || !res.hits.length) {
        clearResult();
        return;
      }
      showResult(res, e.latlng);
    });
  }

  // Tilfældigt flood.advert.interval i UI-tabellen.
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
