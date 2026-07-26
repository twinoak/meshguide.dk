(async function () {
  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("Kunne ikke hente " + url + ": " + r.status);
    return r.json();
  }

  let regions, cities;
  try {
    [regions, cities] = await Promise.all([
      fetchJSON("regions.json"),
      fetchJSON("cities.json")
    ]);
  } catch (e) {
    console.error(e);
    return;
  }
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
  const cityScopeInput = document.getElementById("cityScope");
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

  // --- Region-synlighed --------------------------------------------------
  // Alle tegnede region-lag holdes her uanset om de vises, saa eksport/diff
  // stadig ser dem alle. Kortet (regionsLayer) indeholder kun de lag hvis
  // noegle er i visibleKeys. Regioner er skjult som standard, saa man kan se
  // basemap og de nederste lag; brug knapperne under kortet for at vise dem.
  const allRegionLayers = new Set();
  regionsLayer.eachLayer(l => allRegionLayers.add(l));
  const visibleKeys = new Set();

  const togglesListEl = document.getElementById("regionTogglesList");
  const btnShowAll = document.getElementById("btnShowAll");
  const btnHideAll = document.getElementById("btnHideAll");

  function keyOfLayer(l) {
    return l.feature && l.feature.properties && l.feature.properties.region;
  }
  function currentRegionKeys() {
    const keys = new Set();
    allRegionLayers.forEach(l => { const k = keyOfLayer(l); if (k) keys.add(k); });
    return [...keys].sort();
  }
  function applyVisibility() {
    allRegionLayers.forEach(l => {
      const key = keyOfLayer(l);
      const show = key && visibleKeys.has(key);
      const inGroup = regionsLayer.hasLayer(l);
      if (show && !inGroup) regionsLayer.addLayer(l);
      else if (!show && inGroup) regionsLayer.removeLayer(l);
    });
  }
  function setKeyVisible(key, visible) {
    if (visible) visibleKeys.add(key); else visibleKeys.delete(key);
    applyVisibility();
    rebuildRegionToggles();
  }
  function rebuildRegionToggles() {
    if (!togglesListEl) return;
    const keys = currentRegionKeys();
    // Ryd synligheds-flag for noegler der ikke laengere har et lag.
    [...visibleKeys].forEach(k => { if (!keys.includes(k)) visibleKeys.delete(k); });
    togglesListEl.innerHTML = "";
    if (!keys.length) {
      const empty = document.createElement("span");
      empty.className = "region-toggles-empty";
      empty.textContent = "Ingen regioner.";
      togglesListEl.appendChild(empty);
      return;
    }
    keys.forEach(key => {
      const on = visibleKeys.has(key);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "region-toggle" + (on ? " active" : "");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.textContent = key + " — " + nameForRegion(key);
      btn.addEventListener("click", () => setKeyVisible(key, !visibleKeys.has(key)));
      togglesListEl.appendChild(btn);
    });
  }
  if (btnShowAll) btnShowAll.addEventListener("click", () => {
    currentRegionKeys().forEach(k => visibleKeys.add(k));
    applyVisibility();
    rebuildRegionToggles();
  });
  if (btnHideAll) btnHideAll.addEventListener("click", () => {
    visibleKeys.clear();
    applyVisibility();
    rebuildRegionToggles();
  });

  // Skjul alle regioner som standard.
  applyVisibility();
  rebuildRegionToggles();

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
      allRegionLayers.add(layer);
      visibleKeys.add(key);
      regionsLayer.addLayer(layer);
      rebuildRegionToggles();
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
      visibleKeys.add(key);
      applyVisibility();
      rebuildRegionToggles();
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
    allRegionLayers.delete(l);
    rebuildRegionToggles();
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
  function deriveKeyFromChat(chat) {
    return chat.replace(/^#/, "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function deriveNameFromChat(chat) {
    const slug = chat.replace(/^#/, "").trim();
    if (!slug) return "";
    return slug.charAt(0).toUpperCase() + slug.slice(1);
  }
  function promptForCity(marker, latlng, cb) {
    cityResolver = cb;
    cityEditing = marker;
    const meta = marker ? marker._cityMeta : { scope: "", localChat: "" };
    cityChatInput.value = meta.localChat || "";
    cityScopeInput.value = meta.scope || "";
    cityError.textContent = "";
    cityModal.hidden = false;
    cityChatInput.focus();
  }
  function resolveCity(key, meta) {
    cityModal.hidden = true;
    const cb = cityResolver;
    cityResolver = null;
    cityEditing = null;
    if (cb) cb(key, meta);
  }
  function submitCity() {
    const localChat = cityChatInput.value.trim();
    const scope = cityScopeInput.value.trim();
    if (!localChat) { cityError.textContent = "Chat-kanal er påkrævet."; return; }
    const key = cityEditing ? cityEditing._cityKey : deriveKeyFromChat(localChat);
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(key)) {
      cityError.textContent = "Kunne ikke udlede en gyldig nøgle fra chat-kanalen.";
      return;
    }
    if (!cityEditing && cities[key]) {
      cityError.textContent = "En by med nøglen " + key + " findes allerede.";
      return;
    }
    const name = (cityEditing && cityEditing._cityMeta && cityEditing._cityMeta.name) || deriveNameFromChat(localChat);
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
  function nameForRegion(key) {
    return (regions[key] || proposedRegions[key] || { name: key }).name;
  }
  function fileSection(title, news, mods, dels, formatFn, keyFn) {
    if (!news.length && !mods.length && !dels.length) return "";
    let out = "=== " + title + " ===\n";
    if (news.length) {
      out += "\n# NYE entries (tilfoej til " + title + "):\n";
      out += news.map(formatFn).join(",\n") + "\n";
    }
    if (mods.length) {
      out += "\n# AENDREDE entries (udskift eksisterende med samme noegle):\n";
      out += mods.map(c => {
        const body = formatFn(c);
        if (c.oldRegion && c.oldRegion !== c.region) {
          return "// (omdoebt fra \"" + c.oldRegion + "\" — husk at fjerne den gamle noegle)\n" + body;
        }
        return body;
      }).join(",\n") + "\n";
    }
    if (dels.length) {
      out += "\n# SLETTEDE noegler (fjern fra " + title + "):\n";
      out += dels.map(c => "  " + JSON.stringify(keyFn(c))).join("\n") + "\n";
    }
    return out;
  }
  function buildChangeBlock() {
    const rc = collectChanges();
    const cc = collectCityChanges();
    const rSec = fileSection(
      "regions.json",
      rc.filter(c => c.change === "NEW"),
      rc.filter(c => c.change === "MODIFIED"),
      rc.filter(c => c.change === "DELETED"),
      c => formatRegionEntry(c.region, nameForRegion(c.region), c.geometry),
      c => c.region
    );
    const cSec = fileSection(
      "cities.json",
      cc.filter(c => c.change === "NEW"),
      cc.filter(c => c.change === "MODIFIED"),
      cc.filter(c => c.change === "DELETED"),
      c => formatCityEntry(c.key, c.meta, c.latlng),
      c => c.key
    );
    return [rSec, cSec].filter(Boolean).join("\n");
  }

  btnCopy.addEventListener("click", async () => {
    const text = buildChangeBlock();
    if (!text) { setStatus("Ingen ændringer at kopiere."); return; }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Ændringer kopieret til udklipsholder.");
    } catch (err) {
      window.prompt("Kopier manuelt:", text);
    }
  });
  btnEmail.addEventListener("click", async () => {
    const body = buildChangeBlock();
    if (!body) { setStatus("Ingen ændringer at sende."); return; }

    const totalNew = collectChanges().filter(c => c.change === "NEW").length + collectCityChanges().filter(c => c.change === "NEW").length;
    const totalMod = collectChanges().filter(c => c.change === "MODIFIED").length + collectCityChanges().filter(c => c.change === "MODIFIED").length;
    const totalDel = collectChanges().filter(c => c.change === "DELETED").length + collectCityChanges().filter(c => c.change === "DELETED").length;
    const subjectParts = [];
    if (totalNew) subjectParts.push(totalNew + " ny");
    if (totalMod) subjectParts.push(totalMod + " ændret");
    if (totalDel) subjectParts.push(totalDel + " slettet");
    const subject = "Bidrag: " + subjectParts.join(", ");

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
    allRegionLayers.forEach(l => {
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
    const fc = { type: "FeatureCollection", features: [] };
    allRegionLayers.forEach(l => {
      const gj = l.toGeoJSON();
      if (gj.type === "Feature" && gj.properties && gj.properties.region) fc.features.push(gj);
      else if (gj.type === "FeatureCollection") fc.features.push(...gj.features.filter(f => f.properties && f.properties.region));
    });
    citiesLayer.eachLayer(m => {
      if (!(m instanceof L.Marker) || !m._cityKey) return;
      const ll = m.getLatLng();
      fc.features.push({
        type: "Feature",
        properties: { city: m._cityKey, name: m._cityMeta.name, scope: m._cityMeta.scope, localChat: m._cityMeta.localChat },
        geometry: { type: "Point", coordinates: [ll.lng, ll.lat] }
      });
    });
    const text = JSON.stringify(fc, null, 2);
    const blob = new Blob([text], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mcdk-export.geojson";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus("Downloaded " + fc.features.length + " features.");
  });

  // Format a region entry to match the existing regions.json style, so the
  // output can be pasted directly into the JSON file.
  function fmtNum(n) {
    // 6 decimals matches the precision used in regions.json.
    return +n.toFixed(6);
  }
  function formatGeometry(geom) {
    // Compact single-line form matching regions.json: no spaces after
    // colons/commas, coordinates rounded to 6 decimals.
    return JSON.stringify(geom, (k, v) => typeof v === "number" ? fmtNum(v) : v);
  }
  function fmtCityNum(n) {
    // 4 decimals matches the precision used in cities.json.
    return +n.toFixed(4);
  }
  function formatCityEntry(key, meta, latlng) {
    const lng = fmtCityNum(latlng.lng);
    const lat = fmtCityNum(latlng.lat);
    return "  " + JSON.stringify(key) + ": {\"name\":" + JSON.stringify(meta.name || "") +
           ",\"scope\":" + JSON.stringify(meta.scope || "") +
           ",\"localChat\":" + JSON.stringify(meta.localChat || "") +
           ",\"geometry\":{\"type\":\"Point\",\"coordinates\":[" + lng + "," + lat + "]}}";
  }
  function formatRegionEntry(key, name, geometry) {
    return "  " + JSON.stringify(key) + ": {\"name\":" + JSON.stringify(name) +
           ",\"geometry\":" + formatGeometry(geometry) + "}";
  }

  function setStatus(msg) {
    statusEl.textContent = msg;
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => { statusEl.textContent = ""; }, 4000);
  }
})();
