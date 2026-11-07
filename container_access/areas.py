"""Areas: offline packages (network, vector basemap, optionally tiles, metadata) and a workspace
(containers, variants, outputs) for each territory separately.

Area folder layout::

    data/areas/<slug>/
        area.json            metadata (name, extent, download date, source, attribution, ...)
        network.graphml      walking network (osmnx)
        basemap.geojson      vector basemap
        tiles/               stored tiles (only if the server allows it)
        containers.geojson   continuously saved placement
        variants/            saved variants
        outputs/             exports
"""

from __future__ import annotations

import json
import re
import shutil
import time
from datetime import datetime
from pathlib import Path

from . import tiles as tl
from .basemap import basemap_from_xml
from .config import OSM_ATTRIBUTION, normalise_key, offline_tiles_allowed, user_agent
from .network import NetworkError, bbox_area_km2, expand_bbox, graph_bbox, load_osm_xml, process_osm_graph
from .overpass import download_osm
from .storage import load_json, save_json

PACKAGE_VERSION = 1
COMPONENTS = ("network.graphml", "basemap.geojson", "tiles", "area.json")


class AreaError(RuntimeError):
    """Error meant for the user."""


class AreaManager:
    def __init__(self, folder: Path):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)

    def path(self, slug: str) -> Path:
        # only lower-case letters, digits and _ (no paths, drives or dots – on Windows too)
        if not isinstance(slug, str) or not re.fullmatch(r"[a-z0-9_]{1,60}", slug):
            raise AreaError("Neplatný identifikátor oblasti.")
        return self.folder / slug

    def exists(self, slug: str) -> bool:
        try:
            return (self.path(slug) / "area.json").exists()
        except AreaError:
            return False

    def meta(self, slug: str) -> dict:
        p = self.path(slug) / "area.json"
        if not p.exists():
            raise AreaError(f"Oblast „{slug}“ neexistuje.")
        return load_json(p)

    def list(self) -> list[dict]:
        result = []
        for d in sorted(self.folder.iterdir()) if self.folder.exists() else []:
            if d.name.startswith(".") or not (d / "area.json").exists():
                continue
            try:
                m = load_json(d / "area.json")
            except Exception:  # noqa: BLE001 – a damaged area is just skipped
                continue
            n = 0
            if (d / "containers.geojson").exists():
                try:
                    n = len(load_json(d / "containers.geojson").get("features") or [])
                except Exception:  # noqa: BLE001
                    pass
            m["container_count"] = n
            m["variant_count"] = len(list((d / "variants").glob("*.geojson"))) if (d / "variants").exists() else 0
            result.append(m)
        return result

    def new_slug(self, name: str) -> str:
        base = normalise_key(name)[:40].strip("_") or "oblast"
        slug, i = base, 2
        while (self.folder / slug).exists():
            slug = f"{base}_{i}"
            i += 1
        return slug


# ---------------------------------------------------------------------------
# Preparing and updating a package
# ---------------------------------------------------------------------------


def _with_retry(fn, *args, attempts: int = 10):
    """Windows: an antivirus, OneDrive or another program may hold a file briefly – try again."""
    for i in range(attempts):
        try:
            return fn(*args)
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.3)


def _swap_components(target: Path, tmp: Path):
    """Replaces the area components with new ones from `tmp`. On failure restores the original state (backup)."""
    backup = target.parent / f".backup_{target.name}_{int(time.time() * 1000)}"
    backup.mkdir()
    moved_old, moved_new = [], []
    try:
        for name in COMPONENTS:
            new = tmp / name
            if not new.exists():
                continue  # the component does not change (e.g. tiles kept from last time)
            old = target / name
            if old.exists():
                _with_retry(shutil.move, str(old), str(backup / name))
                moved_old.append(name)
            _with_retry(shutil.move, str(new), str(old))
            moved_new.append(name)
    except BaseException:
        # back to the original state
        for name in moved_new:
            p = target / name
            shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        for name in moved_old:
            shutil.move(str(backup / name), str(target / name))
        shutil.rmtree(backup, ignore_errors=True)
        raise
    shutil.rmtree(backup, ignore_errors=True)


def _save_basemap(path: Path, fc: dict):
    path.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def prepare(manager: AreaManager, cfg: dict, name: str, extent=None, slug: str | None = None,
            osm_file: Path | None = None, progress=None, session=None) -> dict:
    """Downloads (or reads from an .osm file) all components of an area and saves them.

    - new area: ``slug`` is None, a new folder is created,
    - update: ``slug`` of an existing area; containers, variants and outputs stay.

    Everything is first downloaded into a temporary folder – on failure the old data stay unchanged.
    """
    progress = progress or (lambda *a, **k: None)
    name = str(name or "").strip()
    if not name:
        raise AreaError("Zadej název oblasti.")
    margin = float(cfg["network_margin_m"])
    updating = slug is not None
    old_meta = manager.meta(slug) if updating else None

    tmp = manager.folder / f".prepare_{int(time.time() * 1000)}"
    tmp.mkdir(parents=True)
    try:
        # --- 1) walking network
        if osm_file is not None:
            progress("network", "Načítám pěší síť ze souboru .osm…")
            G = load_osm_xml(osm_file)
            bbox = list(graph_bbox(G, margin_m=50))
            extent = bbox
            source = f"soubor .osm ({Path(osm_file).name})"
        else:
            if extent is None:
                raise AreaError("Chybí výřez oblasti.")
            extent = [float(x) for x in extent]
            bbox = list(expand_bbox(*extent, margin))
            area = bbox_area_km2(bbox)
            if area > float(cfg["max_area_km2"]):
                raise AreaError(
                    f"Oblast je příliš velká ({area:.0f} km² i s okrajem, limit {cfg['max_area_km2']} km²). "
                    "Přibliž mapu, nebo zvyš max_area_km2 v config.json."
                )
            # one Overpass query for both the network and the basemap; processing is local
            progress("network", "Stahuji data z OpenStreetMap…")
            downloaded_osm = tmp / "downloaded.osm"
            dl = download_osm(tuple(bbox), downloaded_osm, cfg, user_agent(cfg), progress=progress)
            progress("network", f"Staženo za {dl['seconds']:.0f} s, zpracovávám pěší síť…")
            G = load_osm_xml(downloaded_osm, downloaded=True)
            source = "OpenStreetMap (Overpass API)"
        import osmnx as ox

        ox.save_graphml(G, tmp / "network.graphml")
        net = process_osm_graph(G, bbox=tuple(bbox), segment_length=float(cfg["segment_length_m"]))

        # --- 2) vector basemap
        if osm_file is not None:
            progress("basemap", "Načítám vektorový podklad ze souboru .osm…")
            basemap = basemap_from_xml(osm_file, bbox)
        else:
            progress("basemap", "Zpracovávám vektorový podklad (budovy, cesty, voda, zeleň…)…")
            basemap = basemap_from_xml(downloaded_osm, bbox)
            downloaded_osm.unlink(missing_ok=True)
        _save_basemap(tmp / "basemap.geojson", basemap)

        # --- 3) tiles (only if the server allows it)
        tiles_info = {"downloaded": False}
        allowed, reason = offline_tiles_allowed(cfg)
        t = cfg["tiles"]
        if osm_file is not None:
            tiles_info["reason"] = "Oblast ze souboru .osm – dlaždice se nestahují."
        elif not allowed:
            tiles_info["reason"] = reason
        else:
            p = tl.plan(bbox, min_zoom=int(t["offline_min_zoom"]), max_tiles=int(t["offline_max_tiles"]),
                        max_zoom=int(t["offline_max_zoom"]), overview=tuple(t["offline_overview_zooms"]))
            if not p["fits"]:
                tiles_info["reason"] = (
                    f"Oblast se nevejde do limitu {p['limit']} dlaždic ani na zoomu {p['min_zoom']} "
                    f"({p['count_at_min_zoom']} dlaždic) – dlaždice se nestáhly, použije se vektorový podklad."
                )
            else:
                old = manager.path(slug) / "tiles" if updating else None
                total = p["count_total"]
                progress("tiles", f"Stahuji dlaždice 0/{total} (postupně, do zoomu {p['max_zoom']})…", 0, total)
                try:
                    res = tl.download(
                        bbox, p, tmp / "tiles", t["url"], user_agent(cfg), session=session,
                        progress=lambda i, n: progress("tiles", f"Stahuji dlaždice {i}/{n}…", i, n),
                        previous=old if old and old.exists() else None,
                    )
                    tiles_info = dict(res, downloaded=True, server=t["url"], plan=p["per_zoom"])
                except NetworkError as e:
                    # tiles are optional – the network and basemap are saved anyway
                    shutil.rmtree(tmp / "tiles", ignore_errors=True)
                    if old and old.exists():
                        tiles_info = dict((old_meta or {}).get("tiles") or {}, downloaded=True)
                        tiles_info["reason"] = f"Dlaždice se nepodařilo aktualizovat ({e}) – ponechány předchozí."
                    else:
                        tiles_info = {"downloaded": False, "reason": f"Dlaždice se nepodařilo stáhnout: {e}"}

        # --- 4) metadata
        now = datetime.now().isoformat(timespec="seconds")
        meta = {
            "version": PACKAGE_VERSION,
            "name": name,
            "extent": [round(x, 7) for x in extent],
            "bbox": [round(x, 7) for x in bbox],
            "margin_m": margin if osm_file is None else 50,
            "area_km2": round(bbox_area_km2(bbox), 2),
            "downloaded": now,
            "created": (old_meta or {}).get("created", now),
            "source": source,
            "attribution": f"{OSM_ATTRIBUTION} (data ODbL)",
            "network": {"length_km": round(net.length_km, 2), "segment_count": net.segment_count, "crs": net.crs.to_string()},
            "basemap": basemap.get("summary", {}),
            "tiles": tiles_info,
        }
        save_json(tmp / "area.json", meta)

        # --- 5) move into place
        progress("saving", "Ukládám oblast…")
        meta["slug"] = slug
        if updating:
            target = manager.path(slug)
            save_json(tmp / "area.json", meta)
            _swap_components(target, tmp)
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            slug = manager.new_slug(name)
            meta["slug"] = slug
            save_json(tmp / "area.json", meta)
            target = manager.path(slug)
            _with_retry(tmp.rename, target)
        return meta
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


__all__ = ["AreaManager", "AreaError", "NetworkError", "prepare"]
