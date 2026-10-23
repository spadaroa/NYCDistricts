# NYC School District Builder

An interactive, browser-only tool for drawing your own New York City community school districts, in the spirit of Districtr and Dave's Redistricting App, using real NYC DOE enrollment and demographic data.

**Live demo:** _add your GitHub Pages / personal site link here_

## What it does

- Paint school buildings into districts (click or drag; wide brush; undo/redo; pan and zoom; touch support).
- Live scorecard against today's 32 districts: size balance, compactness (Polsby-Popper), racial/ethnic segregation (Theil's H), economic segregation (poverty dissimilarity), districts near the city poverty rate, students moved, contiguity.
- Per-district table (enrollment, deviation, race/ethnicity, poverty, ENI, ELL, SWD) and choropleth map modes.
- Auto-balance: a simulated-annealing optimizer that runs in the browser with adjustable weights (equal size, compactness, economic mix, racial/ethnic mix, keep today's lines), a size cap, and an optional "stay inside one borough" rule.
- School dots (by type, sized by enrollment), official DCP district lines overlay, and zone-level heatmaps for each subgroup (Asian, Black, Hispanic, White, Multiracial, Native American, ELL/ENL, SWD, poverty, ENI).
- Toggle which schools count: community superintendent, high school superintendent, District 75, charter.
- Six preloaded plans: Current districts, Equal size & compact, Economic balance, Racial/ethnic integration, Balanced blend, Fix sizes with minimal change.
- Save/share via a plan code (also loads from `#plan=<code>` in the URL), CSV export of school-by-school assignments, autosave in the browser.

## Repository layout

```
prep/build_data.py     Python: downloads → src/data.json (map units, adjacency, schools)
prep/make_presets.js   Node: runs the optimizer to produce src/presets.json
src/engine.js          Shared model, metrics and optimizer (browser + Node)
src/app.js, app.css, body.html   The web app
build.js               Inlines everything into one self-contained dist/index.html
docs/index.html        Copy of dist/index.html for GitHub Pages
```

## Rebuilding the data

1. **LCGMS roster** (schools, buildings, addresses, superintendents): download the Excel report from
   https://infohub.nyced.org/in-our-schools/operations/lcgms. It's an HTML table saved as .xls; convert it once:
   `python3 -c "import pandas as pd,io;pd.read_html(io.StringIO(open('LCGMS.xls',encoding='utf-16').read()))[0].to_csv('raw/lcgms/lcgms.csv',index=False)"`
2. **Other inputs** into `raw/`:
```bash
curl -L -o raw/demo.xlsx "https://infohub.nyced.org/docs/default-source/default-document-library/demographic-snapshot-2021-22-to-2025-26-public.xlsx"
curl -L -o raw/zones/cmjf-yawu.geojson "https://data.cityofnewyork.us/api/geospatial/cmjf-yawu?method=export&format=GeoJSON"
curl -L -o raw/zones/t26j-jbq7.geojson "https://data.cityofnewyork.us/api/geospatial/t26j-jbq7?method=export&format=GeoJSON"
mkdir -p raw/tracts && curl -L -o raw/tracts/63ge-mke6.geojson "https://data.cityofnewyork.us/api/geospatial/63ge-mke6?method=export&format=GeoJSON"
mkdir -p raw/blocks && curl -L -o raw/blocks/wmsu-5muw.geojson "https://data.cityofnewyork.us/api/geospatial/wmsu-5muw?method=export&format=GeoJSON"   # 2020 Census blocks (school areas)
curl -L -o raw/districts.geojson "https://data.cityofnewyork.us/api/geospatial/8ugf-3d8u?method=export&format=GeoJSON"
curl -L -o raw/loc1920.json "https://data.cityofnewyork.us/resource/wg9x-4ke6.json?\$limit=5000"
curl -G -L -o raw/facdb.json "https://data.cityofnewyork.us/resource/ji82-xba5.json" --data-urlencode "\$limit=5000" \
  --data-urlencode "\$where=facsubgrp in ('PUBLIC K-12 SCHOOLS','PUBLIC AND PRIVATE SPECIAL EDUCATION SCHOOLS','GED AND ALTERNATIVE HIGH SCHOOL EQUIVALENCY')"
curl -G -L -o raw/facdb_charter.json "https://data.cityofnewyork.us/resource/ji82-xba5.json" --data-urlencode "\$limit=5000" \
  --data-urlencode "\$where=facsubgrp='CHARTER K-12 SCHOOLS'"
```
3. **Build:**
```bash
pip install pandas openpyxl shapely lxml
python3 prep/geocode.py raw          # NYC GeoSearch, cached in raw/geocode_cache.json
python3 prep/build_data.py raw src            # writes src/data_{es,ms,tract,area}.json
for k in es ms tract area; do node prep/make_presets.js $k; done
node build.js && cp dist/index.html docs/index.html
```

To rebuild only one layer with exactly the same schools and locations (no LCGMS roster needed), point `FROM_JSON` at an existing area-layer file, e.g. `FROM_JSON=src/data_area.json python3 prep/build_data.py raw src area`.

## Publishing

- **GitHub Pages:** push this repo, then Settings → Pages → Deploy from branch → `main` / `docs`.
- **Personal site:** upload `dist/index.html` anywhere; it's a single static file (~5 MB) with no server or API calls.

## Method notes

- **Building blocks (choose in the Plan tab):** DOE elementary school zones; DOE middle school zones (elementary zones inside middle-school-choice districts); 2020 Census tracts; or school areas (whole 2020 Census blocks assigned to the nearest school building within each district, so edges follow streets). All are split at the official DCP district lines and cleaned of slivers; blocks count as neighbors only if they share ≥100 m of border.
- **Units are DOE elementary school zones** (default) (NYC Open Data, School Zones 2024–2025, Elementary). Zones that cross a community district line are split at the official DCP line, so today's districts match the official map exactly. Land outside every zone (parks, marsh) is merged into the neighboring zone in the same district. Water-separated pieces (Rockaways, islands) are linked to the nearest zone, first within their own district.
- **Schools are placed in the zone containing their building.** Every school in a zone moves with it.
- **Cross-district schools** (e.g., Beacon HS: District 3, located in District 2) don't change the map. Each one is counted in its administrative district while its zone is untouched. Once that zone is moved (by painting or auto-balance), the school follows the zone.
- **Locations:** LCGMS addresses geocoded with NYC GeoSearch. If a result falls outside the school's LCGMS geographic district, the DCP Facilities Database (by BBL) or 2019–20 School Locations is used instead.
- **School groups** (toggle which are counted): community superintendent, high school superintendent (has an HS Network in LCGMS), District 75, charter. District 79 programs are not in the public LCGMS report.
- **Size targets:** with the borough rule on, each district's target is its borough's counted enrollment divided by its number of districts. New plans apportion seats by enrollment (Hamilton method).
- **Suppressed values:** "Above 95%" poverty/ENI is counted as 97%.

## Data sources

- NYC DOE, LCGMS school report (InfoHub)
- NYC DOE, Demographic Snapshot 2021-22 to 2025-26 (InfoHub)
- NYC Open Data: School Zones 2024–2025 (Elementary School) (cmjf-yawu)
- NYC Planning GeoSearch geocoder
- NYC Open Data: 2019–20 School Locations (wg9x-4ke6), Facilities Database (ji82-xba5), School Districts (8ugf-3d8u)
