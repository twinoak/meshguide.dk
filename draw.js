(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.getElementById("canvas");
  const savedLayer = document.getElementById("savedLayer");
  const draftLayer = document.getElementById("draftLayer");
  const vertexLayer = document.getElementById("vertexLayer");
  const regionSel = document.getElementById("regionSel");
  const statusList = document.getElementById("statusList");
  const output = document.getElementById("output");
  const refImg = document.getElementById("refImg");
  const refFile = document.getElementById("refFile");
  const refOpacity = document.getElementById("refOpacity");

  // shapes[regionKey] = array of polygons; each polygon is array of [x,y]
  const shapes = {};
  const regions = window.MCDK_REGIONS || {};
  Object.keys(regions).forEach(k => { shapes[k] = []; });

  let current = Object.keys(regions)[0] || null;
  let draftPts = [];      // polygon being drawn
  let dragInfo = null;    // { kind: 'draft'|'saved', regionKey, polyIdx, ptIdx }

  // ---------- region dropdown ----------
  Object.keys(regions).forEach(k => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = regions[k].name;
    regionSel.appendChild(opt);
  });
  if (current) regionSel.value = current;
  regionSel.addEventListener("change", () => {
    current = regionSel.value;
    cancelDraft();
    redraw();
  });

  // ---------- coordinate helpers ----------
  function svgPoint(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = svg.getScreenCTM().inverse();
    const p = pt.matrixTransform(ctm);
    return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
  }

  // ---------- input ----------
  svg.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    // start drag if hitting a vertex or saved path?
    const target = e.target;
    if (target.classList.contains("vertex")) {
      dragInfo = JSON.parse(target.dataset.drag);
      e.preventDefault();
      return;
    }
    if (target.classList.contains("saved-path")) {
      // select that region
      const key = target.dataset.region;
      if (key && key !== current) {
        regionSel.value = key;
        current = key;
        cancelDraft();
        redraw();
      }
      return;
    }
    // otherwise: add point to draft
    if (!current) return;
    draftPts.push(svgPoint(e));
    redraw();
  });

  svg.addEventListener("mousemove", e => {
    if (!dragInfo) return;
    const [x, y] = svgPoint(e);
    if (dragInfo.kind === "draft") {
      draftPts[dragInfo.ptIdx] = [x, y];
    } else {
      shapes[dragInfo.regionKey][dragInfo.polyIdx][dragInfo.ptIdx] = [x, y];
    }
    redraw();
  });

  window.addEventListener("mouseup", () => { dragInfo = null; });

  svg.addEventListener("dblclick", e => {
    e.preventDefault();
    finishDraft();
  });

  svg.addEventListener("contextmenu", e => {
    e.preventDefault();
    finishDraft();
  });

  document.addEventListener("keydown", e => {
    // ignore when typing in inputs
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "Enter") { e.preventDefault(); finishDraft(); }
    else if (e.key === "Escape") { cancelDraft(); }
    else if (e.key === "z" || e.key === "Z") { undoPoint(); }
  });

  document.getElementById("finishBtn").onclick = finishDraft;
  document.getElementById("undoBtn").onclick = undoPoint;
  document.getElementById("cancelBtn").onclick = cancelDraft;
  document.getElementById("clearSelBtn").onclick = () => {
    if (!current) return;
    if (!confirm("Slet alle polygoner for " + regions[current].name + "?")) return;
    shapes[current] = [];
    cancelDraft();
    redraw();
  };
  document.getElementById("exportBtn").onclick = exportPaths;
  document.getElementById("copyBtn").onclick = () => {
    output.select();
    document.execCommand("copy");
  };
  document.getElementById("saveLocal").onclick = () => {
    localStorage.setItem("mcdk_shapes", JSON.stringify(shapes));
    alert("Gemt i browser.");
  };
  document.getElementById("loadLocal").onclick = () => {
    const raw = localStorage.getItem("mcdk_shapes");
    if (!raw) { alert("Ingen gemt data."); return; }
    try {
      const data = JSON.parse(raw);
      Object.keys(shapes).forEach(k => { shapes[k] = data[k] || []; });
      cancelDraft();
      redraw();
    } catch (err) { alert("Kunne ikke indlæse: " + err.message); }
  };

  // ---------- ref image ----------
  refFile.addEventListener("change", () => {
    const f = refFile.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    refImg.setAttributeNS("http://www.w3.org/1999/xlink", "href", url);
    refImg.setAttribute("href", url);
    refImg.style.display = "";
  });
  refOpacity.addEventListener("input", () => {
    refImg.setAttribute("opacity", String(refOpacity.value / 100));
  });

  // ---------- draft ops ----------
  function finishDraft() {
    if (!current || draftPts.length < 3) return;
    shapes[current].push(draftPts.slice());
    draftPts = [];
    redraw();
  }
  function cancelDraft() { draftPts = []; redraw(); }
  function undoPoint() { draftPts.pop(); redraw(); }

  // ---------- rendering ----------
  function pointsToPathD(poly) {
    if (poly.length === 0) return "";
    let d = "M" + poly[0][0] + "," + poly[0][1];
    for (let i = 1; i < poly.length; i++) d += " L" + poly[i][0] + "," + poly[i][1];
    return d + " Z";
  }
  function polygonsToPathD(polys) {
    return polys.map(pointsToPathD).join(" ");
  }
  function centroid(poly) {
    let x = 0, y = 0;
    poly.forEach(p => { x += p[0]; y += p[1]; });
    return [x / poly.length, y / poly.length];
  }

  function redraw() {
    svg.classList.toggle("drafting", draftPts.length > 0);
    // saved
    savedLayer.innerHTML = "";
    Object.keys(shapes).forEach(key => {
      const polys = shapes[key];
      if (polys.length === 0) return;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", polygonsToPathD(polys));
      path.setAttribute("class", "saved-path" + (key === current ? " selected" : ""));
      path.dataset.region = key;
      savedLayer.appendChild(path);

      // label at largest polygon's centroid
      const biggest = polys.reduce((a,b) => b.length > a.length ? b : a);
      const [cx, cy] = centroid(biggest);
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "saved-label");
      label.setAttribute("x", cx);
      label.setAttribute("y", cy);
      label.textContent = regions[key].name;
      savedLayer.appendChild(label);
    });

    // draft
    draftLayer.innerHTML = "";
    if (draftPts.length > 0) {
      if (draftPts.length >= 2) {
        const line = document.createElementNS(SVG_NS, "path");
        let d = "M" + draftPts[0][0] + "," + draftPts[0][1];
        for (let i = 1; i < draftPts.length; i++) d += " L" + draftPts[i][0] + "," + draftPts[i][1];
        if (draftPts.length >= 3) d += " Z";
        line.setAttribute("d", d);
        line.setAttribute("class", "draft-line");
        draftLayer.appendChild(line);
      }
    }

    // vertices
    vertexLayer.innerHTML = "";
    // saved vertices (only for current region, so user can adjust)
    if (current && shapes[current]) {
      shapes[current].forEach((poly, polyIdx) => {
        poly.forEach((pt, ptIdx) => {
          addVertex(pt, "saved", { kind: "saved", regionKey: current, polyIdx, ptIdx });
        });
      });
    }
    // draft vertices
    draftPts.forEach((pt, ptIdx) => {
      addVertex(pt, ptIdx === 0 ? "first" : "", { kind: "draft", ptIdx });
    });

    // status list
    statusList.innerHTML = "";
    Object.keys(regions).forEach(k => {
      const li = document.createElement("li");
      const polys = shapes[k];
      const ptCount = polys.reduce((s, p) => s + p.length, 0);
      const label = document.createElement("span");
      label.textContent = regions[k].name;
      const stat = document.createElement("span");
      if (polys.length > 0) {
        stat.className = "ok";
        stat.textContent = polys.length + " polygon" + (polys.length === 1 ? "" : "er") + " · " + ptCount + " pkt";
      } else {
        stat.className = "miss";
        stat.textContent = "tom";
      }
      li.appendChild(label);
      li.appendChild(stat);
      statusList.appendChild(li);
    });
  }

  function addVertex(pt, extraClass, dragData) {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", pt[0]);
    c.setAttribute("cy", pt[1]);
    c.setAttribute("r", 4);
    c.setAttribute("class", "vertex" + (extraClass ? " " + extraClass : ""));
    c.dataset.drag = JSON.stringify(dragData);
    vertexLayer.appendChild(c);
  }

  // ---------- export ----------
  function exportPaths() {
    const lines = [];
    Object.keys(shapes).forEach(k => {
      const polys = shapes[k];
      if (polys.length === 0) return;
      const d = polygonsToPathD(polys);
      lines.push('<path class="region" data-region="' + k + '" d="' + d + '" />');
    });
    output.value = lines.join("\n") || "// Ingen polygoner endnu";
  }

  redraw();
})();
