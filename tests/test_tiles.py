"""Tiles: plan within the limit, sequential download with User-Agent, conditional update, mosaic."""

import shutil
import threading

import pytest

from container_access import tiles as tl
from container_access.config import load_config, offline_tiles_allowed, user_agent
from container_access.network import ConnectionFailed, expand_bbox

from .sample_area import png_tile

LAT, LON = 50.2736, 14.3975


def square_km(km):
    return expand_bbox(LON, LAT, LON, LAT, km * 500)


def test_plan_2x2_km_gives_zoom_17():
    p = tl.plan(square_km(2.0), min_zoom=13, max_tiles=250, max_zoom=18)
    assert p["fits"] and p["max_zoom"] == 17
    assert p["count"] <= 250
    assert sum(p["per_zoom"].values()) == p["count"]
    assert min(p["per_zoom"]) == 13


@pytest.mark.parametrize("km", [0.5, 1, 2, 3, 6, 15])
def test_plan_never_exceeds_limit(km):
    p = tl.plan(square_km(km), min_zoom=13, max_tiles=250, max_zoom=18)
    assert p["count"] <= 250
    if p["fits"] and p["max_zoom"] < 18:
        # one zoom higher would not fit any more
        assert p["count"] + tl.count(square_km(km), p["max_zoom"] + 1) > 250


def test_plan_huge_area_does_not_fit():
    p = tl.plan((13.0, 49.5, 15.5, 50.8), min_zoom=13, max_tiles=250)
    assert not p["fits"] and p["max_zoom"] is None and p["count_at_min_zoom"] > 250
    with pytest.raises(tl.TileError):
        tl.download((13.0, 49.5, 15.5, 50.8), p, "/tmp/nowhere", "https://x/{z}/{x}/{y}.png", "UA")


def test_osm_server_offline_forbidden():
    cfg = load_config()
    allowed, reason = offline_tiles_allowed(cfg)
    assert not allowed and "tile.openstreetmap.org" in reason
    cfg["tiles"]["offline_allowed"] = True  # not even a manual permission unlocks OSM
    assert offline_tiles_allowed(cfg)[0] is False
    cfg["tiles"]["url"] = "https://a.tiles.example.org/{z}/{x}/{y}.png"
    assert offline_tiles_allowed(cfg)[0] is True


class FakeSession:
    """Records requests; checks that they never run concurrently."""

    def __init__(self, respond_304=False):
        self.requests = []
        self.active = 0
        self.max_concurrent = 0
        self.lock = threading.Lock()
        self.respond_304 = respond_304
        self.content = png_tile()

    def get(self, url, headers=None, timeout=None):
        with self.lock:
            self.active += 1
            self.max_concurrent = max(self.max_concurrent, self.active)
        self.requests.append((url, dict(headers or {})))

        class R:
            pass

        r = R()
        if self.respond_304 and "If-None-Match" in (headers or {}):
            r.status_code, r.content, r.headers = 304, b"", {}
        else:
            r.status_code, r.content = 200, self.content
            r.headers = {"ETag": '"abc"', "Last-Modified": "Mon, 05 Oct 2026 08:00:00 GMT"}
        with self.lock:
            self.active -= 1
        return r


def test_sequential_download_with_user_agent(tmp_path):
    cfg = load_config()
    cfg["contact"] = "obec@example.cz"
    bbox = square_km(1.0)
    p = tl.plan(bbox, min_zoom=13, max_tiles=250, max_zoom=16, overview=(12,))
    session = FakeSession()
    progress = []
    res = tl.download(bbox, p, tmp_path / "d", "https://tiles.example.org/{z}/{x}/{y}.png", user_agent(cfg),
                      session=session, progress=lambda i, n: progress.append((i, n)), pause=0)
    n = p["count_total"]
    assert len(session.requests) == n == res["count"]
    assert session.max_concurrent == 1
    assert all(h["User-Agent"] == "DostupnostKontejneru/1.1 (lokalni aplikace; Python; obec@example.cz)"
               for _, h in session.requests)
    assert progress[-1] == (n, n)
    assert res["min_zoom"] == 12 and res["max_zoom"] == p["max_zoom"]
    assert len(list((tmp_path / "d").rglob("*.png"))) == n
    # update: conditional requests, 304 = the tile is taken over
    session2 = FakeSession(respond_304=True)
    tl.download(bbox, p, tmp_path / "d2", "https://tiles.example.org/{z}/{x}/{y}.png", "UA", session=session2,
                pause=0, previous=tmp_path / "d")
    assert all(h.get("If-None-Match") == '"abc"' for _, h in session2.requests)
    assert len(list((tmp_path / "d2").rglob("*.png"))) == n


def test_download_without_internet(tmp_path):
    import requests

    class Offline:
        def get(self, *a, **kw):
            raise requests.exceptions.ConnectionError("offline")

    bbox = square_km(1.0)
    p = tl.plan(bbox)
    with pytest.raises(ConnectionFailed):
        tl.download(bbox, p, tmp_path / "d", "https://t.example.org/{z}/{x}/{y}.png", "UA", session=Offline(), pause=0)


def test_mosaic(tmp_path):
    from pyproj import Transformer

    bbox = square_km(1.0)
    folder = tmp_path / "d"
    content = png_tile((10, 200, 30))
    for z in (14, 15):
        x0, x1, y0, y1 = tl.tile_range(bbox, z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                p = tl.tile_path(folder, z, x, y)
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(content)
    tr = Transformer.from_crs(4326, 3857, always_xy=True)
    x0, y0 = tr.transform(bbox[0] + 0.002, bbox[1] + 0.002)
    x1, y1 = tr.transform(bbox[2] - 0.002, bbox[3] - 0.002)
    res = tl.mosaic(folder, x0, y0, x1, y1, target_zoom=17)
    assert res is not None
    image, extent, z, coverage = res
    assert z == 15 and coverage == 1.0  # the highest stored zoom within 15–17
    assert extent[0] <= x0 and extent[1] >= x1 and extent[2] <= y0 and extent[3] >= y1
    assert tuple(image[5, 5]) == (10, 200, 30, 255)
    # missing tile -> transparent spot (the vector basemap is below)
    x, y = tl.lonlat_to_tile(LON, LAT, 15)
    tl.tile_path(folder, 15, x, y).unlink()
    image, extent, z, coverage = tl.mosaic(folder, x0, y0, x1, y1, target_zoom=17)
    assert z == 15 and 0 < coverage < 1
    assert (image[:, :, 3] == 0).any()
    # too coarse tiles (zoom 14 for target 17) are not used – the vector is better
    shutil.rmtree(folder / "15")
    assert tl.mosaic(folder, x0, y0, x1, y1, target_zoom=17) is None
    assert tl.mosaic(folder, x0, y0, x1, y1, target_zoom=16)[2] == 14
    assert tl.mosaic(tmp_path / "empty", x0, y0, x1, y1, target_zoom=17) is None


def test_limit_250_cannot_be_bypassed_by_config():
    b = square_km(2.0)
    p = tl.plan(b, min_zoom=16, max_tiles=5000, max_zoom=18, overview=(13, 14, 15))
    assert p["min_zoom"] == 13 and p["limit"] == 250
    assert p["overview"] == {}  # zooms 13–15 count towards the limit
    assert sum(c for z, c in p["per_zoom"].items() if z >= 13) <= 250


def test_url_template():
    assert tl.url_from_template("https://{s}.t.example.org/{z}/{x}/{y}{r}.png?key={apikey}", 5, 6, 7) == \
        "https://a.t.example.org/5/6/7.png?key={apikey}"


def test_osm_server_aliases_blocked():
    cfg = load_config()
    cfg["tiles"]["offline_allowed"] = True
    for url in ("https://tile.osm.org/{z}/{x}/{y}.png", "https://tile.openstreetmap.org./{z}/{x}/{y}.png",
                "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"):
        cfg["tiles"]["url"] = url
        assert offline_tiles_allowed(cfg)[0] is False, url


def test_tile_error_does_not_stop_preparation(tmp_path):
    """Tiles are optional: when the server does not return some of them, the area is prepared anyway."""
    import container_access.areas as areas_module
    from container_access.areas import AreaManager, prepare

    from .sample_area import osm_file

    source = osm_file(tmp_path)
    cfg = load_config()
    cfg["tiles"].update(url="https://tiles.example.org/{z}/{x}/{y}.png", offline_allowed=True)

    class Broken(FakeSession):
        def get(self, url, headers=None, timeout=None):
            r = super().get(url, headers, timeout)
            if "/16/" in url:
                r.status_code = 404
            return r

    original = areas_module.download_osm
    areas_module.download_osm = lambda bbox, target, *a, **k: shutil.copy(source, target) and \
        {"seconds": 0.0, "bytes": 0, "server": "test"}
    try:
        manager = AreaManager(tmp_path / "areas")
        meta = prepare(manager, cfg, "Test", extent=[14.392, 50.271, 14.400, 50.276], session=Broken())
        assert meta["tiles"]["downloaded"] is False and "HTTP 404" in meta["tiles"]["reason"]
        assert (manager.path(meta["slug"]) / "network.graphml").exists()
        # successful download, then an update with an error -> the previous tiles stay
        meta = prepare(manager, cfg, "Test", extent=meta["extent"], slug=meta["slug"], session=FakeSession())
        n = len(list((manager.path(meta["slug"]) / "tiles").rglob("*.png")))
        assert meta["tiles"]["downloaded"] and n == meta["tiles"]["count"]
        meta = prepare(manager, cfg, "Test", extent=meta["extent"], slug=meta["slug"], session=Broken())
        assert "ponechány předchozí" in meta["tiles"]["reason"]
        assert len(list((manager.path(meta["slug"]) / "tiles").rglob("*.png"))) == n
    finally:
        areas_module.download_osm = original


def test_component_swap_restores_original_on_error(tmp_path, monkeypatch):
    from container_access import areas as areas_module

    target, tmp = tmp_path / "area", tmp_path / "new"
    for folder, content in ((target, "old"), (tmp, "new")):
        (folder / "tiles").mkdir(parents=True)
        for n in ("network.graphml", "basemap.geojson", "area.json", "tiles/a.png"):
            (folder / n).write_text(content)
    original_move = shutil.move
    calls = []

    def broken_move(a, b):
        calls.append(a)
        if str(a).endswith("new/basemap.geojson"):  # in the middle of the swap: another program holds the file
            raise PermissionError("another program holds the file")
        return original_move(a, b)

    monkeypatch.setattr(areas_module.shutil, "move", broken_move)
    monkeypatch.setattr(areas_module.time, "sleep", lambda s: None)
    with pytest.raises(PermissionError):
        areas_module._swap_components(target, tmp)
    for n in ("network.graphml", "basemap.geojson", "area.json", "tiles/a.png"):
        assert (target / n).read_text() == "old", n
    assert not [p for p in tmp_path.iterdir() if p.name.startswith(".backup")]
