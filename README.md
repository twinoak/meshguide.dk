## Vil du rette regionerne på kortet?

Åbn `edit.html` i en browser. Det er en in-page region-editor:

- Tegn nye polygoner med polygon-værktøjet i venstre side (klik punkter, dobbeltklik for at afslutte).
- Når et polygon er færdigt, vælg hvilken `dk-xx`-region det hører til.
- Klik et eksisterende polygon for at ændre dets region-nøgle, eller brug edit-/slet-værktøjet til at justere geometri.
- Brug **Kopier GeoJSON** eller **Download .geojson** og send resultatet til vedligeholderen via Discord eller mesh'et.

## Kortets opbygning

- `regions.geojson.js` indeholder polygon-geometrien som en GeoJSON `FeatureCollection`. Hver feature har `properties.region` som matcher en nøgle i `regions.js`.
- `regions.js` indeholder per-region metadata (navn, kanal, dækning, noter).
- `cities.geojson.js` + `MCDK_CITIES` i `regions.js` håndterer bymarkører og deres popup-info.
- `script.js` renderer kortet (Leaflet + CARTO dark tiles) på `index.html`.
- `edit.js` driver region-editoren på `edit.html` (Leaflet-Geoman).

## Tilføj en ny region

1. Tilføj region-metadata i `regions.js` (nøgle, navn, channel).
2. Tilføj en farve til `REGION_COLORS` i både `script.js` og `edit.js`.
3. Åbn `edit.html`, tegn polygonen, vælg den nye nøgle, og indsæt det eksporterede GeoJSON i `regions.geojson.js`.
