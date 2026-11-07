# Pěší dostupnost kontejnerů na tříděný odpad

Lokální aplikace s mapou OpenStreetMap. Do mapy naklikáš stanoviště kontejnerů
(každý typ odpadu zvlášť) a aplikace obarví celou pěší síť podle toho, jak daleko
je to **po pěších cestách** (ne vzdušnou čarou) k nejbližšímu kontejneru daného typu.

Výchozí oblast je obec **Dřínov (okres Mělník)**, aplikace ale funguje pro libovolné
území a pro víc oblastí vedle sebe. **Připravená oblast funguje i bez internetu**
(zobrazení, výpočet, ukládání i všechny exporty).

Nepotřebuje žádné placené služby ani API klíče. Data se stahují z OpenStreetMap přes
Overpass API (veřejná služba pro dotazy na data OSM); online se jako podklad zobrazují
standardní dlaždice OSM, offline vektorový podklad vykreslený přímo z dat OSM.

---

## Webová verze

Složka `web/` obsahuje statickou verzi aplikace, která běží celá v prohlížeči a dá se zveřejnit
na GitHub Pages nebo GitLab Pages (konfigurace `.github/workflows/pages.yml` a `.gitlab-ci.yml`).
Slouží ke **sdílení se zastupiteli**: autor v režimu úprav (`upravy.html`) připraví stavy
(„Současný stav“, „Návrh 1“, …), uloží je do složky `web/presets/` a zastupitelé si je
prohlížejí na hlavní stránce (`index.html`), i na mobilu. Podrobnosti v [`web/README.md`](web/README.md).

## Instalace a spuštění

Potřebuješ **Python 3.11 nebo novější** (https://www.python.org/downloads/).
Na Windows při instalaci zaškrtni „Add python.exe to PATH“.

| Systém | Spuštění |
|---|---|
| Windows | dvojklik na `spustit.bat` |
| macOS | dvojklik na `spustit.command` (poprvé případně pravým tlačítkem → Otevřít) nebo v Terminálu `./spustit.sh` |
| Linux | v terminálu `./spustit.sh` |

Skript při prvním spuštění vytvoří ve složce aplikace virtuální prostředí `.venv`
(oddělenou instalaci knihoven jen pro tuto aplikaci) a nainstaluje knihovny
z `requirements.txt` – to trvá několik minut. Další spuštění jsou rychlá.
Pak se sám otevře prohlížeč s aplikací. Aplikace běží, dokud nezavřeš okno
terminálu (nebo nestiskneš Ctrl+C).

Ruční spuštění bez skriptu:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt        # Windows: .venv\Scripts\pip ...
.venv/bin/python app.py                           # Windows: .venv\Scripts\python app.py
```

Volby:

| volba | význam |
|---|---|
| `--offline` | zablokuje veškerý síťový přístup aplikace (ověření, že vše funguje bez internetu) |
| `--port 8800` | jiný port |
| `--bez-prohlizece` | neotvírat prohlížeč |
| `--data SLOŽKA` | jiná složka s daty (výchozí `data/` vedle `app.py`) |
| `--config SOUBOR` | jiný konfigurační soubor |

Když aplikace už běží, další spuštění jen otevře prohlížeč (dvě kopie by si
přepisovaly data).

---

## Ovládání

Panel vlevo má pět kroků:

### 1. Oblast
**Oblast** je pracovní prostor pro jedno území: pěší síť, vektorový podklad, kontejnery,
varianty a exporty jsou v její složce (`data/areas/<název>/`). Oblastí může být víc.

- Při startu se zobrazí **výběr oblasti** (naposledy použitá je nahoře). Tlačítkem
  **Změnit…** se k výběru vrátíš kdykoli.
- **Připravit Dřínov (okres Mělník)** – výchozí oblast (výřez z `config.json` + 300 m).
- **Připravit oblast pro offline…** – pro **aktuální výřez mapy + okraj 300 m** stáhne:
  1. pěší síť,
  2. vektorový podklad z OSM: budovy, všechny cesty, vodní plochy a toky, lesy a zeleň,
     železnice, názvy ulic a obcí,
  3. rastrové dlaždice – jen pokud to dlaždicový server dovoluje (viz níže),
  4. metadata: název, hranice, datum stažení, zdroj, atribuce.
  Před stažením ukáže plochu a (u povoleného serveru) počet dlaždic; zeptá se na název.
  Pojistka: oblast větší než 30 km² (i s okrajem) se nestáhne – přibliž mapu.
- **Aktualizovat data** – znovu stáhne síť a podklad otevřené oblasti; kontejnery,
  varianty a exporty zůstanou. Datum stažení dat je vidět v rámečku oblasti.
  Při chybě (např. výpadek spojení) zůstanou stará data beze změny.
- **Ze souboru .osm…** (ve výběru oblastí) – vytvoří oblast ze souboru OSM, funguje
  i offline. Soubor stáhneš na openstreetmap.org (Export → ručně vybrat oblast) nebo z JOSM.
  Hodí se i tehdy, když je Overpass přetížený.
- **Podklad:** *automaticky* (online dlaždice OSM; kde nejsou – offline, při větším
  přiblížení nebo chybějící dlaždici – vektorový podklad), *vektorový* (jen vektor),
  *žádný*.
- **Připojení:** odznak nahoře ukazuje *online / offline*. Zaškrtávátko
  **pracovat offline** aplikaci ručně přepne do offline režimu (nic nestahuje).
  Funkce, které potřebují internet, jsou offline zašedlé a po najetí myší řeknou proč.

### 2. Kontejnery
- Vyber **aktivní typ** (plast, papír, sklo, kovy, textil, nápojové kartony, jedlé oleje).
- **Klik do mapy** = nový kontejner aktivního typu, **tažení značky** = přesun,
  **klik na značku** = okénko, kde změníš typ, napíšeš poznámku nebo kontejner smažeš
  (smazání jde hned vrátit tlačítkem „Vrátit“).
- Zaškrtávátko „přidávat kliknutím do mapy“ vypne přidávání, když si chceš
  mapu jen prohlížet.
- Seznam ukazuje všechny kontejnery a počty po typech; klik na položku mapu
  přiblíží na kontejner.
- **Vše se průběžně automaticky ukládá** (`containers.geojson` ve složce oblasti),
  při dalším otevření oblasti se rozmístění obnoví.

### 3. Výpočet
- **Spočítat: [typ]** – pro aktivní typ, **Spočítat vše** – pro všechny typy
  s aspoň jedním kontejnerem + souhrnná vrstva.
- **Pásma** – výchozí 0–100 m zelená, 100–200 m oranžová, nad 200 m červená
  (doporučení EKO-KOM). Hranice můžeš přepsat; mapa se překreslí hned bez
  přepočtu. „spojitá škála“ přepne na plynulý přechod barev 0–400 m.
- „přepočítat automaticky po změně“ – po každém přidání/přesunu kontejneru se
  zobrazená vrstva sama přepočítá.
- Varování se ukazují pod tlačítky a problémová značka dostane vínový kroužek:
  - kontejner je dál než 30 m od cesty,
  - kontejner leží mimo načtenou síť (nezapočítá se),
  - kontejner je připojený k **izolovanému kousku cesty**, který v OSM nenavazuje
    na zbytek sítě (pak by z něj „nikam nevedla cesta“ – posuň ho blíž k hlavní cestě
    nebo doplň spojení v OSM),
  - typ nemá žádný kontejner.

### 4. Výsledek na mapě
- Přepínač, který typ je obarvený (vždy jeden, aby se barvy nepřekrývaly),
  a **Všechny typy (souhrn)** = nejdelší z cest k nejbližším kontejnerům
  jednotlivých typů, tj. kolik musí člověk z daného místa nejvýš ujít, aby
  odnesl všechny druhy odpadu (každý druh zvlášť tam a zpět).
- Šedě = nedosažitelné části sítě (nejsou spojené s žádným kontejnerem).
- Najetím myší na cestu uvidíš přesnou vzdálenost.
- Pod přepínačem je tabulka, kolik km sítě leží v jednotlivých pásmech.
- Vrstva označená „(neaktuální)“ – od výpočtu se změnily kontejnery, spočítej znovu.

### 5. Soubory
- **Uložit variantu…** – uloží aktuální rozmístění pod jménem do složky `variants/`
  v oblasti. Každý soubor = jedna varianta rozmístění. Stejný název se před přepsáním
  potvrzuje.
- **Načíst variantu…** – vybereš ze seznamu; nahradí aktuálně zadané kontejnery.
- **stáhnout GeoJSON / nahrát GeoJSON…** – výměna souboru s kontejnery mimo
  aplikaci (např. do/z QGIS) nebo mezi oblastmi.
- **Export**
  - **HTML** – samostatná interaktivní mapa v jednom souboru (kontejnery, obarvená
    síť, legenda, přepínání typů, vektorový podklad). **Funguje bez internetu** –
    Leaflet i podklad jsou vložené přímo v souboru. Má-li oblast uložené dlaždice,
    lze je volitelně vložit také (aplikace předem ukáže, o kolik MB soubor naroste).
  - **PNG A4** – mapa pro tisk (A4 na šířku, 300 dpi) s titulkem, datem, legendou,
    měřítkem, severkou a atribucí. Kreslí **aktuální výřez a zobrazenou vrstvu**;
    se zaškrtnutým „PNG pro všechny vrstvy“ vznikne ZIP s mapou pro každý typ + souhrn.
    Podklad se skládá **jen z uložených dlaždic nebo vektorových dat, nic se nestahuje**.
  - **GeoPackage** – pro QGIS (viz níže).
  - Exporty se stáhnou prohlížečem a kopie zůstává ve složce `outputs/` oblasti.
  - Exporty vždy přepočítají všechny typy podle aktuálního rozmístění.

---

## Co potřebuje internet a co funguje offline

| Potřebuje internet | Funguje offline |
|---|---|
| instalace knihoven (první spuštění `spustit.*`) | spuštění aplikace a výběr oblasti |
| příprava oblasti (Overpass API) | zobrazení oblasti s vektorovým podkladem (a uloženými dlaždicemi, jsou-li) |
| aktualizace dat oblasti | zadávání, přesun, mazání kontejnerů, automatické ukládání |
| dlaždice OSM jako podklad při prohlížení | výpočet vzdáleností, pásma, souhrn |
| | varianty, nahrání/stažení GeoJSON |
| | export HTML, PNG i GeoPackage |
| | nová oblast ze souboru .osm |

Aplikace sama pozná, že internet chybí (odznak *offline*); můžeš ji také přepnout ručně.
Ověření: `python app.py --offline` zablokuje veškerý síťový přístup aplikace.

### Rastrové dlaždice a podmínky OSM
Podmínky serveru **tile.openstreetmap.org** offline použití a předstahování dlaždic
**zakazují** (https://operations.osmfoundation.org/policies/tiles/). Proto:

- dlaždice OSM načítá jen prohlížeč při běžném prohlížení online a ukládá si je
  do své mezipaměti podle hlaviček serveru,
- offline se místo nich kreslí **vektorový podklad** z dat OSM (data OSM smí být
  pod licencí ODbL používána i offline),
- PNG a HTML exporty používají vektorový podklad.

Předstahování dlaždic pro offline je připravené pro **jiný dlaždicový server, jehož
podmínky to dovolují** (např. vlastní). Nastavíš ho v `config.json` (sekce `tiles`):
`url` s `{z}/{x}/{y}` a `"offline_allowed": true`. Pak platí:

- pro jednu oblast nejvýš **250 dlaždic na zoomu 13 a vyšším** (`offline_max_tiles`,
  `offline_min_zoom` mohou limit jen zpřísnit, ne povolit víc); počet se spočítá předem a nejvyšší zoom se zvolí tak, aby limit
  nepřekročil (oblast cca 2 × 2 km → zoom 17); když se oblast nevejde ani na zoom 13,
  aplikace to oznámí a dlaždice nestáhne (oblast se připraví s vektorovým podkladem),
- přehledové zoomy 10–12 (pár dlaždic) se stahují navíc,
- stahuje se **postupně** (jedna dlaždice po druhé) s vlastním User-Agentem,
- při aktualizaci se server ptá podmíněně (ETag / Last-Modified), nezměněné dlaždice
  se znovu nestahují.

Pro tile.openstreetmap.org (i tile.osm.org) aplikace předstahování odmítne, i kdyby bylo
v konfiguraci zapnuté. Když se některá dlaždice nestáhne, oblast se připraví i tak
(při aktualizaci zůstanou předchozí dlaždice) a v rámečku oblasti je uvedený důvod.

**User-Agent** (identifikace aplikace pro servery OSM) je `user_agent` v `config.json`;
do pole `contact` můžeš doplnit e-mail nebo web, pak se připojí k User-Agentu.

---

## Jak se počítá

1. **Pěší síť z OSM.** Vychází z typu sítě „walk“ knihovny osmnx s těmito úpravami:
   - vyřazeny jsou cesty s `foot=no`, `access=private/no` a `service=private`,
     ale cesty s výslovným `foot=yes/designated/permissive` zůstávají
     (např. pěší zóna s `access=no` + `foot=yes`);
   - **cyklostezky** (`highway=cycleway`) jsou zahrnuté, pokud nemají `foot=no`
     (osmnx je jinak vyřazuje celé, v ČR jsou ale často společné pro chodce a cyklisty);
   - silnice se samostatně zakreslenými chodníky (`sidewalk=separate`) zůstávají,
     aby se síť nerozpadla tam, kde chybí zakreslené přechody;
   - vyřazeny jsou dálnice, rozestavěné a zrušené cesty, nástupiště;
   - všechny úseky jsou obousměrné.
2. Síť se převede do metrického systému UTM (pro Dřínov EPSG:32633) a každý úsek
   se rozdělí na kousky po cca 10 m.
3. **Připojení kontejneru:** kolmý průmět na nejbližší úsek sítě (ne na nejbližší
   uzel). Délka této kolmice („přípojka“) se do vzdálenosti započítává.
4. **Vícezdrojový Dijkstra** ze všech kontejnerů daného typu najednou: koncové uzly
   úseku s kontejnerem dostanou počáteční vzdálenost *s + t* a *s + L − t*
   (*s* = přípojka, *t* = poloha průmětu, *L* = délka úseku).
5. **Uvnitř úseku** délky *L* mezi uzly *u*, *v* v místě *x* od *u*:
   `d(x) = min(d(u) + x, d(v) + L − x)`, na úseku s kontejnerem navíc `s + |x − t|`.
   Počítá se pro střed každého 10m kousku.
6. Kontrola: vzdálenost po síti nesmí být nikde menší než vzdušná vzdálenost
   k nejbližšímu kontejneru (počítá se při každém výpočtu).

---

## Konfigurace (`config.json`)

| Klíč | Význam |
|---|---|
| `territory_name` | název obce, doplní se do výchozího titulku mapy |
| `default_view` | střed a přiblížení mapy při prvním spuštění |
| `types` | typy odpadu: `key` (klíč – jen malá písmena bez diakritiky, číslice, `_`), `name` (název), `color` (barva), `abbr` (zkratka ve značce) |
| `bands_m` | výchozí hranice pásem v metrech (počet barev = počet hranic + 1) |
| `band_colors`, `unreachable_color` | barvy pásem a barva nedosažitelných míst |
| `continuous_max_m` | konec spojité barevné škály |
| `network_margin_m` | okraj kolem výřezu při stahování sítě (300 m) |
| `max_plocha_km2` | pojistka proti stažení příliš velkého území |
| `segment_length_m` | délka kousků pro obarvení (10 m) |
| `connection_warning_m` | od jaké vzdálenosti od cesty se hlásí varování (30 m) |
| `default_area` | název (`name`) a výřez (`extent`) výchozí oblasti (Dřínov) `[západ, jih, východ, sever]` |
| `tiles` | dlaždicový server: `url`, `attribution`, `max_zoom`, pravidla pro offline (`offline_allowed`, `offline_max_tiles`, `offline_min_zoom`, `offline_max_zoom`, `offline_overview_zooms`) |
| `overpass_url` | seznam serverů Overpass API; při přetížení nebo chybě se zkusí další v pořadí |
| `connectivity_check_url` | adresa, na které se ověřuje připojení (lehký dotaz, nejvýš jednou za minutu) |
| `user_agent`, `contact` | identifikace aplikace při stahování |
| `port` | port lokálního serveru (když je obsazený, použije se další volný) |

**Přidání typu:** do pole `types` připiš např.
`{"key": "bio", "name": "Bioodpad", "color": "#7a4b1f", "abbr": "Bi"}`.
**Přejmenování:** změň `name` (a případně `abbr`). Neměň `key` – podle něj se
typ páruje s uloženými soubory. Po úpravě aplikaci restartuj.

---

## Formáty souborů

### Kontejnery – GeoJSON
Soubory variant, `containers.geojson` v oblasti i „stáhnout GeoJSON“ mají stejný formát:
`FeatureCollection` bodů v souřadnicích WGS84 (EPSG:4326, [délka, šířka]),
vlastnosti:

| vlastnost | význam |
|---|---|
| `id` | číslo kontejneru (jedinečné) |
| `typ` | klíč typu z config.json (`plast`, `papir`, `sklo`, `kovy`, `textil`, `kartony`, `oleje`) |
| `poznamka` | volný text |

```json
{"type": "FeatureCollection", "features": [
  {"type": "Feature", "geometry": {"type": "Point", "coordinates": [14.3975, 50.2736]},
   "properties": {"id": 1, "typ": "plast", "poznamka": "náves"}}
]}
```

Při nahrávání cizího souboru se typ pozná i podle názvu („Sklo“), chybějící nebo
duplicitní `id` se přidělí znovu, neznámý typ se přidá jako dočasný (s varováním)
a soubor v jiném souřadnicovém systému (např. S-JTSK z QGIS s uvedeným `crs`) se
převede.

### GeoPackage (`.gpkg`) pro QGIS
Souřadnicový systém UTM (pro Dřínov EPSG:32633). Vrstvy:

- **`kontejnery`** – body: `id`, `typ`, `typ_nazev`, `poznamka`, `pripojeni_m`
  (délka přípojky k síti), `varovani` („daleko od cesty“, „mimo načtenou síť“,
  „izolovaný kousek cesty“).
- **`sit_vzdalenosti`** – kousky sítě (cca 10 m): `delka_m`, pro každý typ
  `d_<typ>` (vzdálenost v metrech, prázdné = nedosažitelné) a `pasmo_<typ>`
  (text „0–100 m“, „100–200 m“, „nad 200 m“, „nedosažitelné“); souhrn je `d_vse`
  a `pasmo_vse`.

V QGIS: Vlastnosti vrstvy → Symbologie → *Kategorizovaný* podle `pasmo_plast`,
nebo *Odstupňovaný* podle `d_plast`.

### HTML a PNG
Viz výše (Soubory → Export). PNG je ve 300 dpi, rozměr 3507 × 2481 px.

### Oblast (offline balíček)
```
data/
  settings.json                  naposledy otevřená oblast, ruční offline režim
  areas/
    drinov_okres_melnik/
      area.json                  metadata: název, výřez, hranice (bbox), datum stažení,
                                 zdroj, atribuce, souhrn sítě, podkladu a dlaždic
      network.graphml            pěší síť (formát GraphML, osmnx)
      basemap.geojson            vektorový podklad (vlastnosti k = druh, t = podtyp,
                                 n = název, a = úhel popisku)
      tiles/{z}/{x}/{y}.png      uložené dlaždice (jen u povoleného serveru) + index.json
      containers.geojson         průběžně ukládané rozmístění
      variants/                  uložené varianty
      outputs/                   exporty (HTML, PNG, GPKG)
```
Složku `data` můžeš zálohovat nebo zkopírovat na jiný počítač (oblast pak funguje
offline i tam). Oblast smažeš smazáním její složky.

Data z verze s českými názvy souborů (`data/oblasti/…/oblast.json`, `data/nastaveni.json`)
se při prvním spuštění automaticky převedou do nové struktury. Kontejnery a varianty z ještě
starší verze aplikace (bez oblastí, `data/autosave.geojson`, `data/varianty/`) převezme
automaticky první nově připravená oblast.

---

## Známá omezení

- **Výsledek závisí na úplnosti pěších cest v OSM.** Chybějící pěšina, průchod
  nebo přechod v OSM znamená, že ji výpočet nezná – vzdálenost pak vyjde delší,
  případně část sítě „nedosažitelná“. Naopak cesta zakreslená, ale ve skutečnosti
  neprůchozí (plot, zamčená brána bez `access` tagu), výsledek zkrátí. Nejlepší
  oprava je doplnit cestu přímo do OpenStreetMap (a pak „Aktualizovat data“).
- Za okrajem oblasti (výřez + 300 m) síť nepokračuje – kontejnery sousední obce
  dál než 300 m za okrajem se nezapočítají. Pro okrajové části obce připrav
  oblast z většího výřezu.
- Počítá se vzdálenost, ne čas: nezohledňuje převýšení, schody, kvalitu povrchu
  ani bezpečnost přecházení silnice.
- Vzdálenost se měří po ose cesty – silnice je jedna čára, takže nezáleží na tom,
  po které straně člověk jde, a přejít ji jde kdekoli (pokud nejsou chodníky
  zakreslené zvlášť).
- Velká území (desítky km²) jsou v prohlížeči pomalejší – kreslí se každý 10m kousek.
- Overpass API bývá občas přetížený – aplikace pak zkusí další server z `overpass_url`.
  Síť i podklad se stahují jedním dotazem; nejdéle obvykle trvá, než server dotaz
  zpracuje (průběh ukazuje čekání v sekundách a stažené MB). Když nepomůže ani to,
  zkus to za pár minut, případně vytvoř oblast ze souboru .osm.
- Offline podklad je zjednodušený vektorový (bez vrstevnic, adres a ikon). Dlaždice
  OSM jsou jen online – jejich podmínky offline použití nedovolují.
- Popisky ulic se kreslí jeden na ulici, bez hlídání překryvů.
- Ověření připojení je lehký dotaz na `connectivity_check_url`; za firemní proxy
  se může stát, že aplikace ukáže *offline*, i když internet funguje – pak ji
  přepni ručně (odškrtni „pracovat offline“ a zkus akci znovu).

---

## Testy

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

Testy (bez přístupu k internetu) ověřují:
- výpočet na malých umělých sítích se známým výsledkem (přímka, zakřivený úsek,
  paralelní úseky a smyčka, nedosažitelná komponenta, přípojka, dlouhé připojení),
- shodu s referenčním Dijkstrou na zhuštěné síti (náhodné sítě),
- že vzdálenost po síti není nikdy menší než vzdušná,
- filtr pěších cest, zpracování dat OSM (soubor .osm i podstrčená odpověď Overpass),
  vektorový podklad,
- oblasti: příprava (výchozí Dřínov), aktualizace, více oblastí, převzetí a převod starých dat,
- dlaždice: plán podle limitu 250 (2 × 2 km → zoom 17), postupné stahování
  s User-Agentem, podmíněná aktualizace, zákaz pro tile.openstreetmap.org, mozaika pro PNG,
- **offline režim**: blokace sítě přepínačem `--offline` a celý běh aplikace
  v samostatném procesu s `--offline` – start, otevření oblasti, výpočet a všechny
  exporty,
- REST API, chybové stavy (žádná oblast, typ bez kontejnerů, stahování selhalo,
  offline, kontejner mimo síť) a všechny exporty.

Testy používají smyšlenou **vesnici Test** (vygenerovaná síť, podklad a názvy, umístěná
do polí mezi Dřínovem a Netřebou, aby se nepřekrývala se skutečnou obcí), skutečná
data se v nich nestahují.

---

## Struktura projektu

```
app.py               spuštění serveru a otevření prohlížeče
config.json          konfigurace
spustit.bat/.sh/.command
container_access/    (kód je v angličtině, rozhraní aplikace česky)
  config.py          načtení config.json, cesty k datům, User-Agent, pravidla dlaždic
  areas.py           oblasti: příprava, aktualizace, seznam
  overpass.py        stažení dat oblasti jedním dotazem na Overpass API
  basemap.py         vektorový podklad z OSM
  tiles.py           plán a postupné stahování dlaždic, mozaika pro PNG
  connectivity.py    stav připojení, blokace sítě (--offline)
  network.py         filtr cest, zpracování dat OSM, rozdělení na kousky
  compute.py         připojení kontejnerů, Dijkstra, vzdálenosti, kontroly
  storage.py         GeoJSON kontejnerů, autosave, varianty
  exports.py         HTML, PNG, GeoPackage
  migration.py       převod datové složky ze starší verze
  server.py          FastAPI – REST API
static/              rozhraní (HTML, JS, CSS) + přibalený Leaflet 1.9.4 (žádné CDN);
                     render.js a export-template.html jsou kopie souborů z web/
tests/               testy (generate_web_parity.py vytváří data pro test shody s webovou verzí)
web/                 webová verze (viz web/README.md)
```

Mapová data © přispěvatelé OpenStreetMap, licence ODbL. Leaflet © Volodymyr Agafonkin (BSD-2).
