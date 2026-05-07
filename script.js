(function () {
  const regions = window.MCDK_REGIONS || {};
  const info = document.getElementById("regionInfo");
  const list = document.getElementById("regionList");
  const svgEl = document.querySelector("svg.map");
  const paths = document.querySelectorAll("svg.map .region");

  // Re-append labels and decorative groups so they paint above all paths.
  // Hit-testing now uses SVG-native isPointInFill, so DOM order doesn't matter
  // for clicks - all overlapping regions at the click point are detected.
  if (svgEl) svgEl.querySelectorAll(".label, g").forEach(el => el.parentNode.appendChild(el));

  function regionsAtClientPoint(clientX, clientY) {
    // elementsFromPoint returns every element under the cursor in z-order,
    // regardless of which one received the click. Filter to .region paths.
    return document.elementsFromPoint(clientX, clientY)
      .filter(el => el.classList && el.classList.contains("region"))
      .map(el => el.dataset.region);
  }

  function render(keys) {
    const arr = Array.isArray(keys) ? keys : (keys ? [keys] : []);
    const valid = arr.filter(k => regions[k]);
    if (valid.length === 0) {
      info.innerHTML = "";
      paths.forEach(p => p.classList.remove("active"));
      [...list.children].forEach(li => li.classList.remove("active"));
      return;
    }

    const primary = regions[valid[0]];
    let html =
      "<h3>" + valid.map(k => regions[k].name).join(" + ") + "</h3>";

    if (valid.length > 1) {
      html += "<p><strong>Overlap:</strong> denne placering er dækket af " + valid.length + " regioner. Inkludér alle scopes.</p>";
    }

    html += "<dl>";
    valid.forEach(k => {
      const r = regions[k];
      html += "<dt>" + r.name + "</dt><dd><code>" + r.channel + "</code> - " + r.coverage + "</dd>";
    });
    html += "</dl>";

    if (primary.notes && primary.notes !== "Ingen noter.") {
      html += "<p><em>" + primary.notes + "</em></p>";
    }

    let cli = "region put eu *\nregion put dk eu";
    valid.forEach(k => { cli += "\nregion put " + regions[k].channel + " dk"; });
    html += "<pre><code>" + cli + "</code></pre>";
    html += "<pre><code>region save</code></pre>";

    html += "<p>Byer er <code>dk-&lt;postnummer&gt;</code>, tilføjet som child af regionen.</p>";
    html += "<pre><code>region put dk-&lt;postnummer&gt; " + primary.channel + "</code></pre>";
    html += "<pre><code>region save</code></pre>";

    info.innerHTML = html;
    paths.forEach(p => p.classList.toggle("active", valid.includes(p.dataset.region)));
    [...list.children].forEach(li => li.classList.toggle("active", valid.includes(li.dataset.region)));
  }

  let clickMarker = null;
  function showMarker(clientX, clientY) {
    if (!svgEl) return;
    const pt = svgEl.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const svgPt = pt.matrixTransform(svgEl.getScreenCTM().inverse());
    if (!clickMarker) {
      clickMarker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      clickMarker.setAttribute("class", "click-marker");
      clickMarker.setAttribute("r", "3");
      clickMarker.setAttribute("pointer-events", "none");
    }
    clickMarker.setAttribute("cx", svgPt.x);
    clickMarker.setAttribute("cy", svgPt.y);
    svgEl.appendChild(clickMarker);
  }
  function hideMarker() {
    if (clickMarker && clickMarker.parentNode) clickMarker.parentNode.removeChild(clickMarker);
  }

  document.addEventListener("click", e => {
    if (!e.target.closest(".region, .region-list li, #regionInfo")) {
      render(null);
      hideMarker();
    }
  });

  if (svgEl) {
    svgEl.addEventListener("click", e => {
      const target = e.target;
      if (!target.classList || !target.classList.contains("region")) return;
      const hits = regionsAtClientPoint(e.clientX, e.clientY);
      render(hits.length ? hits : [target.dataset.region]);
      showMarker(e.clientX, e.clientY);
    });
  }

  paths.forEach(p => {
    p.addEventListener("keydown", e => { if (e.key === "Enter") render(p.dataset.region); });
    p.setAttribute("tabindex", "0");
    const r = regions[p.dataset.region];
    if (r) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
      t.textContent = r.name + " - " + r.channel;
      p.appendChild(t);
    }
  });

  Object.keys(regions).forEach(key => {
    const li = document.createElement("li");
    li.textContent = regions[key].name;
    li.dataset.region = key;
    li.addEventListener("click", () => render(key));
    list.appendChild(li);
  });
})();
