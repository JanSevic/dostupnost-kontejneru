# Progress log (newest first)

## 2026-11-07 (later)
- Added carton and cooking-oil types (config.json, config.py, web config.js).
- Web only: continuous colour scale toggle in the viewer; network exclusions (polygons + single edges,
  `js/exclusions.js`, `/api/exclusions…`); collection settings – door-to-door and multi-commodity
  (`js/collection.js`, foreign member `sber` of the container GeoJSON). State format gained
  `area.exclusions` and `display.mode`. Python version does not have these yet (its normaliser drops `sber`).
- Verified: node 29 passed; headless-Chrome checks of viewer and editor (dialog, polygon drawing,
  segment toggling, exports).

## 2026-11-07
- Created `CLAUDE.md` and this `claude/` folder.
- Finished the open part of HANDOFF.md (web sharing with council members):
  viewer `web/index.html` + `js/viewer.js` (state list from presets/index.json, layers, statistics,
  comparison table, "Jak číst mapu", shareable links, `#nahled` preview, mobile layout); editor moved to
  `web/upravy.html` with a "Sdílení" section (save state, preview, open state for editing with a backup
  variant); removed offline mode, service worker and manifest (old SW is unregistered);
  `web/tools/presets-index.mjs`; CI runs tests + generator; tests for state round-trip, validation,
  generator, links and Python parity; web/README rewritten.
- Fixed bugs found on the way: the web editor crashed on start (`s.pripojeni` was no longer returned)
  and in "new area from extent" (`o.dlazdice` missing); the web editor now reopens the last area.
- Rewrote all code to English (user request), keeping everything user-facing in Czech. Python package
  `dostupnost/` → `container_access/`; config.json keys, API routes and data folder names in English;
  added `container_access/migration.py` for old data folders.
- Verified: pytest 107 passed, node 23 passed, regenerated parity data byte-identical, headless-Chrome
  smoke tests of the viewer, the web editor and the Python app (`--offline`).
- Not done: nothing is committed. A git repository (branch `master`, no commits) appeared during the
  session; it was not created by Claude. Commit only when the user asks.
