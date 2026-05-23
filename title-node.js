// Anchor a pulsing mesh node to the left of the header title and link it
// to the top-left-most existing mesh node so it looks like a participant.

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
  const link = document.createElementNS(SVG_NS, "line");
  meshGroup.appendChild(link);

  // The top-left-most node: minimum x+y. Computed once since mesh is static.
  const target = meshNodes.reduce((a, b) => (a.x + a.y <= b.x + b.y ? a : b));

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

    link.setAttribute("x1", cx);
    link.setAttribute("y1", cy);
    link.setAttribute("x2", target.x);
    link.setAttribute("y2", target.y);

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
