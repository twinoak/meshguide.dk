#!/usr/bin/env python3
"""Extract basemap + region layers from denmark-bg.svg into the website.

Workflow:
  1. Edit denmark-bg.svg in Inkscape.
  2. Run: python3 build-map.py
  3. Commit basemap.svg and index.html.

The BackgroundMap layer becomes a standalone basemap.svg referenced by
the <image> tag in index.html. The RegionScopes layer becomes the block
of <path class="region" data-region="..." /> elements between the
<!-- regions:start --> ... <!-- regions:end --> markers in index.html.
The Text layer is intentionally ignored; map labels live as plain
<text> elements in index.html so they're easy to tweak directly.
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "denmark-bg.svg"
BASEMAP_OUT = ROOT / "basemap.svg"
HTML = ROOT / "index.html"

SVG_NS = "http://www.w3.org/2000/svg"
INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape"
SODIPODI_NS = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"

ET.register_namespace("", SVG_NS)

# inkscape:label on each region <path> -> data-region used by the site.
# Edit this map if you add new regions or rename them in Inkscape.
LABEL_TO_REGION = {
    "Nordjylland":     "dk-nrj",
    "Midtjylland":     "dk-mdj",
    "Oestjylland":     "dk-oj",
    "Syddanmark":      "dk-sdk",
    "Fyn":             "dk-fyn",
    "Sjaelland":       "dk-sjl",
    "Lolland-Falster": "dk-lo-fa",
    "Bornholm":        "dk-bhm",
    "Laesoe":          "dk-ls",
    "Anholt":          "dk-aht",
    "Samsoe":          "dk-sms",
}

BASEMAP_LAYER = "BackgroundMap"
REGIONS_LAYER = "RegionScopes"
REGIONS_START = "<!-- regions:start -->"
REGIONS_END = "<!-- regions:end -->"
INDENT = "          "


def q(ns: str, name: str) -> str:
    return f"{{{ns}}}{name}"


def find_layer(root: ET.Element, label: str) -> ET.Element:
    for g in root.iter(q(SVG_NS, "g")):
        if g.get(q(INKSCAPE_NS, "label")) == label:
            return g
    raise SystemExit(f"layer not found in {SRC.name}: inkscape:label={label!r}")


def strip_inkscape(elem: ET.Element) -> None:
    """Remove Inkscape/Sodipodi attribute pollution from a subtree."""
    ink_prefix = q(INKSCAPE_NS, "")
    sodi_prefix = q(SODIPODI_NS, "")
    for node in elem.iter():
        for attr in list(node.attrib):
            if attr.startswith(ink_prefix) or attr.startswith(sodi_prefix):
                del node.attrib[attr]
        node.attrib.pop("id", None)


def write_basemap(root: ET.Element) -> None:
    src_w = root.get("width", "442.10419")
    src_h = root.get("height", "487.80353")
    src_viewbox = root.get("viewBox", f"0 0 {src_w} {src_h}")

    layer = find_layer(root, BASEMAP_LAYER)
    strip_inkscape(layer)

    new_root = ET.Element(q(SVG_NS, "svg"), {
        "viewBox": src_viewbox,
        "width": src_w,
        "height": src_h,
    })
    new_root.append(layer)

    ET.indent(new_root, space="  ")
    ET.ElementTree(new_root).write(
        BASEMAP_OUT, encoding="utf-8", xml_declaration=True
    )


def build_region_block(root: ET.Element) -> str:
    layer = find_layer(root, REGIONS_LAYER)
    transform = layer.get("transform", "").strip()
    t_attr = f' transform="{transform}"' if transform else ""

    lines: list[str] = []
    seen: set[str] = set()
    for path in layer.findall(q(SVG_NS, "path")):
        label = path.get(q(INKSCAPE_NS, "label"))
        if not label:
            print("  skip: <path> without inkscape:label", file=sys.stderr)
            continue
        region = LABEL_TO_REGION.get(label)
        if not region:
            print(f"  skip: no data-region mapping for {label!r}", file=sys.stderr)
            continue
        d = path.get("d", "").strip()
        lines.append(
            f'{INDENT}<path class="region" data-region="{region}"{t_attr} d="{d}" />'
        )
        seen.add(label)

    missing = set(LABEL_TO_REGION) - seen
    if missing:
        print(
            f"  warn: mapping entries not found in svg: {sorted(missing)}",
            file=sys.stderr,
        )
    return "\n".join(lines)


def patch_html(region_block: str) -> None:
    html = HTML.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"({re.escape(REGIONS_START)})(.*?)({re.escape(REGIONS_END)})",
        re.DOTALL,
    )
    if not pattern.search(html):
        raise SystemExit(
            f"markers not found in {HTML.name}: "
            f"{REGIONS_START} ... {REGIONS_END}"
        )
    new_html = pattern.sub(
        lambda m: f"{m.group(1)}\n{region_block}\n{INDENT}{m.group(3)}",
        html,
    )
    if new_html != html:
        HTML.write_text(new_html, encoding="utf-8")


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"source not found: {SRC}")
    tree = ET.parse(SRC)
    root = tree.getroot()
    region_block = build_region_block(root)
    write_basemap(root)
    patch_html(region_block)
    print(f"wrote {BASEMAP_OUT.name}")
    print(f"updated regions block in {HTML.name}")


if __name__ == "__main__":
    main()
