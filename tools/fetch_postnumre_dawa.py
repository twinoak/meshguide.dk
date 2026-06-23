#!/usr/bin/env python3
# Henter postnumre fra DAWA (api.dataforsyningen.dk), forenkler geometrien og
# skriver postnumre.json i samme stil som regions.json.
#
# Brug: python3 tools/fetch_postnumre_dawa.py [postnumre.json]
#
# Kommunekoderne nedenfor dækker Fyn og Sjælland. Tilføj flere lister for at
# udvide til Jylland osv. Lolland-Falster (0360, 0376) og Bornholm (0400, 0411)
# er bevidst udeladt — de har egne regioner (dk-lo-fa, dk-bhm).

import argparse
import json
import math
import os
import sys
import time
import urllib.error
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

# Sjælland = Region Hovedstaden (uden Bornholm) + Region Sjælland (uden
# Lolland og Guldborgsund). Dækker postnumrene ~1000–4793, inkl. Møn.
SJAELLAND_KOMMUNER = [
    ("0101", "København"),
    ("0147", "Frederiksberg"),
    ("0151", "Ballerup"),
    ("0153", "Brøndby"),
    ("0155", "Dragør"),
    ("0157", "Gentofte"),
    ("0159", "Gladsaxe"),
    ("0161", "Glostrup"),
    ("0163", "Herlev"),
    ("0165", "Albertslund"),
    ("0167", "Hvidovre"),
    ("0169", "Høje-Taastrup"),
    ("0173", "Lyngby-Taarbæk"),
    ("0175", "Rødovre"),
    ("0183", "Ishøj"),
    ("0185", "Tårnby"),
    ("0187", "Vallensbæk"),
    ("0190", "Furesø"),
    ("0201", "Allerød"),
    ("0210", "Fredensborg"),
    ("0217", "Helsingør"),
    ("0219", "Hillerød"),
    ("0223", "Hørsholm"),
    ("0230", "Rudersdal"),
    ("0240", "Egedal"),
    ("0250", "Frederikssund"),
    ("0260", "Halsnæs"),
    ("0270", "Gribskov"),
    ("0253", "Greve"),
    ("0259", "Køge"),
    ("0265", "Roskilde"),
    ("0269", "Solrød"),
    ("0306", "Odsherred"),
    ("0316", "Holbæk"),
    ("0320", "Faxe"),
    ("0326", "Kalundborg"),
    ("0329", "Ringsted"),
    ("0330", "Slagelse"),
    ("0336", "Stevns"),
    ("0340", "Sorø"),
    ("0350", "Lejre"),
    ("0370", "Næstved"),
    ("0390", "Vordingborg"),
]

# Hver landsdel skrives som sin egen fil (postnumre/<key>.json) og indlæses
# først når et klik rammer dens bounding box — så et klik på Fyn ikke henter
# Sjællands postnumre. Tilføj nye landsdele her.
LANDSDELE = [
    ("fyn", FYN_KOMMUNER),
    ("sjaelland", SJAELLAND_KOMMUNER),
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


def fetch_json(url, retries=5):
    # DAWA rate-limiter (HTTP 429) rammer ved mange hurtige kald — vent og prøv
    # igen med eksponentiel backoff.
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                wait = 2 ** attempt
                print(f"  429 — venter {wait}s og prøver igen", file=sys.stderr)
                time.sleep(wait)
                continue
            raise


def update_bbox(coords, bb):
    # Udvider bb=[minlon, minlat, maxlon, maxlat] in-place med alle punkter i en
    # vilkaarligt nested coordinate-struktur.
    if isinstance(coords[0], (int, float)):
        x, y = coords[0], coords[1]
        bb[0] = min(bb[0], x)
        bb[1] = min(bb[1], y)
        bb[2] = max(bb[2], x)
        bb[3] = max(bb[3], y)
    else:
        for c in coords:
            update_bbox(c, bb)


def write_entries(path, entries):
    # Pretty-ish JSON: top-level keys en pr. linje, geometri kompakt.
    lines = [
        "  " + json.dumps(k) + ": "
        + json.dumps(v, separators=(",", ":"), ensure_ascii=False)
        for k, v in sorted(entries.items())
    ]
    with open(path, "w") as f:
        f.write("{\n" + ",\n".join(lines) + "\n}\n")


def fetch_landsdel(kommuner, args):
    # 1. Saml unikke postnummer-numre fra landsdelens kommuner.
    numbers = set()
    for code, name in kommuner:
        url = f"https://api.dataforsyningen.dk/postnumre?kommunekode={code}"
        data = fetch_json(url)
        for p in data:
            numbers.add(p["nr"])
        print(f"  {code} {name}: {len(data)} postnumre", file=sys.stderr)

    # 2. Hent fuld geometri som GeoJSON per postnummer.
    entries = {}
    bb = [math.inf, math.inf, -math.inf, -math.inf]
    before = after = 0
    for nr in sorted(numbers):
        url = f"https://api.dataforsyningen.dk/postnumre/{nr}?format=geojson"
        gj = fetch_json(url)
        time.sleep(0.1)  # skån DAWA's rate-limiter ved mange postnumre
        geom = gj.get("geometry")
        if not geom:
            print(f"  skip {nr}: ingen geometri", file=sys.stderr)
            continue
        coords = process_coords(geom["coordinates"], args.epsilon, args.precision)
        before += vertex_count(geom["coordinates"])
        after += vertex_count(coords)
        update_bbox(coords, bb)
        key = f"{args.prefix}{nr}"
        entries[key] = {
            "name": key,
            "geometry": {"type": geom["type"], "coordinates": coords},
        }
    bbox = [round(v, args.precision) for v in bb] if entries else None
    return entries, bbox, before, after


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir", nargs="?", default="postnumre")
    ap.add_argument("--epsilon", type=float, default=0.0001)
    ap.add_argument("--precision", type=int, default=4)
    ap.add_argument("--prefix", default="dk")
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    # Hver landsdel skrives som sin egen fil; manifestet (index.json) kobler hver
    # fil til dens bounding box, saa klienten kun henter de relevante.
    manifest = []
    total_before = total_after = total_entries = 0
    for key, kommuner in LANDSDELE:
        print(f"== {key} ==", file=sys.stderr)
        entries, bbox, before, after = fetch_landsdel(kommuner, args)
        fname = f"{key}.json"
        write_entries(os.path.join(args.outdir, fname), entries)
        manifest.append({"key": key, "file": fname, "bbox": bbox, "count": len(entries)})
        total_before += before
        total_after += after
        total_entries += len(entries)
        print(f"  -> {fname}: {len(entries)} postnumre, bbox {bbox}", file=sys.stderr)

    with open(os.path.join(args.outdir, "index.json"), "w") as f:
        json.dump({"files": manifest}, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"\nentries: {total_entries}")
    print(f"vertices: {total_before} -> {total_after}  "
          f"({100 * total_after // max(total_before, 1)}%)")
    print(f"output: {args.outdir}/ ({len(manifest)} landsdele + index.json)")


if __name__ == "__main__":
    main()
