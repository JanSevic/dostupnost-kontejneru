"""Downloading area data with one Overpass query (the server is faked, no internet)."""

import requests

import pytest

from container_access.basemap import basemap_from_xml
from container_access.network import ConnectionFailed, NetworkError, expand_bbox, load_osm_xml, process_osm_graph
from container_access.overpass import download_osm, query, servers

from .sample_area import osm_file

BBOX = expand_bbox(14.385, 50.268, 14.410, 50.280, 300)
CFG = {"overpass_url": ["https://first.example/api/interpreter", "https://second.example/api/interpreter"]}


class FakeResponse:
    def __init__(self, status=200, body=b""):
        self.status_code, self.body = status, body

    def iter_content(self, chunk_size=1):
        for i in range(0, len(self.body), chunk_size):
            yield self.body[i:i + chunk_size]

    def close(self):
        pass


class FakeSession:
    """Returns prepared responses (or raises exceptions) in turn for every POST."""

    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []

    def post(self, url, data=None, headers=None, timeout=None, stream=False):
        self.calls.append({"url": url, "query": data["data"], "ua": headers["User-Agent"]})
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def test_query_contains_network_and_basemap():
    q = query(BBOX)
    assert q.startswith("[out:xml]")
    assert 'way["highway"]' in q and 'way["building"]' in q and 'node["place"' in q
    assert "(._;>;);" in q  # way nodes and relation members
    w, s, e, n = BBOX
    assert f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})" in q


def test_servers_from_config():
    assert servers({"overpass_url": "https://x/api"}) == ["https://x/api"]
    assert len(servers({})) >= 2


def test_one_query_for_network_and_basemap(tmp_path):
    source = osm_file(tmp_path)
    s = FakeSession(FakeResponse(200, source.read_bytes()))
    target = tmp_path / "downloaded.osm"
    messages = []
    info = download_osm(BBOX, target, CFG, "TestUA/1.0", progress=lambda *a: messages.append(a[1]), session=s)
    assert len(s.calls) == 1 and s.calls[0]["ua"] == "TestUA/1.0"
    assert info["bytes"] == len(source.read_bytes()) and target.read_bytes() == source.read_bytes()
    assert not list(tmp_path.glob("*.downloading"))
    net = process_osm_graph(load_osm_xml(target, downloaded=True), bbox=BBOX)
    assert net.segment_count > 100
    assert basemap_from_xml(target, BBOX)["features"]


def test_overloaded_server_tries_the_next(tmp_path):
    source = osm_file(tmp_path)
    s = FakeSession(FakeResponse(429), FakeResponse(200, source.read_bytes()))
    messages = []
    info = download_osm(BBOX, tmp_path / "x.osm", CFG, "UA", progress=lambda *a: messages.append(a[1]), session=s)
    assert [c["url"] for c in s.calls] == CFG["overpass_url"]
    assert info["server"] == CFG["overpass_url"][1]
    assert any("zkouším další server" in m for m in messages)


def test_timeout_in_response(tmp_path):
    body = b'<?xml version="1.0"?><osm><remark> runtime error: Query timed out in "query" </remark></osm>'
    s = FakeSession(FakeResponse(200, body), FakeResponse(504))
    with pytest.raises(NetworkError, match="timed out") as e:
        download_osm(BBOX, tmp_path / "x.osm", CFG, "UA", session=s)
    assert not isinstance(e.value, ConnectionFailed)
    assert "504" in str(e.value)
    assert not (tmp_path / "x.osm").exists()


def test_no_internet(tmp_path):
    s = FakeSession(requests.exceptions.ConnectionError("x"), requests.exceptions.ConnectionError("y"))
    with pytest.raises(ConnectionFailed, match="internetu"):
        download_osm(BBOX, tmp_path / "x.osm", CFG, "UA", session=s)


def test_empty_extent(tmp_path):
    target = tmp_path / "x.osm"
    download_osm(BBOX, target, CFG, "UA",
                 session=FakeSession(FakeResponse(200, b'<?xml version="1.0"?><osm version="0.6"></osm>')))
    with pytest.raises(NetworkError, match="žádné pěší cesty"):
        load_osm_xml(target, downloaded=True)
