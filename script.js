(function () {
  const regions = window.MCDK_REGIONS || {};
  const info = document.getElementById("regionInfo");
  const list = document.getElementById("regionList");
  const paths = document.querySelectorAll("svg.map .region");

  // One-shot order: smallest regions last in DOM so clicks on a small region
  // enclosed by a larger one still hit the small one. Visual stacking is
  // handled by CSS (mix-blend-mode + fill-opacity), not by reordering.
  (function orderForHitTest() {
    const svgEl = document.querySelector("svg.map");
    if (!svgEl) return;
    const arr = [...paths];
    arr.forEach(p => { const b = p.getBBox(); p.__area = b.width * b.height; });
    arr.sort((a, b) => b.__area - a.__area);
    const parent = arr[0] && arr[0].parentNode;
    if (parent) arr.forEach(p => parent.appendChild(p));
    // Re-append labels and decorative groups so they paint above all paths.
    svgEl.querySelectorAll(".label, g").forEach(el => el.parentNode.appendChild(el));
  })();

  function render(key) {
    const r = regions[key];
    if (!r) {
      info.innerHTML = "";
      paths.forEach(p => p.classList.remove("active"));
      [...list.children].forEach(li => li.classList.remove("active"));
      return;
    }
    info.innerHTML =
      "<h3>" + r.name + "</h3>" +
      "<dl>" +
        "<dt>Region Scope</dt><dd>" + r.channel + "</dd>" +
        "<dt>Dækning</dt><dd>" + r.coverage + "</dd>" +
        "<dt>Bemærkninger</dt><dd>" + r.notes + "</dd>" +
      "</dl>";
    paths.forEach(p => p.classList.toggle("active", p.dataset.region === key));
    [...list.children].forEach(li => li.classList.toggle("active", li.dataset.region === key));
  }

  document.addEventListener("click", e => {
    if (!e.target.closest(".region, .region-list li")) render(null);
  });

  paths.forEach(p => {
    p.addEventListener("click", () => render(p.dataset.region));
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
