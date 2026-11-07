"""Raster tiles: plan and gradual pre-download for offline use (only for a server that allows it),
reading stored tiles and composing a mosaic for the PNG export.

Pre-downloading is never used for tile.openstreetmap.org – its terms forbid offline use
(see config.offline_tiles_allowed).
"""

from __future__ import annotations

import json
import math
import time
from datetime import datetime
from pathlib import Path

import numpy as np

from .network import ConnectionFailed, NetworkError

R = 20037508.342789244  # half of the Earth's circumference in EPSG:3857

# Binding rule: at most 250 tiles at zoom 13 and above per area (the configuration can only lower it).
TILE_LIMIT = 250
LIMIT_FROM_ZOOM = 13


class TileError(NetworkError):
    """Error while downloading tiles – the message is meant for the user."""


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    lat = max(min(lat, 85.05112878), -85.05112878)
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def tile_range(bbox, z: int) -> tuple[int, int, int, int]:
    """(xmin, xmax, ymin, ymax) of tiles covering bbox (west, south, east, north)."""
    w, s, e, n = bbox
    x0, y0 = lonlat_to_tile(w, n, z)
    x1, y1 = lonlat_to_tile(e, s, z)
    return x0, x1, y0, y1


def count(bbox, z: int) -> int:
    x0, x1, y0, y1 = tile_range(bbox, z)
    return (x1 - x0 + 1) * (y1 - y0 + 1)


def plan(bbox, min_zoom=13, max_tiles=250, max_zoom=18, overview=(10, 11, 12)) -> dict:
    """The highest zoom at which the number of tiles from `min_zoom` up does not exceed `max_tiles`.

    Overview zooms (below 13) are not counted towards the limit – they are a few tiles. The limit of
    250 tiles from zoom 13 up always applies; the configuration can only make it stricter.
    """
    min_zoom = min(int(min_zoom), LIMIT_FROM_ZOOM)
    max_tiles = min(int(max_tiles), TILE_LIMIT)
    per_zoom, total = {}, 0
    for z in range(min_zoom, max_zoom + 1):
        c = count(bbox, z)
        if total + c > max_tiles:
            break
        per_zoom[z] = c
        total += c
    overview_counts = {z: count(bbox, z) for z in overview if z < min_zoom}
    if not per_zoom:
        return {"fits": False, "max_zoom": None, "count": 0, "per_zoom": {}, "overview": {},
                "count_at_min_zoom": count(bbox, min_zoom), "limit": max_tiles, "min_zoom": min_zoom}
    return {"fits": True, "max_zoom": max(per_zoom), "count": total, "per_zoom": per_zoom,
            "overview": overview_counts, "count_total": total + sum(overview_counts.values()), "limit": max_tiles,
            "min_zoom": min_zoom}


def tile_list(bbox, p: dict) -> list[tuple[int, int, int]]:
    zooms = sorted(list(p.get("overview", {})) + list(p.get("per_zoom", {})))
    result = []
    for z in zooms:
        x0, x1, y0, y1 = tile_range(bbox, int(z))
        result += [(int(z), x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    return result


def _index(folder: Path) -> dict:
    p = folder / "index.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def download(bbox, p: dict, folder: Path, url_template: str, user_agent: str, session=None,
             progress=None, pause: float = 0.05, previous: Path | None = None) -> dict:
    """Downloads the planned tiles one by one into `folder/{z}/{x}/{y}.png`.

    When updating, tiles downloaded before are taken from `previous` and the server is asked
    conditionally (If-None-Match / If-Modified-Since), so unchanged tiles are not downloaded again.
    """
    if not p.get("fits"):
        raise TileError("Oblast se nevejde do limitu dlaždic – dlaždice se nestahují.")
    import requests

    session = session or requests.Session()
    headers = {"User-Agent": user_agent}
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    old_index = _index(previous) if previous else {}
    index = {}
    tiles = tile_list(bbox, p)
    size = 0
    for i, (z, x, y) in enumerate(tiles, start=1):
        key = f"{z}/{x}/{y}"
        target = folder / str(z) / str(x) / f"{y}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        h = dict(headers)
        old = old_index.get(key)
        old_file = (previous / str(z) / str(x) / f"{y}.png") if previous else None
        if old and old_file and old_file.exists():
            if old.get("etag"):
                h["If-None-Match"] = old["etag"]
            if old.get("last_modified"):
                h["If-Modified-Since"] = old["last_modified"]
        url = url_from_template(url_template, z, x, y)
        try:
            r = session.get(url, headers=h, timeout=30)
        except (requests.exceptions.RequestException, OSError) as e:
            raise ConnectionFailed(f"Stahování dlaždic selhalo ({type(e).__name__}). Jsi připojený k internetu?") from e
        if r.status_code == 304 and old_file is not None:
            content = old_file.read_bytes()
            index[key] = dict(old, verified=datetime.now().isoformat(timespec="seconds"))
        elif r.status_code == 200:
            content = r.content
            index[key] = {"etag": r.headers.get("ETag"), "last_modified": r.headers.get("Last-Modified"),
                          "downloaded": datetime.now().isoformat(timespec="seconds")}
        elif r.status_code in (403, 429):
            raise TileError(f"Dlaždicový server odmítl stahování (HTTP {r.status_code}). Zkontroluj jeho podmínky.")
        else:
            raise TileError(f"Dlaždice {key} se nepodařilo stáhnout (HTTP {r.status_code}).")
        target.write_bytes(content)
        size += len(content)
        if progress:
            progress(i, len(tiles))
        if pause:
            time.sleep(pause)
    (folder / "index.json").write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    zooms = sorted({z for z, _, _ in tiles})
    return {"count": len(tiles), "size_b": size, "min_zoom": zooms[0], "max_zoom": zooms[-1],
            "downloaded_at": datetime.now().isoformat(timespec="seconds")}


def url_from_template(template: str, z: int, x: int, y: int) -> str:
    """Fills in {z}, {x}, {y} (and Leaflet {s}, {r}) – leaves other braces alone."""
    return (str(template).replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
            .replace("{s}", "a").replace("{r}", ""))


def tile_path(folder: Path, z: int, x: int, y: int) -> Path:
    return Path(folder) / str(int(z)) / str(int(x)) / f"{int(y)}.png"


def folder_size(folder: Path) -> int:
    return sum(p.stat().st_size for p in Path(folder).rglob("*.png")) if Path(folder).exists() else 0


# ---------------------------------------------------------------------------
# Mosaic for the PNG export (only from stored tiles, never by downloading)
# ---------------------------------------------------------------------------


def _range_3857(x0, y0, x1, y1, z):
    n = 2**z
    size = 2 * R / n
    tx0 = int(math.floor((x0 + R) / size))
    tx1 = int(math.floor((x1 + R) / size))
    ty0 = int(math.floor((R - y1) / size))
    ty1 = int(math.floor((R - y0) / size))
    return max(tx0, 0), min(tx1, n - 1), max(ty0, 0), min(ty1, n - 1), size


def zooms_in_folder(folder: Path) -> list[int]:
    if not Path(folder).exists():
        return []
    return sorted(int(p.name) for p in Path(folder).iterdir() if p.is_dir() and p.name.isdigit())


def mosaic(folder: Path, x0, y0, x1, y1, target_zoom: int, max_diff: int = 2):
    """Composes an image from stored tiles for an extent in EPSG:3857 (transparent where tiles are missing).

    Uses the highest zoom in [target_zoom − max_diff, target_zoom] for which at least one needed
    tile is stored – a coarser zoom would be blurry, the vector basemap is better then.
    Returns (RGBA array, (left, right, bottom, top), zoom, coverage share) or None.
    """
    from PIL import Image

    zooms = [z for z in zooms_in_folder(folder) if target_zoom - max_diff <= z <= target_zoom]
    for z in sorted(zooms, reverse=True):
        tx0, tx1, ty0, ty1, size = _range_3857(x0, y0, x1, y1, z)
        n_tiles = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
        if n_tiles > 600:
            continue
        paths = {(x, y): tile_path(folder, z, x, y) for x in range(tx0, tx1 + 1) for y in range(ty0, ty1 + 1)}
        existing = {k: p for k, p in paths.items() if p.exists()}
        if not existing:
            continue
        width, height = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
        image = Image.new("RGBA", (width, height), (255, 255, 255, 0))
        for (x, y), p in existing.items():
            with Image.open(p) as t:
                image.paste(t.convert("RGBA").resize((256, 256)), ((x - tx0) * 256, (y - ty0) * 256))
        left = -R + tx0 * size
        top = R - ty0 * size
        extent = (left, left + (tx1 - tx0 + 1) * size, top - (ty1 - ty0 + 1) * size, top)
        return np.asarray(image), extent, z, len(existing) / n_tiles
    return None


def zoom_for_resolution(width_3857: float, width_px: float) -> int:
    """Zoom at which a tile has roughly the resolution of the output."""
    z = math.log2(max(width_px, 1) * 2 * R / (256 * max(width_3857, 1)))
    return int(min(max(math.ceil(z), 0), 19))
