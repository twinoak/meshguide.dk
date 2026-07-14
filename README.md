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
GET /api/scopes?lat=<bredde>&lon=<længde>
```

Den pæne URL uden `.php` leveres af en Apache-`RewriteRule` (`^/api/scopes$ → /api/scopes.php`) i produktion; lokalt gør [router.php](router.php) det samme for PHP's indbyggede server. Selve filen [api/scopes.php](api/scopes.php) er stadig direkte tilgængelig.

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

### Alle scopes

```
GET /api/scopes?all
```

I stedet for scopes for et enkelt punkt returnerer `?all` hele scope-universet: hver region-nøgle plus hvert postnummer udfoldet til sine prefix-lag (`dk5230` → `dk5`, `dk52`, `dk523`, `dk5230`), fladtet til én deduplikeret, sorteret liste. Fordi postnummer 5000 findes, dukker det 2-cifrede prefix `dk50` op af sig selv. Nabo-udledningen indgår *ikke* - den er punkt-specifik.

```json
{ "scopes": ["dk-fyn", "dk-fyn-odense", "dk5", "dk50", "dk500", "dk5000", "…"], "count": 1080 }
```

### Chats

[api/chats.php](api/chats.php) eksponerer chat-registret som API, så en node kan slå en enkelt chat op uden at hente og parse hele datasættet. Chats kommer fra to kilder:

- de håndkuraterede by-chats i [cities.json](cities.json) (`#horsens`, `#dk-fyn`, …).
- én afledt chat pr. postnummer-scope. Hvert postnummer udfoldes til sine prefix-lag efter samme lag-konvention som scopes (`dk5230` → `dk5`, `dk52`, `dk523`, `dk5230`), så både de enkelte postnumre *og* aggregat-rummene (fx `#dk50`, der dækker hele 50xx) kommer med, deduplikeret. Hver chat har scope = nøglen, handle `#<nøgle>` og en centroid-`Point` som placering (bbox-centrum af postnummeret; for et aggregat-lag centrummet af alle dets postnumre). Ved kollision med en kurateret by-chat (fx `dk3`) vinder by-chatten.

```
GET /api/chats?all            # alle chats som en liste (by-chats + postnumre)
GET /api/chats?chat=<navn>    # én chat
```

`<navn>` matcher chattens nøgle (`odense`), dens handle (`#dk-fyn-odense`, med eller uden `#`) eller dens navn (`Odense`) - ufølsom over for store/små bogstaver. Postnummer-chats slås op på deres scope (`dk5000`, `#dk5000` eller bare `5000`) - det gælder også aggregat-lagene, så `dk50` og `dk5` virker. Den korte form `/api/chats?odense` virker også.

```json
{ "chat": { "key": "odense", "name": "Odense", "scope": "dk-fyn-odense", "localChat": "#dk-fyn-odense", "geometry": { "type": "Point", "coordinates": [10.381, 55.4047] } } }
```

`?all` svarer i stedet med `{ "chats": [ … ] }`, hvor hvert element bærer sin egen `key`. En ukendt chat giver HTTP 404, og en forespørgsel uden parametre giver HTTP 400.

Begge endpoints kræver ligesom `scopes` en Apache-`RewriteRule` i produktion (`^/api/chats$ → /api/chats.php`); lokalt kortlægger [router.php](router.php) automatisk enhver `/api/<navn>` til `api/<navn>.php`.

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
