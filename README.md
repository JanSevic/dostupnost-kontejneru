# Pěší dostupnost kontejnerů na tříděný odpad

Webová aplikace s mapou OpenStreetMap pro obec **Dřínov (okres Mělník)**. Do mapy se naklikají
stanoviště kontejnerů (každý typ odpadu zvlášť) a aplikace obarví pěší síť podle toho, jak daleko
je to **po pěších cestách** (ne vzdušnou čarou) k nejbližšímu kontejneru daného typu. Vrstva
**Všechny typy** ukazuje pro každé místo nejdelší z cest k nejbližším kontejnerům jednotlivých typů.

Aplikace je statický web (GitHub Pages / GitLab Pages), vše se počítá v prohlížeči. Nepotřebuje
server, placené služby ani API klíče. Data se stahují z OpenStreetMap přes Overpass API.

- **Prohlížení** (`index.html`) – pro zastupitele: zveřejněné stavy („Současný stav“, „Návrh 1“, …),
  vrstvy, statistika, srovnání stavů, funguje i na mobilu.
- **Režim úprav** (`upravy.html`) – pro autora: oblasti, kontejnery, způsob sběru (svoz od domu,
  sdružený sběr), vyloučení částí sítě, výpočet, varianty, exporty a uložení stavu pro web.

**Návod, nasazení a postup zveřejnění stavu:** [`web/README.md`](web/README.md).

## Pravidla výpočtu

- Pěší síť jsou cesty z OSM, kterými smí chodci projít. Cyklostezky se počítají jako pěší, pokud
  nemají `foot=no`.
- Kontejner se kolmo připojí k nejbližší cestě a délka této přípojky se započítává do vzdálenosti.
- Vzdálenost se počítá pro kousky sítě po cca 10 m (vícezdrojový Dijkstra).
- „Všechny typy“ = maximum přes typy (typy se svozem od domu se nezapočítávají).

## Známá omezení

- **Výsledek závisí na úplnosti pěších cest v OSM.** Chybějící pěšina nebo průchod znamená delší
  vzdálenost, případně „nedosažitelnou“ část sítě. Naopak cesta zakreslená, ale ve skutečnosti
  neprůchozí, výsledek zkrátí. Nejlepší oprava je doplnit cestu přímo do OpenStreetMap a v režimu
  úprav dát „Aktualizovat data“.
- Overpass API bývá občas přetížené – pak stačí to zkusit za pár minut.

## Struktura

```
web/                          aplikace (viz web/README.md)
.github/workflows/pages.yml   nasazení na GitHub Pages
.gitlab-ci.yml                nasazení na GitLab Pages
CLAUDE.md, claude/            poznámky pro AI asistenta
```

Testy: `cd web && node --test tests/*.test.js` (Node 18+).

Mapová data © přispěvatelé OpenStreetMap, licence ODbL. Leaflet © Volodymyr Agafonkin (BSD-2).
