"""FastAPI server: REST API for the map app (areas, offline mode, computation, exports)."""

from __future__ import annotations

import json
import logging
import math
import shutil
import tempfile
import threading
import traceback
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlparse

import numpy as np
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import exports
from . import tiles as tl
from .areas import AreaError, AreaManager, prepare
from .compute import check_straight_line, compute_type, summary
from .config import SUMMARY_KEY, Paths, load_config, offline_tiles_allowed, user_agent
from .connectivity import Connectivity
from .migration import migrate_legacy_data
from .network import ConnectionFailed, NetworkError, WalkingNetwork, bbox_area_km2, expand_bbox, process_osm_graph
from .storage import DataError, Variants, empty_collection, load_json, normalise_containers, save_json

log = logging.getLogger("container_access")


class AppState:
    """State of the application (one local user)."""

    def __init__(self, paths: Paths, cfg: dict, forced_offline: bool = False):
        self.paths = paths
        self.cfg = cfg
        self.lock = threading.RLock()
        self.areas = AreaManager(paths.areas)
        self.settings = self._load_settings()
        self.connectivity = Connectivity(cfg["connectivity_check_url"], user_agent(cfg), forced_offline,
                                         bool(self.settings.get("manual_offline")))
        self.types: list[dict] = [dict(t) for t in cfg["types"]]
        self.slug: str | None = None
        self.meta: dict | None = None
        self.net: WalkingNetwork | None = None
        self.net_version = 0
        self.containers = empty_collection()
        self.variants: Variants | None = None
        self.task: dict = {"running": False}
        self._thread: threading.Thread | None = None

    # --- settings ------------------------------------------------------------

    def _load_settings(self) -> dict:
        try:
            return load_json(self.paths.settings) if self.paths.settings.exists() else {}
        except (DataError, OSError):
            return {}

    def save_settings(self, **changes):
        self.settings.update(changes)
        try:
            save_json(self.paths.settings, self.settings)
        except (DataError, OSError) as e:
            log.warning("Settings cannot be saved: %s", e)

    # --- area ----------------------------------------------------------------

    def folder(self) -> Path:
        if self.slug is None:
            raise HTTPException(409, "Není otevřená žádná oblast – vyber nebo připrav oblast.")
        return self.areas.path(self.slug)

    def open(self, slug: str):
        meta = self.areas.meta(slug)
        folder = self.areas.path(slug)
        import osmnx as ox

        try:
            G = ox.load_graphml(folder / "network.graphml")
        except Exception as e:  # noqa: BLE001
            raise AreaError(f"Síť oblasti „{meta.get('name')}“ nejde načíst ({e}). Zkus Aktualizovat data.") from e
        net = process_osm_graph(G, bbox=tuple(meta["bbox"]), segment_length=float(self.cfg["segment_length_m"]),
                                info={"downloaded": meta.get("downloaded"), "source": meta.get("source")})
        types = [dict(t) for t in self.cfg["types"]]
        fc = empty_collection()
        p = folder / "containers.geojson"
        if p.exists():
            try:
                fc, _, added = normalise_containers(load_json(p), types)
                types.extend(added)
            except (DataError, OSError) as e:
                log.warning("Containers of the area cannot be loaded: %s", e)
                p.replace(p.with_suffix(".damaged.geojson"))
        with self.lock:
            self.slug, self.meta, self.net = slug, dict(meta, slug=slug), net
            self.net_version += 1
            self.types, self.containers = types, fc
            self.variants = Variants(folder / "variants")
        self.save_settings(last_area=slug)

    def area_info(self) -> dict | None:
        if self.meta is None:
            return None
        m = dict(self.meta)
        folder = self.areas.path(self.slug)
        m["tiles_stored"] = (folder / "tiles").exists()
        m["tiles_html_bytes"] = exports.tiles_size_estimate(folder / "tiles") if m["tiles_stored"] else 0
        m["tiles_max_zoom"] = max(tl.zooms_in_folder(folder / "tiles"), default=None)
        return m

    def status(self) -> dict:
        with self.lock:
            return {
                "connectivity": self.connectivity.status(),
                "area": self.area_info(),
                "network": {
                    "version": self.net_version,
                    "length_km": round(self.net.length_km, 2) if self.net else None,
                    "segment_count": self.net.segment_count if self.net else None,
                },
                "task": dict(self.task),
            }

    # --- background tasks (preparing / updating an area) ----------------------

    def task_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start_task(self, description: str, fn, needs_internet: bool = True):
        if needs_internet:
            st = self.connectivity.check()
            if not st["can_download"]:
                raise HTTPException(409, st["text"] + " Příprava a aktualizace oblasti potřebují internet.")

        def progress(phase, message, done=None, total=None):
            with self.lock:
                self.task.update(phase=phase, message=message, done=done, total=total)

        def run():
            try:
                meta = fn(progress)
                if needs_internet:
                    self.connectivity.record(True)
                # An updated open area is reloaded. A new area is opened by the browser
                # (it first saves pending changes into the original one).
                if meta["slug"] == self.slug:
                    progress("opening", "Načítám aktualizovaná data…")
                    self.open(meta["slug"])
                with self.lock:
                    self.task.update(running=False, phase="done", message=f"Oblast „{meta['name']}“ je připravená.",
                                     slug=meta["slug"])
            except (NetworkError, AreaError, DataError) as e:
                if isinstance(e, ConnectionFailed):
                    self.connectivity.record(False)
                with self.lock:
                    self.task.update(running=False, phase="error", error=str(e), message=str(e))
            except Exception as e:  # noqa: BLE001
                log.error("Error while preparing an area:\n%s", traceback.format_exc())
                with self.lock:
                    self.task.update(running=False, phase="error", error=f"Neočekávaná chyba: {e}",
                                     message=f"Neočekávaná chyba: {e}")

        with self.lock:  # check and start under the lock – two tasks never run at the same time
            if self.task_running():
                raise HTTPException(409, "Už běží jiná příprava oblasti – počkej na dokončení.")
            self.task = {"running": True, "description": description, "phase": "start", "message": description,
                         "done": None, "total": None, "error": None, "slug": None}
            self._thread = threading.Thread(target=run, daemon=True)
            self._thread.start()

    def adopt_pre_areas_data(self, slug: str):
        """Containers and variants from a much older version of the app (before areas existed) go to the first new area.

        The file names are those the old version used (autosave.geojson, varianty/).
        """
        old = self.paths.data / "autosave.geojson"
        target = self.areas.path(slug)
        if old.exists() and not (target / "containers.geojson").exists():
            shutil.copy2(old, target / "containers.geojson")
            old.rename(old.with_name("autosave.prevedeno.geojson"))
        old_variants = self.paths.data / "varianty"
        if old_variants.exists() and any(old_variants.glob("*.geojson")):
            (target / "variants").mkdir(exist_ok=True)
            for v in old_variants.glob("*.geojson"):
                if not (target / "variants" / v.name).exists():
                    shutil.copy2(v, target / "variants" / v.name)
            old_variants.rename(old_variants.with_name("varianty.prevedeno"))

    # --- containers ----------------------------------------------------------

    def set_containers(self, fc: dict) -> list[str]:
        folder = self.folder()
        fc, warnings, added = normalise_containers(fc, self.types)
        with self.lock:
            self.types.extend(added)
            self.containers = fc
            save_json(folder / "containers.geojson", fc)
        return warnings

    # --- computation ---------------------------------------------------------

    def compute(self, keys: list[str] | None, with_summary: bool) -> dict:
        with self.lock:
            net, version, fc, types = self.net, self.net_version, self.containers, list(self.types)
        if net is None:
            raise HTTPException(409, "Není otevřená žádná oblast – vyber nebo připrav oblast.")
        by_type: dict[str, list] = {}
        for f in fc["features"]:
            by_type.setdefault(f["properties"]["typ"], []).append(f)
        names = {t["key"]: t["name"] for t in types}
        warnings = []
        if keys is None:
            keys = [t["key"] for t in types]
            empty = [names[k] for k in keys if not by_type.get(k)]
            if empty:
                warnings.append("Bez kontejnerů (nepočítáno): " + ", ".join(empty) + ".")
            keys = [k for k in keys if by_type.get(k)]
            if not keys:
                raise HTTPException(400, "Zatím není zadaný žádný kontejner.")
        else:
            for k in keys:
                if k not in names:
                    raise HTTPException(400, f"Neznámý typ odpadu „{k}“.")
                if not by_type.get(k):
                    raise HTTPException(400, f"Typ „{names[k]}“ nemá žádný kontejner – nejdřív nějaký přidej.")
        tr = net.from_wgs()
        results, checks, snaps = {}, {}, {}
        warning_m = float(self.cfg["connection_warning_m"])
        for k in keys:
            feats = by_type[k]
            ll = np.array([f["geometry"]["coordinates"][:2] for f in feats], dtype=float)
            x, y = tr.transform(ll[:, 0], ll[:, 1])
            points = np.column_stack([x, y])
            ids = [f["properties"]["id"] for f in feats]
            r = compute_type(net, k, points, ids, warning_m=warning_m, name=names[k])
            results[k] = r
            warnings.extend(r.warnings)
            valid = np.array([p.edge is not None for p in r.snaps])
            checks[k] = check_straight_line(net, r.d_segments, points[valid])
            if not checks[k]["ok"]:
                log.error("Straight-line check failed for %s: %s", k, checks[k])
            for p in r.snaps:
                snaps[p.id] = p.as_dict(warning_m)
            if not np.isfinite(r.d_segments).any():
                warnings.append(f"{names[k]}: žádný kontejner není připojen k síti.")
        summary_d, summary_types = None, []
        if with_summary and results:
            summary_types = list(results)
            summary_d = summary(list(results.values()), net.segment_count)
        return {
            "net": net, "fc": fc, "types": types,
            "results": {k: r.d_segments for k, r in results.items()},
            "summary": summary_d, "summary_types": summary_types, "snaps": snaps,
            "warnings": warnings, "checks": checks, "network_version": version,
        }


def _check_area(state: AppState, request: Request):
    """The browser sends which area the request is for (X-Area). If another one was opened meanwhile, refuse."""
    wanted = request.headers.get("x-area")
    if wanted and wanted != state.slug:
        raise HTTPException(409, "Mezitím se otevřela jiná oblast – změna se neuložila. Obnov stránku (F5).")


def _d_json(d) -> list:
    return [None if not math.isfinite(x) else round(float(x), 1) for x in d]


def _render_settings(cfg: dict, data: dict) -> dict:
    bands = data.get("bands") or cfg["bands_m"]
    try:
        bands = sorted(float(x) for x in bands)
    except (TypeError, ValueError):
        raise HTTPException(400, "Hranice pásem musí být čísla.") from None
    if len(bands) != len(cfg["bands_m"]) or any(b <= 0 for b in bands):
        raise HTTPException(400, "Neplatné hranice pásem.")
    return {
        "mode": "continuous" if data.get("mode") == "continuous" else "bands",
        "bands": bands,
        "band_colors": cfg["band_colors"],
        "unreachable_color": cfg["unreachable_color"],
        "continuous_max_m": float(data.get("continuous_max_m") or cfg["continuous_max_m"]),
    }


def _extent(data: dict):
    try:
        return [float(data[k]) for k in ("west", "south", "east", "north")]
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "Chybí výřez mapy.") from None


def create_app(data_dir: Path | None = None, cfg: dict | None = None, forced_offline: bool = False) -> FastAPI:
    from .config import ROOT

    paths = Paths(Path(data_dir) if data_dir else ROOT / "data")
    migrate_legacy_data(paths.data)
    paths.create()
    cfg = cfg or load_config()
    from . import network as network_module

    network_module.USER_AGENT = user_agent(cfg)
    state = AppState(paths, cfg, forced_offline=forced_offline)
    app = FastAPI(title="Dostupnost kontejnerů", docs_url=None, redoc_url=None)
    app.state.app_state = state

    allowed_hosts = {"127.0.0.1", "localhost", "testserver"}

    @app.middleware("http")
    async def local_requests_only(request: Request, call_next):
        # The server listens on 127.0.0.1 only, but a foreign website open in the browser could
        # send requests to localhost – refuse them.
        host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
        if host not in allowed_hosts:
            return JSONResponse({"detail": "Nepovolený host."}, status_code=403)
        if request.headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse({"detail": "Požadavek z cizího webu odmítnut."}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != "null" and (urlparse(origin).hostname or "") not in allowed_hosts:
            return JSONResponse({"detail": "Požadavek z cizího webu odmítnut."}, status_code=403)
        return await call_next(request)

    @app.exception_handler(DataError)
    async def _data_error(request: Request, exc: DataError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(AreaError)
    async def _area_error(request: Request, exc: AreaError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.get("/api/config")
    def config():
        c = {k: v for k, v in cfg.items() if k not in ("types", "contact")}
        c["types"] = state.types
        c["summary_key"] = SUMMARY_KEY
        allowed, reason = offline_tiles_allowed(cfg)
        c["offline_tiles"] = {"allowed": allowed, "reason": reason}
        return c

    # --- status and connectivity ----------------------------------------------

    @app.get("/api/status")
    def app_status():
        return state.status()

    @app.post("/api/connectivity")
    def set_connectivity(data: dict = Body(...)):
        if state.connectivity.forced:
            raise HTTPException(409, "Aplikace běží s přepínačem --offline – online režim nejde zapnout.")
        offline = bool(data.get("offline"))
        state.connectivity.manual = offline
        state.save_settings(manual_offline=offline)
        if not offline:
            state.connectivity.check(force=True)
        return state.connectivity.status()

    @app.post("/api/connectivity/check")
    def check_connectivity():
        return state.connectivity.check(force=True)

    # --- areas -----------------------------------------------------------------

    @app.get("/api/areas")
    def areas():
        return {"areas": state.areas.list(), "last": state.settings.get("last_area"), "open": state.slug}

    @app.post("/api/areas/open")
    def open_area(data: dict = Body(...)):
        if state.task_running():
            raise HTTPException(409, "Právě se připravuje oblast – počkej na dokončení.")
        state.open(str(data.get("slug") or ""))
        return state.status()

    @app.post("/api/areas/estimate")
    def estimate(data: dict = Body(...)):
        extent = _extent(data)
        bbox = expand_bbox(*extent, float(cfg["network_margin_m"]))
        area = bbox_area_km2(bbox)
        allowed, reason = offline_tiles_allowed(cfg)
        t = cfg["tiles"]
        result = {"area_km2": round(area, 2), "limit_km2": cfg["max_area_km2"],
                  "too_large": area > float(cfg["max_area_km2"]),
                  "tiles": {"allowed": allowed, "reason": reason}}
        if allowed:
            result["tiles"]["plan"] = tl.plan(bbox, int(t["offline_min_zoom"]), int(t["offline_max_tiles"]),
                                              int(t["offline_max_zoom"]), tuple(t["offline_overview_zooms"]))
        return result

    @app.post("/api/areas/prepare")
    def prepare_area(data: dict = Body(...)):
        if data.get("default"):
            default = cfg["default_area"]
            name, extent = default["name"], list(default["extent"])
        else:
            name, extent = str(data.get("name") or "").strip(), _extent(data)
        if not name:
            raise HTTPException(400, "Zadej název oblasti.")

        def task(progress):
            meta = prepare(state.areas, cfg, name, extent=extent, progress=progress)
            state.adopt_pre_areas_data(meta["slug"])
            return meta

        state.start_task(f"Příprava oblasti „{name}“", task)
        return state.status()

    @app.post("/api/areas/update")
    def update_area():
        slug = state.slug
        if slug is None:
            raise HTTPException(409, "Není otevřená žádná oblast.")
        meta = state.areas.meta(slug)

        def task(progress):
            return prepare(state.areas, cfg, meta["name"], extent=meta["extent"], slug=slug, progress=progress)

        state.start_task(f"Aktualizace oblasti „{meta['name']}“", task)
        return state.status()

    @app.post("/api/areas/osm")
    async def area_from_osm(request: Request, name: str = ""):
        ctype = request.headers.get("content-type", "")
        if ctype.startswith(("text/plain", "application/x-www-form-urlencoded", "multipart/form-data")):
            raise HTTPException(415, "Soubor .osm posílej jako application/octet-stream.")
        content = await request.body()
        if not content:
            raise HTTPException(400, "Soubor je prázdný.")
        name = name.strip() or "Oblast ze souboru .osm"

        def task(progress):
            with tempfile.NamedTemporaryFile(suffix=".osm", delete=False) as f:
                f.write(content)
                file = Path(f.name)
            try:
                meta = prepare(state.areas, cfg, name, osm_file=file, progress=progress)
            finally:
                file.unlink(missing_ok=True)
            state.adopt_pre_areas_data(meta["slug"])
            return meta

        state.start_task(f"Oblast ze souboru .osm „{name}“", task, needs_internet=False)
        return state.status()

    @app.get("/api/task")
    def task_status():
        return dict(state.task)

    # --- area data -------------------------------------------------------------

    @app.get("/api/basemap")
    def basemap():
        p = state.folder() / "basemap.geojson"
        if not p.exists():
            return {"type": "FeatureCollection", "features": []}
        return FileResponse(p, media_type="application/geo+json")

    @app.get("/tiles/{z}/{x}/{y}.png")
    def stored_tile(z: int, x: int, y: int):
        if state.slug is None:
            return Response(status_code=404)
        p = tl.tile_path(state.areas.path(state.slug) / "tiles", z, x, y)
        if not p.exists():
            return Response(status_code=404)
        return FileResponse(p, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})

    @app.get("/api/network/segments")
    def network_segments():
        with state.lock:
            net, version = state.net, state.net_version
        if net is None:
            raise HTTPException(409, "Není otevřená žádná oblast.")
        return {
            "version": version,
            "segments": net.segments_wgs(),
            "lengths": [round(float(x), 2) for x in net.segment_length],
            "area": net.area_wgs(),
        }

    # --- containers ------------------------------------------------------------

    @app.get("/api/containers")
    def containers():
        state.folder()
        return state.containers

    @app.put("/api/containers")
    def save_containers(request: Request, fc: dict = Body(...)):
        _check_area(state, request)
        warnings = state.set_containers(fc)
        return {"ok": True, "warnings": warnings, "count": len(state.containers["features"])}

    @app.post("/api/containers/import")
    def import_containers(request: Request, fc: dict = Body(...)):
        _check_area(state, request)
        warnings = state.set_containers(fc)
        return {"containers": state.containers, "warnings": warnings, "types": state.types}

    # --- variants --------------------------------------------------------------

    def _variants() -> Variants:
        state.folder()
        return state.variants

    @app.get("/api/variants")
    def variants():
        return _variants().list()

    @app.post("/api/variants")
    def save_variant(request: Request, data: dict = Body(...)):
        _check_area(state, request)
        v = _variants()
        if data.get("containers"):
            state.set_containers(data["containers"])
        return {"name": v.save(str(data.get("name") or ""), state.containers)}

    @app.post("/api/variants/load")
    def load_variant(request: Request, data: dict = Body(...)):
        _check_area(state, request)
        fc = _variants().load(str(data.get("name") or ""))
        warnings = state.set_containers(fc)
        return {"containers": state.containers, "warnings": warnings, "types": state.types}

    # --- computation -------------------------------------------------------------

    def _apply(data: dict):
        if data.get("containers"):
            state.set_containers(data["containers"])

    @app.post("/api/compute")
    def compute(request: Request, data: dict = Body(...)):
        _check_area(state, request)
        _apply(data)
        types = data.get("types")
        everything = types is None or types == "all"
        r = state.compute(None if everything else list(types), with_summary=everything)
        return {
            "network_version": r["network_version"],
            "results": {k: _d_json(d) for k, d in r["results"].items()},
            "summary": _d_json(r["summary"]) if r["summary"] is not None else None,
            "summary_types": r["summary_types"],
            "snaps": {str(k): v for k, v in r["snaps"].items()},
            "warnings": r["warnings"],
            "checks": r["checks"],
        }

    # --- exports -------------------------------------------------------------------

    def _output_file(name: str, extension: str, suffix: str = "") -> Path:
        stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        safe = "".join(ch if ch.isalnum() or ch == "-" else "_" for ch in name)
        safe = "_".join(c for c in safe.split("_") if c)[:40].strip("_") or "mapa"
        if suffix:
            safe += "_" + suffix
        folder = state.folder() / "outputs"
        folder.mkdir(exist_ok=True)
        return folder / f"{stamp}_{safe}.{extension}"

    def _file_response(path: Path, media: str, warnings: list[str]):
        r = FileResponse(path, media_type=media, filename=path.name)
        if warnings:
            r.headers["X-Warnings"] = quote(" | ".join(warnings))
        return r

    def _basemap_fc() -> dict:
        p = state.folder() / "basemap.geojson"
        try:
            return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {"features": []}
        except (OSError, json.JSONDecodeError):
            return {"features": []}

    def _tiles_folder() -> Path | None:
        p = state.folder() / "tiles"
        return p if p.exists() else None

    def _attribution() -> str:
        return (state.meta or {}).get("attribution") or exports.ATTRIBUTION

    def _tiles_attribution() -> str:
        return str(cfg["tiles"].get("attribution") or "")

    @app.post("/api/export/gpkg")
    def export_gpkg(request: Request, data: dict = Body(...)):
        _check_area(state, request)
        _apply(data)
        s = _render_settings(cfg, data)
        r = state.compute(None, with_summary=True)
        path = _output_file((state.meta or {}).get("name") or "dostupnost", "gpkg")
        exports.export_gpkg(path, r["net"], r["fc"], r["types"], r["results"], r["summary"], s["bands"], r["snaps"])
        return _file_response(path, "application/geopackage+sqlite3", r["warnings"])

    @app.post("/api/export/html")
    def export_html(request: Request, data: dict = Body(...)):
        _check_area(state, request)
        _apply(data)
        s = _render_settings(cfg, data)
        r = state.compute(None, with_summary=True)
        title = str(data.get("title") or "Pěší dostupnost kontejnerů")
        path = _output_file(title, "html")
        embed = bool(data.get("embed_tiles")) and _tiles_folder() is not None
        attribution = _attribution()
        if embed and _tiles_attribution() and _tiles_attribution() not in attribution:
            attribution += f"; dlaždice {_tiles_attribution()}"
        exports.export_html(path, r["net"], r["fc"], r["types"], r["results"], r["summary"], s, title,
                            data.get("layer"), paths.static, extent=data.get("extent"), basemap_fc=_basemap_fc(),
                            tiles_folder=_tiles_folder(), embed_tiles=embed, attribution=attribution)
        return _file_response(path, "text/html", r["warnings"])

    @app.post("/api/export/png")
    def export_png(request: Request, data: dict = Body(...)):
        _check_area(state, request)
        _apply(data)
        s = _render_settings(cfg, data)
        r = state.compute(None, with_summary=True)
        title = str(data.get("title") or "Pěší dostupnost kontejnerů")
        basemap_mode = data.get("basemap") if data.get("basemap") in ("auto", "tiles", "vector", "none") else "auto"
        layers = list(r["results"]) + ([SUMMARY_KEY] if r["summary"] is not None else [])
        if data.get("all"):
            selected = layers
        else:
            layer = data.get("layer")
            if layer not in layers:
                raise HTTPException(400, "Zvolená vrstva nemá výsledek (typ bez kontejnerů?).")
            selected = [layer]
        warnings = list(r["warnings"])
        basemap_fc = _basemap_fc()
        files = []
        for k in selected:
            d = r["summary"] if k == SUMMARY_KEY else r["results"][k]
            path = _output_file(title, "png", suffix=k)
            w = exports.export_png(path, r["net"], r["fc"], r["types"], d, k, s, title, extent=data.get("extent"),
                                   basemap=basemap_mode, basemap_fc=basemap_fc, tiles_folder=_tiles_folder(),
                                   attribution=_attribution(), tiles_attribution=_tiles_attribution())
            for x in w:
                if x not in warnings:
                    warnings.append(x)
            files.append(path)
        if len(files) == 1:
            return _file_response(files[0], "image/png", warnings)
        zip_path = _output_file(title, "zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for f in files:
                z.write(f, f.name)
        return _file_response(zip_path, "application/zip", warnings)

    # --- static files ------------------------------------------------------------

    @app.get("/")
    def index():
        return FileResponse(paths.static / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/", StaticFiles(directory=paths.static), name="static")
    return app
