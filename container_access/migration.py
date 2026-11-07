"""One-time migration of the data folder from versions with Czech file names and keys.

Old layout::

    data/nastaveni.json                      {"posledni_oblast", "offline_rucne"}
    data/oblasti/<slug>/oblast.json          metadata with Czech keys
                        sit.graphml, podklad.geojson (codes v=…), dlazdice/,
                        kontejnery.geojson, varianty/, vystupy/

New layout: see areas.py. Container files keep their content (properties id/typ/poznamka are
the user-facing file format and did not change).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

log = logging.getLogger("container_access")

FILE_NAMES = {
    "oblast.json": "area.json",
    "sit.graphml": "network.graphml",
    "podklad.geojson": "basemap.geojson",
    "dlazdice": "tiles",
    "kontejnery.geojson": "containers.geojson",
    "varianty": "variants",
    "vystupy": "outputs",
}
META_KEYS = {
    "verze": "version", "nazev": "name", "vyrez": "extent", "okraj_m": "margin_m", "plocha_km2": "area_km2",
    "stazeno": "downloaded", "vytvoreno": "created", "zdroj": "source", "atribuce": "attribution",
    "sit": "network", "podklad": "basemap", "dlazdice": "tiles",
}
NETWORK_KEYS = {"delka_km": "length_km", "pocet_kousku": "segment_count"}
TILES_KEYS = {"stazeny": "downloaded", "duvod": "reason", "pocet": "count", "velikost_b": "size_b",
              "stazeno": "downloaded_at"}
TILE_INDEX_KEYS = {"stazeno": "downloaded", "overeno": "verified"}
BASEMAP_KINDS = {"zelen": "green", "les": "forest", "voda": "water", "tok": "stream", "budova": "building",
                 "cesta": "road", "zeleznice": "railway", "popisek": "label", "misto": "place"}
ROAD_CLASSES = {"hlavni": "major", "ulice": "street", "vedlejsi": "service", "polni": "track", "pesi": "path"}


def _rename_keys(d: dict, names: dict) -> dict:
    return {names.get(k, k): v for k, v in d.items()}


def _read(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write(path: Path, data, compact: bool = False):
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":")) if compact else \
        json.dumps(data, ensure_ascii=False, indent=1)
    path.write_text(text, encoding="utf-8")


def convert_meta(m: dict) -> dict:
    m = _rename_keys(m, META_KEYS)
    if isinstance(m.get("network"), dict):
        m["network"] = _rename_keys(m["network"], NETWORK_KEYS)
    if isinstance(m.get("basemap"), dict):
        m["basemap"] = {BASEMAP_KINDS.get(k, k): v for k, v in m["basemap"].items()}
    if isinstance(m.get("tiles"), dict):
        m["tiles"] = _rename_keys(m["tiles"], TILES_KEYS)
    return m


def convert_basemap(fc: dict) -> dict:
    for f in fc.get("features") or []:
        p = f.get("properties") or {}
        if "v" in p:
            kind = BASEMAP_KINDS.get(p.pop("v"), "green")
            new = {"k": kind}
            if "t" in p:
                t = p.pop("t")
                new["t"] = ROAD_CLASSES.get(t, t) if kind in ("road", "label") else t
            new.update(p)
            f["properties"] = new
    if "souhrn" in fc:
        fc["summary"] = {BASEMAP_KINDS.get(k, k): v for k, v in fc.pop("souhrn").items()}
    return fc


def _migrate_area(folder: Path):
    for old, new in FILE_NAMES.items():
        if (folder / old).exists() and not (folder / new).exists():
            (folder / old).rename(folder / new)
    if (folder / "area.json").exists():
        _write(folder / "area.json", convert_meta(_read(folder / "area.json")))
    if (folder / "basemap.geojson").exists():
        _write(folder / "basemap.geojson", convert_basemap(_read(folder / "basemap.geojson")), compact=True)
    index = folder / "tiles" / "index.json"
    if index.exists():
        _write(index, {k: _rename_keys(v, TILE_INDEX_KEYS) for k, v in _read(index).items()}, compact=True)


def migrate_legacy_data(data: Path) -> bool:
    """Converts data/oblasti -> data/areas (and data/nastaveni.json -> data/settings.json). Returns True if it migrated."""
    data = Path(data)
    migrated = False
    old_settings, new_settings = data / "nastaveni.json", data / "settings.json"
    if old_settings.exists() and not new_settings.exists():
        try:
            s = _read(old_settings)
            _write(new_settings, _rename_keys(s, {"posledni_oblast": "last_area", "offline_rucne": "manual_offline"}))
            old_settings.unlink()
            migrated = True
        except (OSError, ValueError) as e:
            log.warning("Old settings could not be migrated: %s", e)
    old, new = data / "oblasti", data / "areas"
    if old.is_dir() and not new.exists():
        for folder in sorted(old.iterdir()):
            if folder.is_dir() and not folder.name.startswith("."):
                try:
                    _migrate_area(folder)
                except (OSError, ValueError) as e:
                    log.warning("Area %s could not be migrated: %s", folder.name, e)
        old.rename(new)
        migrated = True
        log.info("Data folder migrated to the new layout (%s).", new)
    return migrated
