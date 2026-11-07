# Project notes for Claude

Walking distance to waste-sorting containers in Dřínov (okres Mělník). Two apps share one algorithm:
a desktop Python version (FastAPI + Leaflet, works offline) and a static web version (GitHub/GitLab
Pages) used to share "states" with council members.

## Language rule
- **Code in English**: identifiers, comments, file/module names, internal API routes and JSON keys,
  config keys, CSS classes and ids, test names.
- **Everything users see stays Czech**: UI text, error messages, READMEs, HANDOFF.md, downloaded file
  names, the page URL `upravy.html`, the link hash `#stav=…&vrstva=…` / `#nahled`, launcher scripts
  `spustit.*`, CLI flags (`--bez-prohlizece`), container GeoJSON properties (`id`, `typ`, `poznamka`),
  QGIS export layer/column names (`kontejnery`, `sit_vzdalenosti`, `d_<typ>`, `pasmo_<typ>`, `delka_m`…).
- Summary layer key value stays `"vse"` (`summary_key`); it appears in URLs and QGIS columns.

## Map
```
app.py                       launcher (CLI flags are Czech)
config.json                  English keys: types[{key,name,color,abbr}], bands_m, band_colors, tiles{…}, …
container_access/            Python package
  config.py  network.py  compute.py  overpass.py  basemap.py  tiles.py
  areas.py   storage.py  exports.py  connectivity.py  migration.py  server.py
static/                      desktop UI: index.html, app.js, style.css, render.js*, export-template.html*
tests/                       pytest; helpers.py, sample_area.py, osm_xml.py, generate_web_parity.py
web/
  index.html + js/viewer.js  viewer for council members (read-only)
  upravy.html + js/editor.js editor; js/backend.js = in-browser copy of the /api/… server
  js/state.js                shared-state format, links, comparison
  js/{compute,network,osm,geo,exports,storage,config,render}.js
  tools/presets-index.mjs    builds presets/index.json (run in CI)
  presets/                   published states (*.json); index.json is generated (gitignored)
  tests/                     node:test; data/{village_test.osm,parity.json}
```
`*` = copies of `web/js/render.js` and `web/export-template.html`. `static/app.js` was generated from
`web/js/editor.js` plus Python-only parts (fetch API with `X-Area` header, connectivity badge, stored
tiles, server-side exports). Keep these pairs in sync by hand.

## API (same routes in server.py and web/js/backend.js)
`GET /api/config`, `GET /api/status`, `GET /api/areas`, `POST /api/areas/{open,estimate,prepare,update}`,
`GET /api/task`, `GET /api/basemap`, `GET /api/network/segments`, `GET|PUT /api/containers`,
`POST /api/containers/import`, `GET|POST /api/variants`, `POST /api/variants/load`, `POST /api/compute`.
Python only: `POST /api/connectivity[/check]`, `POST /api/areas/osm?name=`, `GET /tiles/{z}/{x}/{y}.png`,
`POST /api/export/{gpkg,html,png}` (warnings in `X-Warnings`).

Basemap feature codes (Python basemap.py = web osm.js = render.js): `k` ∈ green, forest, water, stream,
building, road, railway, label, place; road `t` ∈ major, street, service, track, path; `n` name; `a` angle.

## Commands
- Python tests: `python -m pytest` (needs requirements-dev.txt; a throwaway venv works:
  `python -m venv /tmp/dk-venv && /tmp/dk-venv/bin/pip install -r requirements-dev.txt`).
- Web tests: `cd web && node --test tests/*.test.js`.
- Presets list: `cd web && node tools/presets-index.mjs`.
- Parity data: `python tests/generate_web_parity.py` (output must stay identical unless the algorithm changes).
- Local web: `cd web && python -m http.server 8000`.
- Browser smoke tests: Chrome is at `/usr/bin/google-chrome-stable`; driving it over the DevTools
  protocol from a small Node script (Node has a global WebSocket) worked well. Keep such scripts in /tmp.

## Pitfalls
- The shell is zsh: an unmatched glob (e.g. `--include=*.py` without quotes) aborts the whole command line.
- `test_offline.py` / `test_static_files` require that `static/index.html` contains no `https://`.
- Do not pre-download or store tiles from tile.openstreetmap.org (OSM terms). Never put the user's
  e-mail into the User-Agent.
- Web IndexedDB name is `dostupnost-kontejneru-v2` (record keys changed with the English rename).
