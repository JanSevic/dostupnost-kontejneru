# Předávka vývoje (stav k 7. 11. 2026)

## Projekt
Aplikace počítá pěší dostupnost kontejnerů na tříděný odpad v obci Dřínov (okres Mělník).
Uživatel umístí kontejnery podle typu do mapy OSM. Aplikace pak obarví pěší síť podle vzdálenosti
k nejbližšímu kontejneru daného typu (počítá se po pěších cestách OSM) a přidá vrstvu „Všechny typy“.
Ta pro každé místo ukazuje maximum vzdáleností přes všechny typy. **Rozhraní je česky, kód anglicky**
(identifikátory, komentáře, názvy souborů a modulů, interní API).

Schválená pravidla:
- Cyklostezky se počítají jako pěší, pokud nemají `foot=no`.
- Přípojka kontejneru k cestě se započítává do vzdálenosti.
- Souhrnná vrstva „Všechny typy“ = maximum přes typy.

Co zůstává česky i v kódu (je to rozhraní pro uživatele, ne kód):
- texty v aplikaci, chybové hlášky, README, HANDOFF, názvy stahovaných souborů,
- vlastnosti kontejnerů v GeoJSON (`id`, `typ`, `poznamka`) – uživatel je upravuje v QGIS,
- názvy vrstev a sloupců v exportu pro QGIS (`kontejnery`, `sit_vzdalenosti`, `d_<typ>`, `pasmo_<typ>`, …),
- adresa stránky úprav `upravy.html` a parametry odkazu `#stav=…&vrstva=…` / `#nahled`,
- spouštěče `spustit.*` a přepínače příkazové řádky (`--bez-prohlizece`, `--offline`, …).

## Části
1. **Python verze** (kořen repozitáře: `app.py`, balíček `container_access/`, `static/`, `tests/`). Hotová.
   - Server na FastAPI s rozhraním v Leafletu, více oblastí, offline režim, exporty GeoPackage/HTML/PNG.
   - Data stahuje jedním dotazem na Overpass (`container_access/overpass.py`), při chybě zkusí další server.
   - Klíče `config.json` jsou anglicky (`types`, `bands_m`, `tiles`, …), popis v README.
   - Datová složka má anglické názvy (`data/areas/<slug>/area.json`, …). Data ze starší verze
     (`data/oblasti/…`) převede při startu `container_access/migration.py`.
   - Testy: `python -m pytest` (107 testů prošlo).
2. **Webová verze** (`web/`). Statický web pro GitHub/GitLab Pages, výpočet běží v prohlížeči. Hotová.
   - `index.html` + `js/viewer.js`: prohlížení zveřejněných stavů pro zastupitele (seznam z
     `presets/index.json`, volba vrstvy, statistika, srovnání stavů, „Jak číst mapu“, odkazy
     `#stav=<soubor>&vrstva=<klíč>`, náhled `#nahled` z IndexedDB, layout pro mobil).
   - `upravy.html` + `js/editor.js`: režim úprav (bez offline režimu) se sekcí „Sdílení“:
     Uložit stav pro web…, Náhled pro zastupitele, Otevřít stav k úpravám… (ze souboru nebo
     ze zveřejněného seznamu; dosavadní kontejnery se uloží jako varianta). Po načtení stránky
     se otevře naposledy otevřená oblast.
   - `js/backend.js` napodobuje volání `/api/...` Python serveru (stejné anglické adresy a klíče).
   - `js/state.js`: formát stavu (`format: "dostupnost-kontejneru/state"`, `version: 1`), validace,
     souhrn do seznamu, výpočet, srovnání, odkazy.
   - `tools/presets-index.mjs`: generátor `presets/index.json` (spouští CI, lokálně ručně).
   - Service worker a manifest jsou odstraněné; `js/unregister-sw.js` odregistruje starý.
   - Testy: `cd web && node --test tests/*.test.js` (23 testů prošlo), včetně shody s Pythonem.
   - Nasazení: `.gitlab-ci.yml` (node:20-alpine) a `.github/workflows/pages.yml` spustí testy,
     generátor seznamu a zveřejní `web/` (bez `tests/`, `tools/`, `package.json`).
   - Postup pro autora je v `web/README.md`.

## Ověřeno
- Obě testovací sady prošly; `tests/generate_web_parity.py` po přejmenování vygeneroval
  bajtově stejná testovací data (výpočet se nezměnil).
- Ruční zkouška v headless Chrome: prohlížení (seznam, vrstvy, statistika, srovnání, odkazy,
  mobil), úpravy (převzetí stavu, výpočet, dialog uložení, náhled) a Python verze s `--offline`
  (otevření oblasti, přidání kontejnerů, výpočet, export GeoPackage).

## Poznámky
- Testovací data jsou smyšlená „vesnice Test“ v polích mezi Dřínovem a Netřebou: `tests/osm_xml.py`, `web/tests/data/`.
- `static/render.js` a `static/export-template.html` jsou kopie `web/js/render.js` a
  `web/export-template.html` – při změně uprav obě. Totéž platí pro `static/app.js` a `web/js/editor.js`
  (stejný editor, Python verze má navíc offline režim a dlaždice, webová sdílení).
- Webová verze ukládá rozpracovanou práci do IndexedDB `dostupnost-kontejneru-v2`; data z dřívější
  české verze (databáze `dostupnost-kontejneru`) se nepřevádějí.
- Podmínky tile.openstreetmap.org zakazují offline použití a předstahování dlaždic. Online zobrazení je v pořádku.
- E-mail uživatele nepatří do User-Agentu.
- Nezačaté rozšíření z původního zadání: budovy, ruční úpravy sítě, porovnání variant
  (částečně pokrývá srovnání stavů ve webové verzi).
