## Vil du rette regionerne på kortet?

Åbn `edit.html` i en browser. Det er en in-page region-editor:

- Tegn nye polygoner med polygon-værktøjet i venstre side (klik punkter, dobbeltklik for at afslutte).
- Når et polygon er færdigt, vælg hvilken `dk-xx`-region det hører til.
- Klik et eksisterende polygon for at ændre dets region-nøgle, eller brug edit-/slet-værktøjet til at justere geometri.
- Brug **Kopier GeoJSON** eller **Download .geojson** og send resultatet til vedligeholderen via Discord eller mesh'et.

## Kortets opbygning

Data ligger i tre JSON-filer, der hentes dovent med `fetch()`:

- `regions.json` - håndkuraterede regioner (`dk-fyn`, `dk-jylland`, …). Hentes ved indlæsning af [index.html](index.html) og [edit.html](edit.html).
- `cities.json` - bymarkører + deres popup-info. Hentes sammen med regions.
- `postnumre/` - postnummer-polygoner (`dk5000`, `dk5230`, …) delt op pr. landsdel: `postnumre/fyn.json`, `postnumre/sjaelland.json`, … plus `postnumre/index.json`, et manifest der kobler hver fil til dens bounding box. Hentes først ved klik på kortet i [index.html](index.html), og kun de filer hvis bbox dækker klikket - et klik på Fyn henter altså ikke Sjællands postnumre. Data fra flere klik akkumuleres.

Hierarkiske scopes udledes af noeglen efter lag-konventionen `dk5` → `dk5x` → `dk5xx` → `dk5230`: et klik der rammer `dk5230` udvides til `dk5`, `dk52`, `dk523`, `dk5230` i CLI-output. Lagres derfor *ikke* som separate polygoner.

På `dk5x`-laget (det 2-cifrede, fx `dk52`) tilfoejes desuden nabo-postnumrenes 2-cifrede prefixer, så laget daekker ens eget postnummer *og* dem der støder op til det. Naboerne udledes ved klik direkte fra postnummer-polygonerne: et postnummer regnes som nabo hvis dets graense ligger inden for `NEIGHBOR_DIST_M` (2 km) af det klikkede. Et klik på 5220 giver derfor fx `dk5, dk50, dk52, dk53, dk55, dk57, dk58, dk522, dk5220` (her er `dk50` med fordi 5000 reelt graenser op - det tilfoejes ikke automatisk).

- `script.js` renderer kortet (Leaflet + CARTO dark tiles) på `index.html`.
- `edit.js` driver region-editoren på `edit.html` (Leaflet-Geoman).

## Tilføj en ny region

1. Tilføj region-metadata + geometri i `regions.json` (nøgle, navn, geometry).
2. Tilføj en farve til `REGION_COLORS` i `script.js` (hvis du vil ændre standard).
3. Åbn `edit.html`, tegn polygonen, vælg den nye nøgle, og indsæt det eksporterede GeoJSON i `regions.json`.

## Genbyg postnumre

Postnumre-data hentes direkte fra DAWA (api.dataforsyningen.dk), forenkles med Douglas-Peucker og skrives i samme nøgle/værdi-struktur som `regions.json`. Hver landsdel bliver sin egen fil i `postnumre/`, og scriptet skriver desuden manifestet `postnumre/index.json`:

```sh
python3 tools/fetch_postnumre_dawa.py postnumre
```

Scriptet itererer over landsdelene defineret i `LANDSDELE` i toppen af [tools/fetch_postnumre_dawa.py](tools/fetch_postnumre_dawa.py) - Fyn og Sjælland pr. default (Lolland-Falster og Bornholm er udeladt, da de har egne regioner). Tilføj en ny `(navn, kommuneliste)`-post i `LANDSDELE` for at udvide til Jylland osv.

Default-simplifikation: ~11 m tolerance + 4 decimalers koordinat-praecision. Juster med `--epsilon` og `--precision`.
