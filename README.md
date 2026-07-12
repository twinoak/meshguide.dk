## Vil du rette regionerne på kortet?

Åbn `edit.html` i en browser. Det er en in-page region-editor:

- Tegn nye polygoner med polygon-værktøjet i venstre side (klik punkter, dobbeltklik for at afslutte).
- Når et polygon er færdigt, vælg hvilken `dk-xx`-region det hører til.
- Klik et eksisterende polygon for at ændre dets region-nøgle, eller brug edit-/slet-værktøjet til at justere geometri.
- Brug **Kopier GeoJSON** eller **Download .geojson** og send resultatet til vedligeholderen via Discord eller mesh'et.

## Kortets opbygning

Data ligger i JSON-filer:

- `regions.json` - håndkuraterede regioner (`dk-fyn`, `dk-jylland`, …). Læses af API'et og af [edit.html](edit.html).
- `cities.json` - bymarkører + deres popup-info. Den eneste datafil klienten selv henter ([index.html](index.html)).
- `postnumre/` - postnummer-polygoner (`dk5000`, `dk5230`, …) delt op pr. landsdel: `postnumre/fyn.json`, `postnumre/sjaelland.json`, … plus `postnumre/index.json`, et manifest der kobler hver fil til dens bounding box.

Scopes beregnes server-side af [api/scopes.php](api/scopes.php) (se **API** nedenfor). Klienten henter derfor ikke `regions.json` eller postnummer-polygonerne - ved klik kalder den API'et, som svarer med både scopes og geometrien for de ramte polygoner, så highlightet kan tegnes uden at downloade polygon-data.

Hierarkiske scopes udledes af nøglen efter lag-konventionen `dk5` → `dk5x` → `dk5xx` → `dk5230`: et klik der rammer `dk5230` udvides til `dk5`, `dk52`, `dk523`, `dk5230`. Lagres derfor *ikke* som separate polygoner.

På `dk5x`-laget (det 2-cifrede, fx `dk52`) tilføjes desuden nabo-postnumrenes 2-cifrede prefixer, så laget dækker ens eget postnummer *og* dem der støder op til det. Et postnummer regnes som nabo hvis dets grænse ligger inden for `NEIGHBOR_DIST_M` (2 km) af det klikkede. Et klik på 5220 giver derfor fx `dk5, dk50, dk52, dk53, dk55, dk57, dk58, dk522, dk5220` (her er `dk50` med fordi 5000 reelt grænser op).

- `script.js` renderer kortet (Leaflet + CARTO dark tiles) på `index.html` og kalder API'et ved klik.
- `edit.js` driver region-editoren på `edit.html` (Leaflet-Geoman).

## API

[api/scopes.php](api/scopes.php) er den autoritative scope-motor. Den tager et punkt og returnerer alle scopes for det punkt:

```
GET /api/scopes.php?lat=<bredde>&lon=<længde>[&pretty=1]
```

```json
{
  "lat": 55.3959, "lon": 10.3883,
  "hits": ["dk-fyn", "dk-fyn-odense", "dk5000"],
  "scopes": ["dk-fyn", "dk-fyn-odense", "dk5", "dk50", "dk52", "dk53", "dk54", "dk500", "dk5000"],
  "cli": { "firmware_1_16_0_plus": "…", "firmware_1_12_0_to_1_15_0": "…" },
  "features": { "type": "FeatureCollection", "features": [] }
}
```

- `hits` - de ramte polygoner (regioner + postnumre).
- `scopes` - det udfoldede, ordnede scope-hierarki.
- `cli` - de færdige CLI-blokke til repeateren (to firmware-varianter); `null` når intet er ramt.
- `features` - geometrien for de ramte polygoner, så klienten kan tegne highlightet.

Et punkt uden for alle polygoner giver tomme `hits`/`scopes`, `cli: null` og HTTP 200. Ugyldige koordinater giver HTTP 400.

API'et indlæser `regions.json` + alle postnummer-filer og cacher de dekodede strukturer (med forudberegnede bounding boxes) i APCu, nøglet på filernes mtime - et `git pull` invaliderer derfor cachen automatisk. Naboer udledes fra hele datasættet ved hver forespørgsel, så resultatet er deterministisk, også på tværs af landsdele.

## Genbyg postnumre

Postnumre-data hentes direkte fra DAWA (api.dataforsyningen.dk), forenkles med Douglas-Peucker og skrives i samme nøgle/værdi-struktur som `regions.json`. Hver landsdel bliver sin egen fil i `postnumre/`, og scriptet skriver desuden manifestet `postnumre/index.json`:

```sh
python3 tools/fetch_postnumre_dawa.py postnumre
```

Scriptet itererer over landsdelene defineret i `LANDSDELE` i toppen af [tools/fetch_postnumre_dawa.py](tools/fetch_postnumre_dawa.py) - Fyn og Sjælland pr. default. Tilføj en ny `(navn, kommuneliste)`-post i `LANDSDELE` for at udvide til Jylland osv.

Default-simplifikation: ~11 m tolerance + 4 decimalers koordinat-præcision. Juster med `--epsilon` og `--precision`.

## Lokal udvikling

Kør hele siden lokalt i en container - PHP + APCu, samme opførsel som serveren, uden at installere andet end `podman` på værten:

```sh
./run.sh        # bygger imaget (near-instant når cachet) og serverer på :8000
```

Åbn http://localhost:8000. Repoet er bind-mountet, så ændringer i `script.js`, `api/scopes.php` eller JSON-filerne slår igennem ved at genindlæse browseren. `run.sh` genbygger imaget hver gang, men det er near-instant med mindre [Dockerfile](Dockerfile) har ændret sig.
