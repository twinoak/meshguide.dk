## Vil du rette regionerne på kortet?

Regionspolygonerne tegnes i [Inkscape](https://inkscape.org/) i `denmark-bg.svg`. Ret SVG-filen og send en pull request, email meshcore@drkt.eu eller ping Dorkington på mesh'et.

## Kortets opbygning

`denmark-bg.svg` er sandheden for kortet. Den indeholder tre Inkscape-lag:

- **BackgroundMap**: Danmarks kystlinje, søer og byer.
- **RegionScopes**: selve regionspolygonerne. Hver `<path>` har et `inkscape:label` (fx `Oestjylland`) som mappes til en `data-region`-kode (fx `dk-oj`) i build-scriptet.
- **Text**: ignoreres, legacy information der skal ryddes op. Labels på kortet ligger som `<text>` direkte i `index.html`, så de er nemme at rette i hånden.

## Sådan opdaterer du kortet på siden

Når du har rettet `denmark-bg.svg` i Inkscape:

```sh
python3 build-map.py
```

Det gør to ting:

1. Skriver `basemap.svg` (en standalone SVG med kun BackgroundMap-laget, renset for Inkscape-metadata). Den refereres af `<image>`-tagget i `index.html`.
2. Genererer region-paths mellem `<!-- regions:start -->` og `<!-- regions:end -->` i `index.html`, med korrekt `data-region`-attribut på hver path.

Commit både `denmark-bg.svg`, `basemap.svg` og `index.html` bagefter.

## Tilføj en ny region

1. Tegn polygonen i Inkscape som et nyt `<path>` i `RegionScopes`-laget. Giv den et entydigt `inkscape:label` (Object Properties → Label).
2. Åbn `build-map.py` og tilføj en linje til `LABEL_TO_REGION` der mapper labelen til en `dk-*`-kode.
3. Tilføj regionens metadata til `regions.js` så klikinteraktionen virker.
4. Kør `python3 build-map.py`.

Scriptet advarer hvis en label i `LABEL_TO_REGION` ikke findes i SVG'en, eller hvis en path i `RegionScopes` mangler mapping så stavefejl og omdøbninger fanges med det samme.
