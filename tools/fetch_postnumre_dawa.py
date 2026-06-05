#!/usr/bin/env python3
# Henter postnumre fra DAWA (api.dataforsyningen.dk), forenkler geometrien og
# skriver postnumre.json i samme stil som regions.json.
#
# Brug: python3 tools/fetch_postnumre_dawa.py [postnumre.json]
#
# Kommunekoderne nedenfor daekker hele Fyn (10 kommuner). Tilfoej flere for at
# udvide til Sjaelland osv.

import argparse
import json
import math
import os
import sys
import urllib.request

FYN_KOMMUNER = [
    ("0410", "Middelfart"),
    ("0420", "Assens"),
    ("0430", "Faaborg-Midtfyn"),
    ("0440", "Kerteminde"),
    ("0450", "Nyborg"),
    ("0461", "Odense"),
    ("0479", "Svendborg"),
    ("0480", "Nordfyns"),
    ("0482", "Langeland"),
    ("0492", "Ærø"),
]


def perpendicular_distance(pt, a, b):
    if a == b:
        return math.hypot(pt[0] - a[0], pt[1] - a[1])
    x0, y0 = pt
    x1, y1 = a
    x2, y2 = b
    num = abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1)
    den = math.hypot(y2 - y1, x2 - x1)
    return num / den


def douglas_peucker(points, eps):
    if len(points) < 3:
        return list(points)
    dmax, idx = 0.0, 0
    a, b = points[0], points[-1]
    for i in range(1, len(points) - 1):
        d = perpendicular_distance(points[i], a, b)
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        left = douglas_peucker(points[: idx + 1], eps)
        right = douglas_peucker(points[idx:], eps)
        return left[:-1] + right
    return [a, b]


def simplify_ring(ring, eps):
    if len(ring) < 4:
        return ring
    s = douglas_peucker(ring, eps)
    if len(s) < 4:
        return ring
    if s[0] != s[-1]:
        s.append(s[0])
    return s


def process_coords(coords, eps, precision):
    if coords and isinstance(coords[0][0], (int, float)):
        ring = simplify_ring(coords, eps)
        return [[round(x, precision), round(y, precision)] for x, y in ring]
    return [process_coords(c, eps, precision) for c in coords]


def vertex_count(coords):
    if isinstance(coords[0], (int, float)):
        return 1
    return sum(vertex_count(c) for c in coords)


def fetch_json(url):
    with urllib.request.urlopen(url) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("output", nargs="?", default="postnumre.json")
    ap.add_argument("--epsilon", type=float, default=0.0001)
    ap.add_argument("--precision", type=int, default=4)
    ap.add_argument("--prefix", default="dk")
    args = ap.parse_args()

    # 1. Saml unikke postnummer-numre fra de relevante kommuner.
    numbers = set()
    for code, name in FYN_KOMMUNER:
        url = f"https://api.dataforsyningen.dk/postnumre?kommunekode={code}"
        data = fetch_json(url)
        for p in data:
            numbers.add(p["nr"])
        print(f"  {code} {name}: {len(data)} postnumre", file=sys.stderr)
    print(f"unique postnumre: {len(numbers)}", file=sys.stderr)

    # 2. Hent fuld geometri som GeoJSON per postnummer.
    entries = {}
    before = after = 0
    for nr in sorted(numbers):
        url = f"https://api.dataforsyningen.dk/postnumre/{nr}?format=geojson"
        gj = fetch_json(url)
        geom = gj.get("geometry")
        if not geom:
            print(f"  skip {nr}: ingen geometri", file=sys.stderr)
            continue
        coords = geom["coordinates"]
        before += vertex_count(coords)
        coords = process_coords(coords, args.epsilon, args.precision)
        after += vertex_count(coords)
        key = f"{args.prefix}{nr}"
        entries[key] = {
            "name": key,
            "geometry": {"type": geom["type"], "coordinates": coords},
        }
        print(f"  {nr}: {vertex_count(geom['coordinates'])} -> "
              f"{vertex_count(coords)} verts", file=sys.stderr)

    # 3. Skriv en pretty-ish JSON: top-level keys en pr. linje, geometri kompakt.
    sorted_entries = sorted(entries.items())
    lines = [
        "  " + json.dumps(k) + ": "
        + json.dumps(v, separators=(",", ":"), ensure_ascii=False)
        for k, v in sorted_entries
    ]
    with open(args.output, "w") as f:
        f.write("{\n" + ",\n".join(lines) + "\n}\n")

    out_kb = os.path.getsize(args.output) // 1024
    print(f"\nentries: {len(entries)}")
    print(f"vertices: {before} -> {after}  ({100 * after // max(before,1)}%)")
    print(f"output: {args.output} ({out_kb} KB)")


if __name__ == "__main__":
    main()
