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
    const l = e.layer;
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
    if (changes.length === 0) {
      setStatus("Ingen ændringer at sende.");
      return;
    }

    const byType = { NEW: [], MODIFIED: [], DELETED: [] };
    changes.forEach(c => byType[c.change].push(c));
    const newKeys = Object.keys(proposedRegions).filter(k => changes.some(c => c.region === k));

    const subjectParts = [];
    if (byType.NEW.length) subjectParts.push(byType.NEW.length + " ny");
    if (byType.MODIFIED.length) subjectParts.push(byType.MODIFIED.length + " ændret");
    if (byType.DELETED.length) subjectParts.push(byType.DELETED.length + " slettet");
    const subjectTag = newKeys.length ? " [NY SCOPE: " + newKeys.join(", ") + "]" : "";
    const subject = "Region-bidrag: " + subjectParts.join(", ") + subjectTag;

    let newRegionBlock = "";
    if (newKeys.length) {
      newRegionBlock = "Nye scopes (tilføj til regions.js):\n";
      newKeys.forEach(k => {
        newRegionBlock +=
          "  \"" + k + "\": { name: " + JSON.stringify(proposedRegions[k].name) + " },\n";
      });
      newRegionBlock += "\n";
    }

    const summaryLines = changes.map(c => {
      const ctr = c.center.map(v => v.toFixed(3)).join(", ");
      const tag = c.change === "MODIFIED" && c.oldRegion && c.oldRegion !== c.region
        ? c.oldRegion + " → " + c.region
        : c.region;
      return "  [" + c.change.padEnd(8) + "] " + tag.padEnd(14) + " " + c.vertexCount + " hjørner, center " + ctr;
    }).join("\n");

    const fc = {
      type: "FeatureCollection",
      features: changes.map(c => ({
        type: "Feature",
        properties: { region: c.region, change: c.change },
        geometry: c.geometry
      }))
    };
    const geo = JSON.stringify(fc, null, 2);

    const body = newRegionBlock + geo + "\n";

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
