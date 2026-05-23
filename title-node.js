// Anchor a pulsing mesh node to the right edge of the header title.
// Finds the 2 nearest existing mesh nodes and draws lines to them, so the
// title-node looks like a genuine participant in the mesh.

(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.querySelector(".site-mesh-bg svg");
  const title = document.querySelector(".site-header h1");
  if (!svg || !title) return;

  const meshGroup = svg.querySelector(".hdr-mesh");
  const nodesGroup = svg.querySelector(".hdr-nodes");
  if (!meshGroup || !nodesGroup) return;

  // Snapshot existing mesh nodes (these are static in the source SVG).
  const meshNodes = [...nodesGroup.querySelectorAll("circle")].map((c) => ({
    x: parseFloat(c.getAttribute("cx")),
    y: parseFloat(c.getAttribute("cy")),
  }));

  // Build the dynamic elements once.
  const link1 = document.createElementNS(SVG_NS, "line");
  const link2 = document.createElementNS(SVG_NS, "line");
  meshGroup.append(link1, link2);

  const node = document.createElementNS(SVG_NS, "circle");
  node.setAttribute("r", "5");
  nodesGroup.appendChild(node);

  const pulseGroup = document.createElementNS(SVG_NS, "g");
  pulseGroup.setAttribute("class", "hdr-pulse");
  pulseGroup.setAttribute("fill", "none");
  pulseGroup.setAttribute("stroke", "#3fb950");
  pulseGroup.setAttribute("stroke-width", "1.5");
  const rings = [
    { r: 14, op: 0.8 },
    { r: 28, op: 0.4 },
    { r: 44, op: 0.15 },
  ].map(({ r, op }) => {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("r", r);
    c.setAttribute("opacity", op);
    pulseGroup.appendChild(c);
    return c;
  });
  svg.appendChild(pulseGroup);

  function clientToSvg(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    return pt.matrixTransform(ctm.inverse());
  }

  function update() {
    // Use a Range to get the actual text bbox; getBoundingClientRect() on the
    // h1 returns the full-width block rect, not where the text ends.
    const range = document.createRange();
    range.selectNodeContents(title);
    const rect = range.getBoundingClientRect();
    // Sit just to the left of the visible text, vertically centered.
    const p = clientToSvg(rect.left - 26, rect.top + rect.height / 2);
    if (!p) return;

    const cx = p.x;
    const cy = p.y;

    node.setAttribute("cx", cx);
    node.setAttribute("cy", cy);

    const nearest = meshNodes
      .map((n) => ({ n, d: (n.x - cx) ** 2 + (n.y - cy) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);

    [link1, link2].forEach((line, i) => {
      const target = nearest[i]?.n;
      if (!target) return;
      line.setAttribute("x1", cx);
      line.setAttribute("y1", cy);
      line.setAttribute("x2", target.x);
      line.setAttribute("y2", target.y);
    });

    rings.forEach((ring) => {
      ring.setAttribute("cx", cx);
      ring.setAttribute("cy", cy);
      ring.style.transformOrigin = `${cx}px ${cy}px`;
    });
  }

  update();
  window.addEventListener("resize", update);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(update);
  }
})();
