(function () {
  const regions = window.MCDK_REGIONS || {};
  const cities = window.MCDK_CITIES || {};
  const initialGeo = window.MCDK_REGIONS_GEOJSON || { type: "FeatureCollection", features: [] };
  const citiesGeo = window.MCDK_CITIES_GEOJSON || { type: "FeatureCollection", features: [] };

  const REGION_COLORS = {
    "dk-nrj":   "#2da8a0",
    "dk-mdj":   "#4a8be0",
    "dk-oj":    "#b760d6",
    "dk-sdk":   "#5fbf5f",
    "dk-fyn":   "#e8a23a",
    "dk-sjl":   "#e85a5a",
    "dk-lo-fa": "#e879c8",
    "dk-bhm":   "#c89a4a",
    "dk-ls":    "#8fb8d6",
    "dk-aht":   "#d68f8f",
    "dk-sms":   "#a0d68f",
    "dk-3kant": "#d6b88f"
  };
  const DEFAULT_COLOR = "#4a8db8";
  const colorFor = key => REGION_COLORS[key] || DEFAULT_COLOR;

  const mapEl = document.getElementById("editor-map");
  const statusEl = document.getElementById("editorStatus");
  const btnCopy = document.getElementById("btnCopy");
  const btnDownload = document.getElementById("btnDownload");
  const keyModal = document.getElementById("keyModal");
  const keySelect = document.getElementById("keySelect");
  const keyConfirm = document.getElementById("keyConfirm");
  const keyCancel = document.getElementById("keyCancel");

  if (!mapEl || typeof L === "undefined") return;

  Object.keys(regions).forEach(k => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k + " — " + regions[k].name;
    keySelect.appendChild(opt);
  });

  const map = L.map(mapEl, {
    center: [56.0, 11.0],
    zoom: 7,
    minZoom: 6,
    maxZoom: 14
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bidragydere &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 20
  }).addTo(map);

  // Lag der holder de redigerbare region-polygoner. Each layer's feature.properties.region er noeglen.
  const regionsLayer = L.geoJSON(initialGeo, {
    style: feature => styleForKey(feature.properties && feature.properties.region),
    onEachFeature: (feature, layer) => {
      bindLayerTooltip(layer, feature.properties && feature.properties.region);
    }
  }).addTo(map);

  // Vis byer som referencepunkter, ikke-redigerbare.
  citiesGeo.features.forEach(f => {
    if (!f.geometry || f.geometry.type !== "Point") return;
    const [lng, lat] = f.geometry.coordinates;
    const meta = cities[f.properties && f.properties.city] || {};
    const marker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: "",
        html: '<div class="mcdk-city-marker"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      }),
      title: meta.name || "",
      pmIgnore: true
    });
    marker.addTo(map);
  });

  function styleForKey(key) {
    return {
      color: "#0a1830",
      weight: 1.5,
      fillColor: colorFor(key),
      fillOpacity: 0.45
    };
  }
  function bindLayerTooltip(layer, key) {
    if (!key) return;
    const meta = regions[key];
    layer.bindTooltip(key + (meta ? " — " + meta.name : ""), { sticky: true, direction: "top" });
  }

  // Geoman controls.
  map.pm.addControls({
    position: "topleft",
    drawMarker: false,
    drawCircleMarker: false,
    drawPolyline: false,
    drawRectangle: false,
    drawCircle: false,
    drawText: false,
    drawPolygon: true,
    editMode: true,
    dragMode: false,
    cutPolygon: false,
    removalMode: true,
    rotateMode: false
  });
  map.pm.setGlobalOptions({
    snappable: true,
    snapDistance: 12,
    finishOn: "dblclick",
    allowSelfIntersection: false
  });

  // Naar et nyt polygon tegnes, spoerg om region-noegle.
  map.on("pm:create", e => {
    const layer = e.layer;
    // Frisk-tegnede layers kommer ind uden feature; tilfoej en.
    layer.feature = layer.feature || { type: "Feature", properties: {}, geometry: null };
    promptForKey(null, key => {
      if (!key) {
        regionsLayer.removeLayer(layer);
        map.removeLayer(layer);
        return;
      }
      layer.feature.properties = layer.feature.properties || {};
      layer.feature.properties.region = key;
      layer.setStyle(styleForKey(key));
      bindLayerTooltip(layer, key);
      regionsLayer.addLayer(layer);
      setStatus("Tilfoejet " + key + ".");
    });
  });

  // Lad brugeren klikke et eksisterende polygon for at ændre dets noegle.
  regionsLayer.on("click", e => {
    if (!e.propagatedFrom) return;
    if (map.pm.globalEditModeEnabled() || map.pm.globalDrawModeEnabled() || map.pm.globalRemovalModeEnabled()) return;
    const layer = e.propagatedFrom;
    const currentKey = layer.feature && layer.feature.properties && layer.feature.properties.region;
    promptForKey(currentKey, key => {
      if (!key) return;
      layer.feature.properties = layer.feature.properties || {};
      layer.feature.properties.region = key;
      layer.setStyle(styleForKey(key));
      bindLayerTooltip(layer, key);
      setStatus("Aendret til " + key + ".");
    });
    L.DomEvent.stopPropagation(e);
  });

  // Naar et polygon slettes via Geoman, fjern det ogsaa fra regionsLayer.
  map.on("pm:remove", e => {
    if (regionsLayer.hasLayer(e.layer)) regionsLayer.removeLayer(e.layer);
    setStatus("Slettet.");
  });

  // Key-modal handling.
  let keyResolver = null;
  function promptForKey(preselect, cb) {
    keyResolver = cb;
    if (preselect) keySelect.value = preselect;
    else keySelect.selectedIndex = 0;
    keyModal.hidden = false;
    keySelect.focus();
  }
  function closeKeyModal(key) {
    keyModal.hidden = true;
    const cb = keyResolver;
    keyResolver = null;
    if (cb) cb(key);
  }
  keyConfirm.addEventListener("click", () => closeKeyModal(keySelect.value));
  keyCancel.addEventListener("click", () => closeKeyModal(null));
  keyModal.addEventListener("click", e => { if (e.target === keyModal) closeKeyModal(null); });
  document.addEventListener("keydown", e => {
    if (keyModal.hidden) return;
    if (e.key === "Enter") closeKeyModal(keySelect.value);
    if (e.key === "Escape") closeKeyModal(null);
  });

  // Export buttons.
  btnCopy.addEventListener("click", async () => {
    const text = serialize();
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Kopieret " + featureCount() + " features til udklipsholder.");
    } catch (err) {
      // Fallback: vis text i en prompt saa brugeren selv kan kopiere.
      window.prompt("Kopier manuelt:", text);
    }
  });
  btnDownload.addEventListener("click", () => {
    const text = serialize();
    const blob = new Blob([text], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "regions.geojson";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus("Downloaded " + featureCount() + " features.");
  });

  function serialize() {
    const fc = { type: "FeatureCollection", features: [] };
    regionsLayer.eachLayer(l => {
      // Geoman tilfoejer layers direkte til map naar de tegnes; vi flytter dem ind i regionsLayer
      // i pm:create-handleren, saa eachLayer ser dem her.
      const gj = l.toGeoJSON();
      // toGeoJSON paa et child-layer giver en single Feature; men hvis layeret er en GeoJSON-gruppe
      // returnerer det en FeatureCollection. Haandter begge.
      if (gj.type === "Feature") fc.features.push(gj);
      else if (gj.type === "FeatureCollection") fc.features.push(...gj.features);
    });
    // Sikrer at hver Feature har properties.region (drop ellers).
    fc.features = fc.features.filter(f => f.properties && f.properties.region);
    return JSON.stringify(fc, null, 2);
  }
  function featureCount() {
    let n = 0;
    regionsLayer.eachLayer(l => {
      const gj = l.toGeoJSON();
      if (gj.type === "Feature" && gj.properties && gj.properties.region) n++;
      else if (gj.type === "FeatureCollection") n += gj.features.filter(f => f.properties && f.properties.region).length;
    });
    return n;
  }
  function setStatus(msg) {
    statusEl.textContent = msg;
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => { statusEl.textContent = ""; }, 4000);
  }
})();
