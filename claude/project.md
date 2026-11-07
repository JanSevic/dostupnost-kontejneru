# Project notes for Claude

Walking distance to waste-sorting containers in Dřínov (okres Mělník). A static web app in `web/`
(GitHub/GitLab Pages); everything is computed in the browser. The former desktop Python version was
removed on 2026-11-07 at the user's request (it is in git history) – do not reintroduce it.

## Language rule
- **Code in English**: identifiers, comments, file/module names, internal API routes and JSON keys,
  config keys, CSS classes and ids, test names, **git commit messages**.
- **Everything users see stays Czech**: UI text, error messages, READMEs, downloaded file
  names, the page URL `upravy.html`, the link hash `#stav=…&vrstva=…` / `#nahled`, container GeoJSON
  properties (`id`, `typ`, `poznamka`) and its foreign member `sber` (`od_domu`, `spolu_s`),
  QGIS export columns (`kontejnery`, `sit_vzdalenosti`, `d_<typ>`, `pasmo_<typ>`, `delka_m`…).
- Summary layer key value stays `"vse"` (`summary_key`); it appears in URLs and QGIS columns.

## Approved rules (agreed with the user)
- Cycleways count as walkable unless `foot=no`.
- The container's connection to the nearest path counts towards the distance.
- "Všechny typy" = maximum over types; door-to-door types are left out of it.
- Door-to-door type (`sber.<typ>.od_domu`): its containers are only backup points; its layer shows the
  distance to them ("… – záložní místa").
- Multi-commodity (`sber.<typ>.spolu_s`): the type is also served by containers of the listed types.
- Excluded network parts are hidden and left out of statistics, comparison and exports, but routing
  still goes through them (distances elsewhere do not change).
- Continuous colour scale is anchored to the bands (render.js and exports.js, kept equal by a test) and
  must not misrepresent them: each band keeps its hue, only the shade changes. Stops: band green at 0,
  light green at 0.85×first, yellow at first, band orange at first+25 % of the gap, deep orange at
  last−15 % of the gap, band red at last, dark red at 2×last. No separate max setting.
  (User feedback: an earlier version blending orange→red across the whole orange band looked "too red".)
- Published states live in `web/presets/*.json`; CI builds `presets/index.json`. Deploy from `main`.

## Not started (ideas from the original brief)
- Buildings (e.g. counting households per band), manual editing of the network (adding paths).

## Map (`web/`)
```
index.html + js/viewer.js     viewer for council members (read-only)
upravy.html + js/editor.js    editor; js/backend.js = in-browser "server" (call("GET", "/api/…"), IndexedDB)
js/state.js                   shared-state format, links, comparison
js/collection.js              door-to-door and multi-commodity collection ("sber")
js/exclusions.js              network parts excluded from evaluation (polygons, edge keys)
js/{compute,network,osm,geo,exports,storage,config,render}.js
export-template.html          template of the exported standalone HTML
tools/presets-index.mjs       builds presets/index.json (run in CI)
presets/                      published states (*.json); index.json is generated (gitignored)
tests/                        node:test; data/{village_test.osm,parity.json} (parity = frozen reference results)
```

## Backend API (web/js/backend.js)
`GET /api/config`, `GET /api/status`, `GET /api/areas`, `POST /api/areas/{open,estimate,prepare,update}`,
`GET /api/task`, `GET /api/basemap`, `GET /api/network/segments`, `GET|PUT /api/containers`,
`POST /api/containers/import`, `GET|POST /api/variants`, `POST /api/variants/load`, `POST /api/compute`,
`GET|PUT /api/exclusions`, `POST /api/exclusions/toggle-segment`. Plus exports `exportData(kind, body)`,
`areaFromOsm`, `stateForSaving`, `takeOverState`, `savePreview`.

Basemap feature codes (osm.js = render.js): `k` ∈ green, forest, water, stream, building, road, railway,
label, place; road `t` ∈ major, street, service, track, path; `n` name; `a` angle.

## Commands
- Tests: `cd web && node --test tests/*.test.js`.
- Presets list: `cd web && node tools/presets-index.mjs`.
- Local server: `cd web && python -m http.server 8000` (any static server).
- Browser smoke tests: Chrome is at `/usr/bin/google-chrome-stable`; driving it over the DevTools
  protocol from a small Node script (Node has a global WebSocket) worked well. To reach the Leaflet map
  object, inject `L.Map.addInitHook(function () { window.__map = this; })` via
  `Page.addScriptToEvaluateOnNewDocument` (setter trap on `window.L`). Keep such scripts in /tmp.

## Pitfalls
- The shell is zsh: an unmatched glob (e.g. `--include=*.py` without quotes) aborts the whole command line.
- `pkill -f <pattern>` kills the calling shell too when the pattern is in its command line – kill by PID.
- GitHub repo: deployment runs on `main` (the default branch); the `github-pages` environment only
  allows the default branch.
- Do not pre-download or store tiles from tile.openstreetmap.org (OSM terms). Never put the user's
  e-mail into the User-Agent.
