"""Made-up test area "Test" (network + vector basemap, optionally tiles) – no internet needed."""

from __future__ import annotations

import io
from pathlib import Path

from container_access import tiles as tl
from container_access.areas import AreaManager, prepare
from container_access.storage import load_json, save_json

from .osm_xml import osm_xml, village, village_basemap

NAME = "Test"


def osm_file(folder: Path, extra_ways=()) -> Path:
    ways, points = village_basemap()
    p = Path(folder) / "village_test.osm"
    p.write_text(osm_xml(village() + ways + list(extra_ways), points), encoding="utf-8")
    return p


def png_tile(color=(230, 225, 215)) -> bytes:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (256, 256), color)
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, 255, 255], outline=(200, 190, 180))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def create_area(data_dir: Path, cfg: dict, name: str = NAME, tiles: bool = False) -> str:
    """Prepares an area from an .osm file. With tiles=True adds artificial stored tiles (zoom 14–16)."""
    manager = AreaManager(Path(data_dir) / "areas")
    tmp = Path(data_dir) / "_osm"
    tmp.mkdir(parents=True, exist_ok=True)
    meta = prepare(manager, cfg, name, osm_file=osm_file(tmp))
    if tiles:
        folder = manager.path(meta["slug"]) / "tiles"
        content = png_tile()
        n = 0
        for z in (14, 15, 16):
            x0, x1, y0, y1 = tl.tile_range(meta["bbox"], z)
            for x in range(x0, x1 + 1):
                for y in range(y0, y1 + 1):
                    p = tl.tile_path(folder, z, x, y)
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(content)
                    n += 1
        m = load_json(manager.path(meta["slug"]) / "area.json")
        m["tiles"] = {"downloaded": True, "count": n, "min_zoom": 14, "max_zoom": 16, "server": "test"}
        save_json(manager.path(meta["slug"]) / "area.json", m)
    return meta["slug"]
