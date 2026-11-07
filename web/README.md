# Webová verze (sdílení se zastupiteli)

Statický web pro GitHub Pages nebo GitLab Pages. Nepotřebuje server ani instalaci, vše běží
v prohlížeči. Má dvě stránky:

| Stránka | Pro koho | Co dělá |
|---|---|---|
| `index.html` | zastupitelé | prohlížení zveřejněných stavů („Současný stav“, „Návrh 1“, …), jen ke čtení, funguje i na mobilu |
| `upravy.html` | autor | režim úprav: oblasti, kontejnery, výpočet, exporty a uložení stavu pro web |

## Postup: jak zveřejnit nový stav

1. Otevři **`upravy.html`** (odkaz „režim úprav“ je i dole na hlavní stránce).
2. Připrav nebo vyber oblast, rozmísti kontejnery a zkontroluj výsledek (Spočítat vše).
3. V sekci **6 Sdílení se zastupiteli** klikni na **Uložit stav pro web…**:
   - **Název** uvidí zastupitelé v seznamu (např. „Současný stav“, „Návrh 1“),
   - **Popis** je nepovinný (ukáže se pod názvem),
   - **Pořadí** určuje pořadí v seznamu (1, 2, 3, …),
   - **Výchozí vrstva** je ta, která se ukáže po otevření (typ odpadu nebo Všechny typy).

   Stáhne se soubor, např. `02-navrh-1.json`. Obsahuje oblast (pěší síť a zjednodušený
   podklad), typy odpadu, kontejnery a hranice pásem.
4. Před zveřejněním si to můžeš prohlédnout tlačítkem **Náhled pro zastupitele**
   (otevře hlavní stránku s aktuálním stavem, jen v tomto prohlížeči).
5. Soubor nahraj do složky **`web/presets/`** v repozitáři (na GitHubu/GitLabu přes
   „Upload files“, nebo přes git) a změnu odešli (commit + push).
6. Po nasazení (pár minut) pošli zastupitelům odkaz na web. Seznam stavů se vytvoří
   automaticky z obsahu složky `presets/`. Odkaz na konkrétní stav a vrstvu zkopíruješ
   na hlavní stránce tlačítkem **kopírovat odkaz** (např. `…/#stav=02-navrh-1&vrstva=plast`).

### Způsob sběru (sdružený sběr, svoz od domu)

V sekci **2 Kontejnery** je odkaz **Způsob sběru…**. Pro každý typ odpadu tam nastavíš:

- **Svoz od domu** – komoditu mají všichni doma (pytle, popelnice u domu). Kontejnery tohoto typu,
  které rozmístíš, jsou jen **záložní místa**. Vrstva typu ukazuje vzdálenost k nim („Papír – záložní
  místa“) a typ se **nepočítá do souhrnu „Všechny typy“**.
- **Sbírá se také do kontejnerů** – sdružený sběr, např. kovy a nápojové kartony do kontejnerů na plast.
  Vzdálenost se pak počítá k nejbližšímu kontejneru kteréhokoli z uvedených typů (vlastní kontejnery
  typu mít nemusí).

Nastavení patří k rozmístění kontejnerů: ukládá se do variant, do stažené GeoJSON (položka `sber`)
i do uloženého stavu, takže každý návrh může mít jiný způsob sběru.

### Vyloučení částí sítě

V sekci **1 Oblast → Úprava sítě**:

- **Vyloučit oblast…** – klikáním do mapy obkreslíš území (např. les, pole) a dokončíš dvojklikem
  nebo tlačítkem Hotovo (Esc zruší).
- **Vyloučit / vrátit úseky** – klikem na pěší síť vyloučíš celý úsek mezi dvěma křižovatkami,
  dalším klikem ho vrátíš.

Vyloučené části se nekreslí a nepočítají do statistik ani do srovnání stavů a nejsou v exportech.
Chodit se po nich dá dál, takže vzdálenosti jinde se nezmění. Vyloučení patří k oblasti a ukládá se
i do stavu pro web. Seznam vyloučených oblastí (s možností smazání) je pod tlačítky.

### Barvy v prohlížení

Zastupitelé si mohou přepnout barvy mezi **pásmy** a **spojitou škálou**. Výchozí volba se bere
z režimu úprav v okamžiku uložení stavu (Výpočet → Barvy).

Spojitá škála se řídí hranicemi pásem, aby se četla stejně: zelená u kontejneru, žlutá na 1. hranici
(100 m), oranžová mezi hranicemi, **od 2. hranice (200 m) červená**, která dál tmavne až do dvojnásobku
poslední hranice (400 m). Když v režimu úprav změníš hranice pásem, posune se s nimi i škála.

Stav smažeš smazáním jeho souboru ze složky `presets/`. Opravu uděláš tak, že stav otevřeš
v režimu úprav (**Otevřít stav k úpravám…** – ze zveřejněného seznamu nebo ze souboru),
upravíš a uložíš znovu se stejným názvem a pořadím (vznikne soubor se stejným jménem).
Při otevření stavu se dosavadní kontejnery oblasti nejdřív uloží jako varianta.

## Co vidí zastupitelé

- výběr stavu, jeho popis a počty kontejnerů,
- volbu vrstvy (jednotlivé typy odpadu a Všechny typy) s legendou a přepínačem pásma / spojitá škála,
- popis způsobu sběru (svoz od domu, sdružený sběr),
- délku pěší sítě v pásmech (km a %),
- **Srovnání stavů**: tabulka s podílem sítě do hranic pásem pro každý stav a vrstvu
  (stavy se načtou až po kliknutí),
- vysvětlení „Jak číst mapu“,
- podklad: mapa OSM, zjednodušený nebo žádný,
- kontejnery s typem, číslem a poznámkou (po najetí myší nebo klepnutí).

## Nasazení

**GitLab Pages:** soubor `.gitlab-ci.yml` v kořeni při každém pushi do výchozí větve spustí
testy, vytvoří seznam stavů `presets/index.json`, zkopíruje `web/` do `public/` a zveřejní ho.
Adresa bude `https://<uživatel>.gitlab.io/<repozitář>/`.

**GitHub Pages:** v *Settings → Pages* nastav *Source: GitHub Actions*. Workflow
`.github/workflows/pages.yml` při pushi do `main` udělá totéž. Adresa bude
`https://<uživatel>.github.io/<repozitář>/`.

Když je některý soubor v `presets/` vadný (není to uložený stav), nasazení selže a v logu
je napsané, který soubor to je.

## Vyzkoušení na vlastním počítači

```
cd web
node tools/presets-index.mjs          # vytvoří presets/index.json
python -m http.server 8000            # libovolný statický server
```

a otevři `http://localhost:8000/` (prohlížení) nebo `http://localhost:8000/upravy.html` (úpravy).
Přes `file://` stránky nefungují (moduly JavaScriptu potřebují server).

## Kde jsou data

- **Zveřejněné stavy** jsou soubory ve složce `presets/` v repozitáři – vidí je každý, kdo má odkaz.
- **Rozpracovaná práce** v režimu úprav (oblasti, kontejnery, varianty, nastavení) je v IndexedDB
  **tohoto prohlížeče**. Jiný prohlížeč ji neuvidí a smazáním dat webu zmizí – zálohuj ji uložením
  stavu nebo exportem kontejnerů do GeoJSON.
- Prohlížeč se připojuje jen k Overpass API (stažení cest při přípravě oblasti) a k dlaždicím OSM.

Aplikace nefunguje offline (dřívější service worker se při otevření stránky sám odregistruje).
Oblast doporučujeme do ~30 km² (limit v `js/config.js`). Export pro QGIS je GeoJSON, QGIS ho otevře přímo.

## Konfigurace

Pásma, barvy, typy odpadu, výchozí oblast a adresy služeb jsou v `js/config.js`.

## Testy

```
cd web
node --test tests/*.test.js
```

Potřebuje Node 18+. Testovací data jsou smyšlená „vesnice Test“ (`tests/data/`). Soubor `parity.json`
obsahuje pevné referenční výsledky z dřívější Python verze aplikace – test hlídá, že se výpočet nezměnil.

## Struktura

```
index.html, js/viewer.js     prohlížení pro zastupitele
upravy.html, js/editor.js    režim úprav
js/backend.js                „server“ režimu úprav v prohlížeči (volání /api/…, data v IndexedDB)
js/state.js                  formát uloženého stavu, odkazy, srovnání
js/collection.js             způsob sběru (svoz od domu, sdružený sběr)
js/exclusions.js             vyloučené části sítě
js/compute.js, network.js, osm.js, geo.js   výpočet a data OSM
js/render.js                 společné vykreslování (i pro exportované HTML)
js/exports.js                exporty GeoJSON, HTML, PNG, ZIP
js/storage.js                IndexedDB
tools/presets-index.mjs      generátor presets/index.json (spouští CI)
presets/                     zveřejněné stavy (*.json)
```
