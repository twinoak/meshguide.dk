## Vil du rette regionerne på kortet?

Åbn `edit.html` i en browser. Det er en in-page region-editor:

- Tegn nye polygoner med polygon-værktøjet i venstre side (klik punkter, dobbeltklik for at afslutte).
- Når et polygon er færdigt, vælg hvilken `dk-xx`-region det hører til.
- Klik et eksisterende polygon for at ændre dets region-nøgle, eller brug edit-/slet-værktøjet til at justere geometri.
- Brug **Kopier GeoJSON** eller **Download .geojson** og send resultatet til vedligeholderen via Discord eller mesh'et.

## Kortets opbygning

Hele siden er statisk - der er ingen backend. Data ligger i JSON-filer, og al scope-logik kører i browseren:

- `regions.json` - håndkuraterede regioner (`dk-fyn`, `dk-jylland`, …).
- `cities.json` - bymarkører + deres popup-info.
- `postnumre/` - postnummer-polygoner (`dk5000`, `dk5230`, …) delt op pr. landsdel: `postnumre/fyn.json`, `postnumre/sjaelland.json`, … plus `postnumre/index.json`, et manifest der kobler hver fil til dens bounding box.

Hierarkiske scopes udledes af nøglen efter lag-konventionen `dk5` → `dk5x` → `dk5xx` → `dk5230`: et klik der rammer `dk5230` udvides til `dk5`, `dk52`, `dk523`, `dk5230`. Lagres derfor *ikke* som separate polygoner.

På `dk5x`-laget (det 2-cifrede, fx `dk52`) tilføjes desuden nabo-postnumrenes 2-cifrede prefixer, så laget dækker ens eget postnummer *og* dem der støder op til det. Et postnummer regnes som nabo hvis dets grænse ligger inden for `NEIGHBOR_DIST_M` (2 km) af det klikkede. Et klik på 5220 giver derfor fx `dk5, dk50, dk52, dk53, dk55, dk57, dk58, dk522, dk5220` (her er `dk50` med fordi 5000 reelt grænser op). Naboer udledes fra hele datasættet, så resultatet er deterministisk, også på tværs af landsdele (fx er `dk42` nabo til `dk5800` hen over Storebælt).

- `scopes.js` er scope-motoren og den eneste kilde til reglerne: hit-test, nabo-udledning, scope-hierarki og `region def`-linjer (≤ 160 bytes pr. linje). Rene funktioner uden DOM eller netværk - samme modul bruges af browseren og af build-scriptet. Ændres en regel (`NEIGHBOR_DIST_M`, lag-konventionen, `regionDefLines`), ændres den *her*.
- `script.js` renderer kortet (Leaflet + MapLibre GL med OpenFreeMap dark vector-tiles) på `index.html`. Ved indlæsning hentes `regions.json` og alle postnummer-filer (ca. 200 KB komprimeret), og ved klik kaldes `scopesForPoint()` fra `scopes.js`.
- `edit.js` driver region-editoren på `edit.html` (Leaflet-Geoman).
- `tools/chats.js` udleder chat-registret (se **API** nedenfor). Bruges kun af build-scriptet.

## API

API'et er statiske JSON-filer, der genereres af `npm run build` fra de samme datafiler og den samme `scopes.js` som kortet bruger. De ligger under `/api/` på det udgivne site, ikke i repoet.

### Alle scopes

```
GET /api/scopes.json
```

Hele scope-universet: de faste top-scopes (`eu`, `europe`, `dk`) plus hver region-nøgle plus hvert postnummer udfoldet til sine prefix-lag (`dk5230` → `dk5`, `dk52`, `dk523`, `dk5230`), fladtet til én deduplikeret, sorteret liste. Fordi postnummer 5000 findes, dukker det 2-cifrede prefix `dk50` op af sig selv. Nabo-udledningen indgår *ikke* - den er punkt-specifik.

```json
{ "scopes": ["dk", "dk-3kant", "dk-aalborg", "dk-aarhus", "…", "dk5", "dk50", "dk500", "dk5000", "…"], "count": 425 }
```

Scopes for et *enkelt punkt* (det tidligere `/api/scopes?lat=&lon=`) findes ikke som statisk fil - det er en funktion af et vilkårligt punkt. Brug `scopesForPoint()` i `scopes.js` direkte; modulet har ingen afhængigheder og kan importeres i både browser og Node.

### Chats

Chat-registret kommer fra to kilder:

- de håndkuraterede by-chats i [cities.json](cities.json) (`#horsens`, `#dk-fyn`, …).
- én afledt chat pr. postnummer-scope. Hvert postnummer udfoldes til sine prefix-lag efter samme lag-konvention som scopes (`dk5230` → `dk5`, `dk52`, `dk523`, `dk5230`), så både de enkelte postnumre *og* aggregat-rummene (fx `#dk50`, der dækker hele 50xx) kommer med, deduplikeret. Hver chat har scope = nøglen, handle `#<nøgle>` og en centroid-`Point` som placering (bbox-centrum af postnummeret; for et aggregat-lag centrummet af alle dets postnumre). Ved kollision med en kurateret by-chat vinder by-chatten.

```
GET /api/chats.json             # alle chats som en liste (by-chats + postnumre)
GET /api/chats/<navn>.json      # én chat
```

`<navn>` er chattens nøgle (`odense`), dens handle uden `#` (`dk-fyn-odense`) eller dens navn (`Odense`) - med små bogstaver (`odense`). Postnummer-chats slås op på deres scope (`dk5000`) eller bare cifrene (`5000`) - det gælder også aggregat-lagene, så `dk50` og `50` virker. En ukendt chat giver HTTP 404.

```json
{ "chat": { "key": "odense", "name": "Odense", "scope": "dk-fyn-odense", "localChat": "#dk-fyn-odense", "geometry": { "type": "Point", "coordinates": [10.381, 55.4047] } } }
```

`chats.json` svarer i stedet med `{ "chats": [ … ] }`, hvor hvert element bærer sin egen `key`.

## Automagisk opsætning (eksperimentel)

[automagical/](automagical/) er et underprojekt: en side der sætter en repeater eller room server op via USB direkte fra browseren, i stedet for at brugeren selv skriver kommandoer. Har enheden region scopes ud over de anbefalede, vises de som en fravalgt række ("Ekstra region scopes"); sættes der flueben, køres `region def` først (så ønskede regioner flyttes på plads), derefter `region remove` på de overskydende - underregioner før forældre, ved at gentage dem der svarer `Err - not empty` - og til sidst `region save`. CLI'en har ingen "ryd alle"-kommando. Room servers deler CLI'en med repeatere; forskellen er at `guest.password` dér er rummets adgangskode (røres aldrig), og at reglerne for videresendelse (`loop.detect`, `flood.max.unscoped`) kun gælder hvis `repeat` er slået til. Den bruger Web Serial og virker derfor kun i Chrome/Edge på en computer, og kun over HTTPS eller `localhost`.

Forløbet: tilslut porten → læs enhedens indstillinger via CLI'en (`ver`, `board`, `get …`, `gps advert`, `region …`) → find positionen (fra enheden, ellers ved klik på kortet) → udled scopes med `scopes.js` → sammenlign med anbefalingerne fra forsiden → vis en liste over ændringer med et **Anvend valgte**-knap, der sender kommandoerne og læser enheden igen.

- `automagical/serial.js` taler repeaterens serielle CLI: kommandoer afsluttes med `\r`, enheden ekkoer hvert tegn, og svar kommer som én linje med præfikset `  -> ` (kan indeholde linjeskift, fx region-træet). Et svar regnes for færdigt efter 200 ms stilhed. `identify()` finder først ud af hvilken firmware der sidder i den anden ende: svarer `ver` med tekst, er det repeater/room server/sensor (CLI); ellers sendes companion-appens to hilsner (`CMD_DEVICE_QUERY`, `CMD_APP_START`) som binære `<`-frames, og svarer enheden med `>`-frames, er det companion-firmware - så vises firmware, board, navn og position. For en companion tjekkes de to indstillinger der betyder noget for det danske mesh - `path.hash.mode` (fra `DEVICE_INFO`-framen) og standard-scope (`CMD_GET_DEFAULT_FLOOD_SCOPE`, skal være `dk`) - og de kan rettes med `CMD_SET_PATH_HASH_MODE` og `CMD_SET_DEFAULT_FLOOD_SCOPE`. Scope-nøglen er de første 16 bytes af SHA-256 over `#dk`, som firmwaren selv udleder den (`TransportKeyStore::getAutoKeyFor`). Svarer ingen af delene, siges det med det samme i stedet for at vente på 20 timeouts.
- `automagical/ble.js` taler med en BLE-companion over Web Bluetooth, ligesom appen: Nordic UART Service (`6E400001-…`), én GATT-skrivning = én frame, én notification = én frame (ingen `<`/`>`-header som over USB), og enhedens PIN indtastes i systemets parringsdialog. Companion-protokollen (`CompanionLink` i `serial.js`) er fælles for USB og Bluetooth. Repeatere og room servers har ingen BLE-grænseflade, og en companion med BLE- eller WiFi-firmware har omvendt ingen USB-kommunikation (`ENABLE_USB_INTERFACE` sættes kun i `companion_radio_usb`-builds). Brave har Web Bluetooth slået fra som standard: `navigator.bluetooth` findes, men `requestDevice()` afvises med `NotFoundError: Web Bluetooth API globally disabled.` - samme fejlnavn som når brugeren lukker enhedsvælgeren, så siden skelner på Chromiums præcise fejltekster og viser en henvisning til `brave://flags/#brave-web-bluetooth-api` i stedet for at tie. Adressen kan ikke være et link - browsere blokerer navigation fra en webside til deres egne `brave://`/`chrome://`-sider - så den vises med en **Kopiér**-knap (`navigator.clipboard`).
- `automagical/checks.js` er reglerne (rene funktioner): parser svarene til en typet tilstand og laver listen af anbefalinger med de præcise kommandoer. `flood.advert.interval` vælges deterministisk ud fra enhedens public key i intervallet 60–85. Radioindstillinger vises læsbart (`869.618 MHz · BW 62.5 kHz · SF 8 · CR 4/8`, `formatRadio`), mens kommandoen stadig er CLI-formen `set radio 869.618,62.5,8,8`. Testes uden enhed i `tools/checks.test.js`.
- `automagical/flow.js` er den fælles del af UI'et - læs indstillinger, kort/placering, anbefalinger, anvend - uafhængigt af hvordan repeateren nås. Den får et "link" med `command(cmd)` og bruges af begge sider.
- `automagical/automagical.js` er `index.html`: tilslut via USB/Bluetooth, genkend firmware, og giv linket videre til `flow.js`.

### Fjernopsætning gennem en companion

[automagical/remote.html](automagical/remote.html) sætter en repeater eller room server op *gennem mesh'et*: computeren taler med en companion (USB eller Bluetooth), og companionens radio taler med repeateren - det samme som "remote management" i MeshCore-appen. Forløbet: tilslut companionen → hent dens kontaktliste (`CMD_GET_CONTACTS`; kun repeatere og room servers vises, nyeste advert først) → vælg repeater → log ind med admin-adgangskoden (`CMD_SEND_LOGIN` → push `LOGIN_SUCCESS`/`LOGIN_FAIL`) → samme flow som på `index.html`.

- `automagical/remote-cli.js` (`RemoteCli`) har samme `command()`-interface som USB-linket, men sender hver CLI-linje som en tekstbesked (`CMD_SEND_TXT_MSG`) til repeateren, som kører den gennem sin `handleCommand()` - kun for admin-logins - og svarer med en CLI_DATA-besked, som companionen melder med `PUSH_CODE_MSG_WAITING` og udleverer på `CMD_SYNC_NEXT_MESSAGE`. Størrelserne passer med den serielle CLI: en kommando skal være i én pakke (160 tegn), et svar i én pakke (~160 tegn) - samme loft som `region list` har i forvejen.
- Det svære er at parre svar med kommandoer: et svar bærer intet spor af hvilken kommando det besvarer, companionens kø er først-ind-først-ud, og alt der ligger tilbage i den (et sent svar, en gentaget kommando, en chatbesked) forskyder alle senere svar med én. Reglerne er derfor: (1) kommandoer sendes som `TXT_TYPE_PLAIN` med *vores* tidsstempel - repeateren behandler en gensendelse med samme tidsstempel som en retry, der kvitteres men ikke køres igen, så en retry kan aldrig give et ekstra svar (med `TXT_TYPE_CLI_DATA` stempler companionen selv hver afsendelse med sit ur, og hver retry køres og besvares igen); tidsstemplet må ikke gå baglæns for companionen, så det bygger på det seneste af computerens og companionens ur (`CMD_GET_DEVICE_TIME`). (2) PLAIN-beskeder kvitteres (`PUSH_CODE_SEND_CONFIRMED`), så vi ved om kommandoen nåede frem: ingen kvittering og intet svar → gensend (samme tidsstempel, op til 3 gange); kvittering men intet svar → den er kørt og svaret er sent eller tabt, en gensendelse hjælper ikke, så der ventes ét vindue mere og opgives. (3) Før hver afsendelse tømmes companionens kø: gamle svar fra repeateren smides væk og tælles (vises i en note), andre beskeder logges - de kan ikke lægges tilbage. (4) Alt er begrænset: fast ventetid pr. vindue (companionens eget estimat + 3 s, mindst 5 s, højst 20 s), derefter opgives kommandoen, og resten af aflæsningen/anvendelsen fortsætter; ubesvarede vises som "Kunne ikke aflæses".
- **Find repeatere i nærheden** er appens "repeaters nearby": companionen sender `CMD_SEND_CONTROL_DATA` med en `NODE_DISCOVER_REQ` (`0x80`, filter = repeatere, tilfældigt tag) som en *zero-hop* kontrolpakke - mesh'et videresender den aldrig - og hver repeater i direkte rækkevidde med `repeat` slået til (og firmware der kender pakken; max 4 svar pr. 2 min) svarer zero-hop med `NODE_DISCOVER_RESP`: tag, sin public key og den SNR den hørte kaldet med. Companionen skubber svarene som `PUSH_CODE_CONTROL_DATA`. Discovery kører af sig selv når companionen er forbundet (efter kontaktlisten er hentet, så navnene kendes) og lytter i 20 s med en nedtælling og løbende antal svar. Vinduet er sat efter repeaterens svartid: den svarer efter en tilfældig forsinkelse på op til 20 × pakkens airtime × dens `txdelay` (`getRetransmitDelay() × 4`), dvs. ca. 4-5 s ved standard-`txdelay` 0.5, men op mod 18 s for en bakketop-repeater på `txdelay` 2.0. Bemærk også repeaterens egen begrænsning: højst 4 svar pr. 2 minutter - gentagne søgninger lige efter hinanden bliver ignoreret. Tabellen (`automagical/contacts-ui.js`, fælles for `remote.html` og v2) viser som udgangspunkt kun dem der svarede, sorteret efter signal: kendte kontakter med navn og "SNR x dB her · y dB hos den", ukendte nøgler som en række uden navn (svaret bærer hverken navn eller position), der tilføjes som kontakt med `CMD_ADD_UPDATE_CONTACT` når man logger ind på dem, for `CMD_SEND_LOGIN` kræver en kontakt. Hele kontaktlisten ligger bag **Vis alle kontakter (N)** - nødvendig for repeatere flere hop væk, som ikke svarer på et zero-hop-kald, og for repeatere med ældre firmware, der ignorerer det. En companion uden `CMD_SEND_CONTROL_DATA` (protokol < v8) svarer `ERR`, og siden siger det.
- Radioindstillinger (`set radio`) sendes aldrig via mesh: en forkert frekvens/båndbredde/SF afbryder forbindelsen til repeateren. `lockFindings()` i `checks.js` viser forskellen som *Vises kun* uden afkrydsningsfelt. I praksis passer radioen næsten altid, for companion og repeater kan kun tale sammen hvis de allerede deler frekvens, båndbredde og SF.
- WiFi-companions kan ikke bruges fra en browser: firmwaren (`SerialWifiInterface`) åbner en rå TCP-server på port 5000, og en webside kan ikke åbne TCP-forbindelser. Siden har derfor kun USB og Bluetooth; forklaringen står i "Før du starter".
- `automagical/remote.js` er UI'et for siden, `automagical/automagical.css` er de styles begge sider deler.

Siderne bygges og udgives sammen med resten af sitet (`/automagical/` og `/automagical/remote.html`), men linkes ikke fra forsiden endnu.

## v2 - den guidede udgave (eksperimentel)

[v2/](v2/) er et bud på en ny forside, hvor brugeren vælger hvad de vil, og guides derfra - i stedet for at få kort og kommandoer med det samme. Den ligger i sin egen mappe og rører ikke ved resten; design (farver, skrifter, mesh-baggrunden) er det samme som forsiden.

Én side, styret på URL-hashen, så en enhedsforbindelse overlever trinnene:

```
#/                        Hvad vil du?  → companion · repeater · anbefalinger
#/companion               USB eller Bluetooth?
#/companion/usb|ble       → direkte flow (som automagical/index.html)
#/repeater                Direkte via USB, eller over mesh'et via en companion?
#/repeater/usb            → direkte flow
#/repeater/remote         Companionen: USB eller Bluetooth?
#/repeater/remote/usb|ble → fjernflow (som automagical/remote.html)
#/defaults                Kortet + de anbefalede indstillinger (den gamle forside)
```

- `v2/app.js` er guiden: ruter, valgkort, brødkrummer, tjeklister og forbindelsen. Al enhedslogik importeres fra `automagical/` (`serial.js`, `ble.js`, `remote-cli.js`, `checks.js`) og det fælles læs → kort → anbefal → anvend-flow fra `automagical/flow.js` (samme element-id'er, én flow-instans der skifter regler med `setMode("direct" | "remote")`).
- Vælger brugeren forkert - "repeater", men der sidder en companion i kablet, eller omvendt - forklares det, og der tilbydes at fortsætte med den rigtige guide *med forbindelsen beholdt* (ingen ny port-vælger). En companion på repeater-ruten kan også sendes videre til fjernopsætningen med det samme.
- `#/defaults` er den gamle forside som den er - kortet med region scopes, radioindstillingerne og de diverse indstillinger med deres forklaringer og wiki-links (samme HTML som `index.html`, kun med egne element-id'er) - efterfulgt af vejen videre til de automatiske guider og de sociale links.
- `v2/v2.css` er de få nye styles (valgkort, brødkrummer, tjeklister) oven på `style.css` og `automagical/automagical.css`.

Åbn http://localhost:8000/v2/ efter `npm start`. Siden bygges med resten, men linkes ikke fra forsiden.

## Genbyg postnumre

Postnumre-data hentes direkte fra DAWA (api.dataforsyningen.dk), forenkles med Douglas-Peucker og skrives i samme nøgle/værdi-struktur som `regions.json`. Hver landsdel bliver sin egen fil i `postnumre/`, og scriptet skriver desuden manifestet `postnumre/index.json`:

```sh
python3 tools/fetch_postnumre_dawa.py postnumre
```

Scriptet itererer over landsdelene defineret i `LANDSDELE` i toppen af [tools/fetch_postnumre_dawa.py](tools/fetch_postnumre_dawa.py) - Fyn og Sjælland pr. default. Tilføj en ny `(navn, kommuneliste)`-post i `LANDSDELE` for at udvide til Jylland osv.

Default-simplifikation: ~11 m tolerance + 4 decimalers koordinat-præcision. Juster med `--epsilon` og `--precision`.

## Lokal udvikling

Siden er rene statiske filer, men skal serveres over HTTP (ES-modules og `fetch()` virker ikke fra `file://`). Repoet har sin egen lille dev-server uden afhængigheder ([tools/serve.js](tools/serve.js), kun Node):

```sh
npm start         # serverer repoet på http://localhost:8000 (PORT=3000 npm start for en anden port)
```

Åbn http://localhost:8000 (forsiden), http://localhost:8000/edit.html (editoren), http://localhost:8000/automagical/ (USB/Bluetooth-opsætning; `localhost` tæller som sikker kontekst, så Web Serial og Web Bluetooth virker) eller http://localhost:8000/automagical/remote.html (fjernopsætning gennem en companion). Alt sendes med `Cache-Control: no-cache`, så ændringer i `script.js`, `scopes.js` eller JSON-filerne slår igennem ved at genindlæse browseren. Der er intet at installere - Node (≥ 20) er det eneste krav:

```sh
npm test                    # regressionstest af scope-motoren, chat-registret og automagical-reglerne
npm run build               # bygger det færdige site i _site/, inkl. det statiske API
node tools/serve.js _site   # serverer build-output, hvis du vil se /api/ lokalt
```

## Deploy

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) kører `npm test` og `npm run build` ved push til `main` og udgiver `_site/` til GitHub Pages. Repoet skal have *Settings → Pages → Source: GitHub Actions*. For at bruge domænet `meshguide.dk` skal der ligge en fil `CNAME` med indholdet `meshguide.dk` i repoets rod (den kopieres med til `_site/`), og domænets DNS skal pege på GitHub Pages.

Skal siden hostes et andet sted, er `_site/` fra `npm run build` det der skal serveres.
