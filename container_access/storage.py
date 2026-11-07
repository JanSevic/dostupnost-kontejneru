"""Containers as GeoJSON: validation, auto-saving and placement variants.

Feature properties of containers stay Czech (``id``, ``typ``, ``poznamka``) – it is the
file format users edit in QGIS and see in exports.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from datetime import datetime
from pathlib import Path

from .config import SUMMARY_KEY, normalise_key

UNKNOWN_TYPE_COLORS = ["#e8590c", "#0b7285", "#5f3dc4", "#a61e4d", "#2b8a3e", "#495057"]


class DataError(ValueError):
    """Error in input data – the message is meant for the user."""


def empty_collection() -> dict:
    return {"type": "FeatureCollection", "features": []}


def _crs_transform(fc: dict):
    """Returns a function (x, y) -> (lon, lat) if the GeoJSON declares a CRS other than WGS84."""
    crs = fc.get("crs")
    if not crs:
        return None
    name = str((crs.get("properties") or {}).get("name", ""))
    if not name or re.search(r"(CRS84|EPSG:+4326)$", name):
        return None
    from pyproj import Transformer

    try:
        tr = Transformer.from_crs(name, 4326, always_xy=True)
    except Exception as e:  # noqa: BLE001
        raise DataError(f"Neznámý souřadnicový systém v souboru: {name}") from e
    return tr.transform


def normalise_containers(fc: dict, types: list[dict]) -> tuple[dict, list[str], list[dict]]:
    """Validates and unifies a collection of containers.

    Returns (collection, warnings, new_types). A type is looked up by key and by name
    (case-insensitive); unknown types are added as temporary.
    """
    if not isinstance(fc, dict) or fc.get("type") != "FeatureCollection":
        raise DataError("Soubor není GeoJSON FeatureCollection.")
    to_wgs = _crs_transform(fc)
    by_key = {t["key"]: t for t in types}
    by_name = {t["name"].strip().lower(): t for t in types}
    added: list[dict] = []
    warnings: list[str] = []
    out, skipped, used_ids = [], 0, set()
    without_id = []

    for f in fc.get("features") or []:
        g = (f or {}).get("geometry") or {}
        if g.get("type") != "Point" or not isinstance(g.get("coordinates"), (list, tuple)) or len(g["coordinates"]) < 2:
            skipped += 1
            continue
        try:
            x, y = float(g["coordinates"][0]), float(g["coordinates"][1])
        except (TypeError, ValueError):
            skipped += 1
            continue
        if to_wgs:
            x, y = to_wgs(x, y)
        if not (-180 <= x <= 180 and -90 <= y <= 90):
            raise DataError(
                "Souřadnice nejsou ve stupních WGS84 (EPSG:4326). V QGIS ulož vrstvu jako GeoJSON se systémem EPSG:4326."
            )
        props = f.get("properties") or {}
        type_text = str(props.get("typ") or props.get("type") or "").strip()
        if not type_text:
            skipped += 1
            continue
        t = by_key.get(type_text) or by_name.get(type_text.lower())
        if t is None:
            key = normalise_key(type_text)
            if key == SUMMARY_KEY:
                key = "vse_typ"
            t = by_key.get(key)
            if t is None:
                t = {
                    "key": key,
                    "name": type_text,
                    "color": UNKNOWN_TYPE_COLORS[len(added) % len(UNKNOWN_TYPE_COLORS)],
                    "abbr": type_text[:2],
                    "temporary": True,
                }
                added.append(t)
                by_key[key] = t
                by_name[type_text.lower()] = t
        cid = props.get("id")
        try:
            cid = int(cid)
        except (TypeError, ValueError):
            cid = None
        feature = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(x, 7), round(y, 7)]},
            "properties": {"id": cid, "typ": t["key"], "poznamka": str(props.get("poznamka") or "")},
        }
        if cid is None or cid in used_ids:
            without_id.append(feature)
        else:
            used_ids.add(cid)
        out.append(feature)

    next_id = max(used_ids, default=0) + 1
    for feature in without_id:
        feature["properties"]["id"] = next_id
        next_id += 1
    if without_id:
        warnings.append(f"{len(without_id)} kontejner(ů) nemělo platné nebo jedinečné id – bylo přiděleno nové.")
    if skipped:
        warnings.append(f"{skipped} prvek(ů) nebyl bod s vyplněným typem – vynecháno.")
    for t in added:
        warnings.append(
            f"Typ „{t['name']}“ není v config.json – přidán dočasně. Pro trvalé použití ho dopiš do konfigurace."
        )
    return {"type": "FeatureCollection", "features": out}, warnings, added


def save_json(path: Path, data: dict):
    """Atomic write (first to a temporary file, then rename)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        for attempt in range(10):
            try:
                os.replace(tmp, path)
                break
            except PermissionError as e:
                # Windows: an antivirus, OneDrive or QGIS may hold the file briefly
                if attempt == 9:
                    raise DataError(
                        f"Soubor {path.name} nejde zapsat – nemá ho otevřený jiný program (např. QGIS)?"
                    ) from e
                time.sleep(0.2)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_json(path: Path) -> dict:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except UnicodeDecodeError as e:
        raise DataError(f"Soubor {Path(path).name} není v kódování UTF-8.") from e
    except json.JSONDecodeError as e:
        raise DataError(f"Soubor {Path(path).name} není platný JSON: {e}") from e


_FORBIDDEN = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')

_RESERVED = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(10)} | {f"lpt{i}" for i in range(10)}


def safe_name(name: str) -> str:
    n = _FORBIDDEN.sub("_", str(name)).strip(" .")
    if not n:
        raise DataError("Zadej název varianty.")
    if n.split(".")[0].lower() in _RESERVED:  # Windows device names
        n = "_" + n
    return n[:80]


class Variants:
    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)

    def path(self, name: str) -> Path:
        return self.folder / f"{safe_name(name)}.geojson"

    def list(self) -> list[dict]:
        result = []
        for p in sorted(self.folder.glob("*.geojson"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                count = len(load_json(p).get("features") or [])
            except (DataError, OSError):
                count = None
            result.append({
                "name": p.stem,
                "changed": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="minutes"),
                "count": count,
            })
        return result

    def save(self, name: str, fc: dict) -> str:
        p = self.path(name)
        save_json(p, fc)
        return p.stem

    def load(self, name: str) -> dict:
        p = self.path(name)
        if not p.exists():
            raise DataError(f"Varianta „{name}“ neexistuje.")
        return load_json(p)
