"""Offline mode: network blocking and a full run of the app with --offline (start, area, computation, exports) on the made-up village Test."""

import io
import json
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

import pytest

from container_access.basemap import classify
from container_access.config import ROOT, load_config

from .osm_xml import m_to_ll
from .sample_area import NAME, create_area


def test_network_blocking_in_separate_process():
    code = r"""
import socket, sys
sys.path.insert(0, %r)
from container_access.connectivity import block_network
srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
block_network()
c = socket.create_connection(srv.getsockname(), timeout=2); c.close()   # a local connection passes
import requests
try:
    requests.get("https://example.org", timeout=3)
    print("PASSED")
except requests.exceptions.ConnectionError as e:
    print("BLOCKED")
try:
    socket.create_connection(("93.184.216.34", 443), timeout=3)
    print("PASSED")
except OSError:
    print("BLOCKED")
""" % str(ROOT)
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert out.stdout.split() == ["BLOCKED", "BLOCKED"], out.stderr


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _request(port, method, path, data=None, expect_json=True):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method=method,
                                 headers={"Content-Type": "application/json"} if body else {})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=120) as r:
            content = r.read()
            return r.status, (json.loads(content) if expect_json else content), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), dict(e.headers)


@pytest.fixture(scope="module")
def offline_server(tmp_path_factory):
    data = tmp_path_factory.mktemp("offline_data")
    create_area(data, load_config())
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "app.py"), "--offline", "--bez-prohlizece", "--port", str(port), "--data", str(data)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            if _request(port, "GET", "/api/status")[0] == 200:
                break
        except OSError:
            time.sleep(0.3)
    else:
        proc.kill()
        raise AssertionError("the server with --offline did not start: " + (proc.stdout.read() if proc.stdout else ""))
    yield port, data
    proc.terminate()
    proc.wait(timeout=20)


def container(dx, dy, typ, id_):
    lat, lon = m_to_ll(dx, dy)
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"id": id_, "typ": typ, "poznamka": ""}}


def test_app_with_offline(offline_server):
    port, data = offline_server
    # 1) start and connectivity status
    _, st, _ = _request(port, "GET", "/api/status")
    c = st["connectivity"]
    assert (c["online"], c["reason"], c["can_toggle"], c["can_download"]) == (False, "forced", False, False)
    assert "--offline" in c["text"]
    code, _, _ = _request(port, "POST", "/api/connectivity", {"offline": False})
    assert code == 409
    # 2) showing the area
    _, areas, _ = _request(port, "GET", "/api/areas")
    assert [a["name"] for a in areas["areas"]] == [NAME]
    code, st, _ = _request(port, "POST", "/api/areas/open", {"slug": areas["areas"][0]["slug"]})
    assert code == 200 and st["area"]["name"] == NAME
    _, basemap, _ = _request(port, "GET", "/api/basemap")
    assert len(basemap["features"]) > 20
    _, segs, _ = _request(port, "GET", "/api/network/segments")
    assert len(segs["segments"]) > 100
    code, html, _ = _request(port, "GET", "/", expect_json=False)
    assert code == 200 and b"https://" not in html
    # 3) features that need the internet are refused
    code, resp, _ = _request(port, "POST", "/api/areas/prepare", {"default": True})
    assert code == 409 and "internet" in resp["detail"]
    code, resp, _ = _request(port, "POST", "/api/areas/update")
    assert code == 409
    # 4) computation
    containers = {"type": "FeatureCollection", "features": [
        container(5, 5, "plast", 1), container(-300, 290, "plast", 2), container(300, -290, "sklo", 3),
        container(310, 310, "papir", 4), container(-150, -140, "kovy", 5), container(300, 0, "textil", 6),
        container(-290, 10, "kartony", 7), container(150, -300, "oleje", 8)]}
    code, _, _ = _request(port, "PUT", "/api/containers", containers)
    assert code == 200
    code, r, _ = _request(port, "POST", "/api/compute", {"types": "all"})
    assert code == 200 and set(r["results"]) == {"plast", "papir", "sklo", "kovy", "textil", "kartony", "oleje"}
    assert all(k["ok"] for k in r["checks"].values())
    assert r["summary"] is not None
    # 5) all exports
    code, content, h = _request(port, "POST", "/api/export/gpkg", {}, expect_json=False)
    assert code == 200 and content[:16] == b"SQLite format 3\x00"
    code, content, h = _request(port, "POST", "/api/export/html", {"layer": "plast"}, expect_json=False)
    assert code == 200 and b"const DATA" in content and b"tile.openstreetmap.org" not in content
    code, content, h = _request(port, "POST", "/api/export/png", {"layer": "plast"}, expect_json=False)
    from PIL import Image

    assert code == 200 and Image.open(io.BytesIO(content)).size == (3507, 2481)
    assert "X-Warnings" not in h or "Podklad" not in h["X-Warnings"]
    code, content, _ = _request(port, "POST", "/api/export/png", {"all": True, "basemap": "vector"}, expect_json=False)
    assert code == 200 and len(zipfile.ZipFile(io.BytesIO(content)).namelist()) == 8
    outputs = list((Path(data) / "areas").glob("*/outputs/*"))
    assert {p.suffix for p in outputs} >= {".gpkg", ".html", ".png", ".zip"}


def test_basemap_classification():
    from shapely.geometry import LineString, Point, Polygon

    sq = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
    line = LineString([(0, 0), (1, 1)])
    assert classify({"building": "yes"}, sq) == ("building", None)
    assert classify({"building": "no", "landuse": "grass"}, sq) == ("green", "grass")
    assert classify({"natural": "water"}, sq) == ("water", None)
    assert classify({"landuse": "forest"}, sq) == ("forest", None)
    assert classify({"highway": "residential"}, line) == ("road", "street")
    assert classify({"highway": "footway"}, line) == ("road", "path")
    assert classify({"highway": "bus_stop"}, Point(0, 0)) is None
    assert classify({"railway": "rail"}, line) == ("railway", "rail")
    assert classify({"waterway": "stream"}, line) == ("stream", "stream")
    assert classify({"place": "village", "name": "Test"}, Point(0, 0)) == ("place", "village")
    assert classify({"place": "village"}, Point(0, 0)) is None
