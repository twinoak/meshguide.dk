(function () {
  const regions = window.MCDK_REGIONS || {};
  const cities = window.MCDK_CITIES || {};
  const initialGeo = toFeatureCollection(regions, "region");
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

  const DEFAULT_COLOR = "#4a8db8";
  const colorFor = () => DEFAULT_COLOR;

  const mapEl = document.getElementById("editor-map");
  const statusEl = document.getElementById("editorStatus");
  const btnCopy = document.getElementById("btnCopy");
  const btnDownload = document.getElementById("btnDownload");
  const btnEmail = document.getElementById("btnEmail");
  const keyModal = document.getElementById("keyModal");
  const keySelect = document.getElementById("keySelect");
  const keyConfirm = document.getElementById("keyConfirm");
  const keyCancel = document.getElementById("keyCancel");
  const newRegionModal = document.getElementById("newRegionModal");
  const nrKey = document.getElementById("newRegionKey");
  const nrName = document.getElementById("newRegionName");
  const nrError = document.getElementById("newRegionError");
  const nrConfirm = document.getElementById("newRegionConfirm");
  const nrCancel = document.getElementById("newRegionCancel");
  const cityModal = document.getElementById("cityModal");
  const cityKeyInput = document.getElementById("cityKey");
  const cityNameInput = document.getElementById("cityName");
  const cityScopeSelect = document.getElementById("cityScope");
  const cityChatInput = document.getElementById("cityChat");
  const cityError = document.getElementById("cityError");
  const cityConfirm = document.getElementById("cityConfirm");
  const cityCancel = document.getElementById("cityCancel");

  if (!mapEl || typeof L === "undefined") return;

  // Regions proposed by the user in this session (key -> metadata).
  const proposedRegions = {};
  const NEW_REGION_SENTINEL = "__new__";

  function rebuildKeySelect(selected) {
    keySelect.innerHTML = "";
    Object.keys(regions).forEach(k => {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k + " — " + regions[k].name;
      keySelect.appendChild(opt);
    });
    Object.keys(proposedRegions).forEach(k => {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k + " — " + proposedRegions[k].name + " (ny)";
      keySelect.appendChild(opt);
    });
    const newOpt = document.createElement("option");
    newOpt.value = NEW_REGION_SENTINEL;
    newOpt.textContent = "+ Ny region…";
    keySelect.appendChild(newOpt);
    if (selected) keySelect.value = selected;
  }
  rebuildKeySelect();

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

  // Tag each loaded layer with its original key + geometry so we can diff at submit time.
  regionsLayer.eachLayer(l => {
    const gj = l.toGeoJSON();
    l._origKey = gj.properties && gj.properties.region;
    l._origGeom = JSON.stringify(gj.geometry);
  });
  const deletedOriginals = [];

  // Byer er redigerbare markers i deres eget lag.
  const citiesLayer = L.featureGroup().addTo(map);
  const deletedCities = [];

  function cityIcon() {
    return L.divIcon({
      className: "",
      html: '<div class="mcdk-city-marker"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
  }
  function bindCityTooltip(marker, key) {
    const meta = marker._cityMeta || cities[key] || {};
    const suffix = meta.name ? " — " + meta.name : "";
    marker.unbindTooltip();
    marker.bindTooltip((key || "?") + suffix, { sticky: true, direction: "top" });
  }
  function addCityMarker(key, meta, latlng, isOriginal) {
    const marker = L.marker(latlng, { icon: cityIcon(), title: meta.name || "" });
    marker._cityKey = key;
    marker._cityMeta = { name: meta.name || "", scope: meta.scope || "", localChat: meta.localChat || "" };
    if (isOriginal) {
      marker._origCityKey = key;
      marker._origCityLatLng = L.latLng(latlng).clone();
      marker._origCityMeta = JSON.stringify(marker._cityMeta);
    }
    bindCityTooltip(marker, key);
    citiesLayer.addLayer(marker);
    return marker;
  }

  citiesGeo.features.forEach(f => {
    if (!f.geometry || f.geometry.type !== "Point") return;
    const [lng, lat] = f.geometry.coordinates;
    const key = f.properties && f.properties.city;
    const meta = cities[key] || {};
    addCityMarker(key, meta, [lat, lng], true);
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
    const meta = regions[key] || proposedRegions[key];
    const suffix = meta ? " — " + meta.name + (proposedRegions[key] ? " (ny)" : "") : "";
    layer.unbindTooltip();
    layer.bindTooltip(key + suffix, { sticky: true, direction: "top" });
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
    drawMarker: true,
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

  // Naar et nyt polygon eller marker tegnes.
  map.on("pm:create", e => {
    const layer = e.layer;
    if (layer instanceof L.Marker) {
      // Nyt bymarker — fjern det tegnede og lad city-modal styre opretelsen.
      map.removeLayer(layer);
      promptForCity(null, layer.getLatLng(), (key, meta) => {
        if (!key) return;
        addCityMarker(key, meta, layer.getLatLng(), false);
        setStatus("By tilfoejet: " + key + ".");
      });
      return;
    }
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

  // Klik paa eksisterende bymarker for at redigere metadata.
  citiesLayer.on("click", e => {
    const marker = e.propagatedFrom || e.layer;
    if (!marker || !(marker instanceof L.Marker)) return;
    if (map.pm.globalEditModeEnabled() || map.pm.globalDrawModeEnabled() || map.pm.globalRemovalModeEnabled() || map.pm.globalDragModeEnabled()) return;
    promptForCity(marker, marker.getLatLng(), (key, meta) => {
      if (!key) return;
      marker._cityKey = key;
      marker._cityMeta = meta;
      bindCityTooltip(marker, key);
      setStatus("By opdateret: " + key + ".");
    });
    L.DomEvent.stopPropagation(e);
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

  // Naar et polygon eller bymarker slettes via Geoman.
  map.on("pm:remove", e => {
    const l = e.layer;
    if (l instanceof L.Marker) {
      if (l._origCityKey) {
        deletedCities.push({ key: l._origCityKey, meta: JSON.parse(l._origCityMeta), latlng: l._origCityLatLng });
      }
      if (citiesLayer.hasLayer(l)) citiesLayer.removeLayer(l);
      setStatus("By slettet.");
      return;
    }
    if (l && l._origKey) {
      deletedOriginals.push({
        region: l._origKey,
        geometry: JSON.parse(l._origGeom)
      });
    }
    if (regionsLayer.hasLayer(l)) regionsLayer.removeLayer(l);
    setStatus("Slettet.");
  });

  // Key-modal handling.
  let keyResolver = null;
  function promptForKey(preselect, cb) {
    keyResolver = cb;
    rebuildKeySelect(preselect && (regions[preselect] || proposedRegions[preselect]) ? preselect : null);
    if (!preselect) keySelect.selectedIndex = 0;
    keyModal.hidden = false;
    keySelect.focus();
  }
  function resolveKey(key) {
    keyModal.hidden = true;
    const cb = keyResolver;
    keyResolver = null;
    if (cb) cb(key);
  }
  function handleKeyConfirm() {
    const choice = keySelect.value;
    if (choice === NEW_REGION_SENTINEL) {
      keyModal.hidden = true;
      openNewRegionModal();
      return;
    }
    resolveKey(choice);
  }
  keyConfirm.addEventListener("click", handleKeyConfirm);
  keyCancel.addEventListener("click", () => resolveKey(null));
  keyModal.addEventListener("click", e => { if (e.target === keyModal) resolveKey(null); });
  document.addEventListener("keydown", e => {
    if (keyModal.hidden) return;
    if (e.key === "Enter") handleKeyConfirm();
    if (e.key === "Escape") resolveKey(null);
  });

  // New-region modal handling.
  function openNewRegionModal() {
    nrKey.value = "";
    nrName.value = "";
    nrError.textContent = "";
    newRegionModal.hidden = false;
    nrKey.focus();
  }
  function closeNewRegionModal(savedKey) {
    newRegionModal.hidden = true;
    if (savedKey) {
      resolveKey(savedKey);
    } else {
      // User cancelled the new-region step — re-open the key picker so they can choose again.
      keyModal.hidden = false;
      keySelect.focus();
    }
  }
  function submitNewRegion() {
    const key = nrKey.value.trim().toLowerCase();
    const name = nrName.value.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(key)) {
      nrError.textContent = "Nøglen må kun indeholde små bogstaver, tal og bindestreger.";
      return;
    }
    if (regions[key] || proposedRegions[key]) {
      nrError.textContent = "Nøglen findes allerede.";
      return;
    }
    if (!name) { nrError.textContent = "Navn er påkrævet."; return; }
    proposedRegions[key] = { name };
    closeNewRegionModal(key);
  }
  nrConfirm.addEventListener("click", submitNewRegion);
  nrCancel.addEventListener("click", () => closeNewRegionModal(null));
  newRegionModal.addEventListener("click", e => { if (e.target === newRegionModal) closeNewRegionModal(null); });
  document.addEventListener("keydown", e => {
    if (newRegionModal.hidden) return;
    if (e.key === "Escape") closeNewRegionModal(null);
    // Enter on textarea inserts newlines, don't hijack it; submit only from inputs.
    if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") {
      e.preventDefault();
      submitNewRegion();
    }
  });

  // City modal handling.
  let cityResolver = null;
  let cityEditing = null; // marker being edited, or null for new
  function rebuildCityScopeSelect(selected) {
    cityScopeSelect.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "(intet scope)";
    cityScopeSelect.appendChild(blank);
    Object.keys(regions).forEach(k => {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k + " — " + regions[k].name;
      cityScopeSelect.appendChild(opt);
    });
    Object.keys(proposedRegions).forEach(k => {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k + " — " + proposedRegions[k].name + " (ny)";
      cityScopeSelect.appendChild(opt);
    });
    cityScopeSelect.value = selected || "";
  }
  function promptForCity(marker, latlng, cb) {
    cityResolver = cb;
    cityEditing = marker;
    const meta = marker ? marker._cityMeta : { name: "", scope: "", localChat: "" };
    cityKeyInput.value = marker ? marker._cityKey : "";
    cityKeyInput.disabled = !!marker; // dont allow renaming existing cities
    cityNameInput.value = meta.name || "";
    rebuildCityScopeSelect(meta.scope || "");
    cityChatInput.value = meta.localChat || "";
    cityError.textContent = "";
    cityModal.hidden = false;
    (marker ? cityNameInput : cityKeyInput).focus();
  }
  function resolveCity(key, meta) {
    cityModal.hidden = true;
    const cb = cityResolver;
    cityResolver = null;
    cityEditing = null;
    if (cb) cb(key, meta);
  }
  function submitCity() {
    const key = cityKeyInput.value.trim().toLowerCase();
    const name = cityNameInput.value.trim();
    const scope = cityScopeSelect.value;
    const localChat = cityChatInput.value.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(key)) {
      cityError.textContent = "Nøglen må kun indeholde små bogstaver, tal og bindestreger.";
      return;
    }
    if (!cityEditing && cities[key]) {
      cityError.textContent = "Nøglen findes allerede.";
      return;
    }
    if (!name) { cityError.textContent = "Navn er påkrævet."; return; }
    resolveCity(key, { name, scope, localChat });
  }
  cityConfirm.addEventListener("click", submitCity);
  cityCancel.addEventListener("click", () => resolveCity(null));
  cityModal.addEventListener("click", e => { if (e.target === cityModal) resolveCity(null); });
  document.addEventListener("keydown", e => {
    if (cityModal.hidden) return;
    if (e.key === "Escape") resolveCity(null);
    if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") {
      e.preventDefault();
      submitCity();
    }
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
  btnEmail.addEventListener("click", async () => {
    const changes = collectChanges();
    const cityChanges = collectCityChanges();
    if (changes.length === 0 && cityChanges.length === 0) {
      setStatus("Ingen ændringer at sende.");
      return;
    }

    const totalNew = changes.filter(c => c.change === "NEW").length + cityChanges.filter(c => c.change === "NEW").length;
    const totalMod = changes.filter(c => c.change === "MODIFIED").length + cityChanges.filter(c => c.change === "MODIFIED").length;
    const totalDel = changes.filter(c => c.change === "DELETED").length + cityChanges.filter(c => c.change === "DELETED").length;
    const subjectParts = [];
    if (totalNew) subjectParts.push(totalNew + " ny");
    if (totalMod) subjectParts.push(totalMod + " ændret");
    if (totalDel) subjectParts.push(totalDel + " slettet");
    const subject = "Bidrag: " + subjectParts.join(", ");

    function nameFor(key) {
      return (regions[key] || proposedRegions[key] || { name: key }).name;
    }

    const regionEntries = changes
      .filter(c => c.change !== "DELETED")
      .map(c => formatRegionEntry(c.region, nameFor(c.region), c.geometry));
    const cityEntries = cityChanges
      .filter(c => c.change !== "DELETED")
      .map(c => formatCityEntry(c.key, c.meta, c.latlng));

    const parts = [];
    if (regionEntries.length) parts.push("// regions.js:\n" + regionEntries.join(",\n") + ",");
    if (cityEntries.length) parts.push("// cities.js:\n" + cityEntries.join(",\n") + ",");
    const body = parts.join("\n\n") + (parts.length ? "\n" : "");

    try {
      await navigator.clipboard.writeText(body);
      setStatus("Indhold kopieret — indsæt i e-mailen med Ctrl+V.");
    } catch (err) {
      window.prompt("Kopier dette og indsæt i din e-mail til meshcore@drkt.eu:", body);
      return;
    }
    const placeholder = "(indsæt indholdet fra udklipsholderen her med Ctrl+V)";
    window.location.href = "mailto:meshcore@drkt.eu?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(placeholder);
  });

  function collectCityChanges() {
    const out = [];
    citiesLayer.eachLayer(m => {
      if (!(m instanceof L.Marker) || !m._cityKey) return;
      const ll = m.getLatLng();
      if (!m._origCityKey) {
        out.push({ change: "NEW", key: m._cityKey, meta: m._cityMeta, latlng: ll });
        return;
      }
      const moved = Math.abs(ll.lat - m._origCityLatLng.lat) > 1e-7 || Math.abs(ll.lng - m._origCityLatLng.lng) > 1e-7;
      const metaChanged = JSON.stringify(m._cityMeta) !== m._origCityMeta;
      if (moved || metaChanged) {
        out.push({ change: "MODIFIED", key: m._cityKey, meta: m._cityMeta, latlng: ll });
      }
    });
    deletedCities.forEach(d => {
      out.push({ change: "DELETED", key: d.key, meta: d.meta, latlng: d.latlng });
    });
    return out;
  }

  function collectChanges() {
    const changes = [];
    regionsLayer.eachLayer(l => {
      const gj = l.toGeoJSON();
      const key = gj.properties && gj.properties.region;
      if (!key) return;
      const currentGeom = JSON.stringify(gj.geometry);
      if (!l._origKey) {
        changes.push(buildChange("NEW", key, gj.geometry));
      } else if (l._origKey !== key || l._origGeom !== currentGeom) {
        changes.push(buildChange("MODIFIED", key, gj.geometry, l._origKey));
      }
    });
    deletedOriginals.forEach(d => {
      changes.push(buildChange("DELETED", d.region, d.geometry));
    });
    return changes;
  }

  function buildChange(change, region, geometry, oldRegion) {
    const stats = geomStats(geometry);
    return { change, region, oldRegion, geometry, vertexCount: stats.vertexCount, center: stats.center };
  }

  function geomStats(geom) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity, n = 0;
    (function walk(c) {
      if (typeof c[0] === "number" && typeof c[1] === "number") {
        if (c[0] < minLon) minLon = c[0];
        if (c[0] > maxLon) maxLon = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
        n++;
      } else {
        c.forEach(walk);
      }
    })(geom.coordinates);
    return { vertexCount: n, center: [(minLat + maxLat) / 2, (minLon + maxLon) / 2] };
  }

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

  // Format a region entry to match the existing regions.js style, so the
  // output can be pasted directly into window.MCDK_REGIONS.
  function fmtNum(n) {
    // 6 decimals matches the precision used in regions.js.
    return +n.toFixed(6);
  }
  function fmtPoint(p) {
    return "[" + fmtNum(p[0]) + ", " + fmtNum(p[1]) + "]";
  }
  function fmtRing(ring, pad) {
    const outer = " ".repeat(pad);
    const inner = " ".repeat(pad + 2);
    return outer + "[\n" +
      ring.map(p => inner + fmtPoint(p)).join(",\n") + "\n" +
      outer + "]";
  }
  function formatGeometry(geom) {
    if (geom.type === "Polygon") {
      const rings = geom.coordinates.map(r => fmtRing(r, 6)).join(",\n");
      return '{ "type": "Polygon", "coordinates": [\n' + rings + "\n    ] }";
    }
    if (geom.type === "MultiPolygon") {
      const polys = geom.coordinates.map(poly =>
        "      [\n" + poly.map(r => fmtRing(r, 8)).join(",\n") + "\n      ]"
      ).join(",\n");
      return '{ "type": "MultiPolygon", "coordinates": [\n' + polys + "\n    ] }";
    }
    return JSON.stringify(geom);
  }
  function fmtCityNum(n) {
    // 4 decimals matches the precision used in cities.js.
    return +n.toFixed(4);
  }
  function formatCityEntry(key, meta, latlng) {
    const lng = fmtCityNum(latlng.lng);
    const lat = fmtCityNum(latlng.lat);
    return "  " + JSON.stringify(key) + ": {\n" +
           '    "name": ' + JSON.stringify(meta.name || "") + ",\n" +
           '    "scope": ' + JSON.stringify(meta.scope || "") + ",\n" +
           '    "localChat": ' + JSON.stringify(meta.localChat || "") + ",\n" +
           '    "geometry": { "type": "Point", "coordinates": [' + lng + ", " + lat + "] }\n" +
           "  }";
  }
  function formatRegionEntry(key, name, geometry) {
    return "  " + JSON.stringify(key) + ": {\n" +
           '    "name": ' + JSON.stringify(name) + ",\n" +
           '    "geometry": ' + formatGeometry(geometry) + "\n" +
           "  }";
  }

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
