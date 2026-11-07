"""Tests of the REST API, areas and exports (artificial area from an .osm file, no internet)."""

import io
import shutil
import time
import zipfile
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient

from container_access.config import load_config
from container_access.server import create_app

from .osm_xml import m_to_ll, osm_xml, village, village_basemap
from .sample_area import NAME, create_area, osm_file


def container(dx, dy, typ, id_=None, note=""):
    lat, lon = m_to_ll(dx, dy)
    p = {"typ": typ, "poznamka": note}
    if id_ is not None:
        p["id"] = id_
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": p}


def fc(*features):
    return {"type": "FeatureCollection", "features": list(features)}


CONTAINERS = fc(
    container(5, 5, "plast", 1, "náves"),
    container(-300, 290, "plast", 2),
    container(300, -290, "sklo", 3),
    container(310, 310, "papir", 4),
    container(5000, 5000, "kovy", 5, "omylem daleko"),
)


def fake_download(source):
    """Replaces the Overpass download by copying a local .osm file."""
    return lambda bbox, target, *a, **k: shutil.copy(source, target) and {"seconds": 0.0, "bytes": 0, "server": "test"}


def wait_for_task(client, limit=60):
    deadline = time.time() + limit
    while time.time() < deadline:
        t = client.get("/api/task").json()
        if not t.get("running"):
            return t
        time.sleep(0.1)
    raise AssertionError("the task did not finish")


@pytest.fixture
def cfg():
    return load_config()


@pytest.fixture
def client(tmp_path, cfg):
    app = create_app(tmp_path, cfg)
    app.state.app_state.connectivity.reachable = True  # tests check nothing over the network
    app.state.app_state.connectivity.check = lambda force=False: app.state.app_state.connectivity.status()
    with TestClient(app) as c:
        c.data = tmp_path
        c.state = app.state.app_state
        yield c


@pytest.fixture
def client_with_area(tmp_path, cfg):
    slug = create_area(tmp_path, cfg)
    app = create_app(tmp_path, cfg)
    with TestClient(app) as c:
        c.data = tmp_path
        c.slug = slug
        c.state = app.state.app_state
        assert c.post("/api/areas/open", json={"slug": slug}).status_code == 200
        yield c


# ---------------------------------------------------------------------------


def test_without_area(client):
    s = client.get("/api/status").json()
    assert s["area"] is None
    assert client.get("/api/areas").json()["areas"] == []
    assert client.put("/api/containers", json=CONTAINERS).status_code == 409
    r = client.post("/api/compute", json={"types": ["plast"]})
    assert r.status_code == 409 and "oblast" in r.json()["detail"]


def test_config(client):
    c = client.get("/api/config").json()
    assert [t["key"] for t in c["types"]] == ["plast", "papir", "sklo", "kovy", "textil", "kartony", "oleje"]
    assert c["default_area"]["name"] == "Dřínov (okres Mělník)"
    assert c["tiles"]["url"].startswith("https://tile.openstreetmap.org/")
    assert c["offline_tiles"]["allowed"] is False  # OSM forbids offline use
    assert c["summary_key"] == "vse"
    assert "contact" not in c


def test_area_estimate(client):
    r = client.post("/api/areas/estimate", json={"west": 14.3862, "south": 50.2664, "east": 14.4088, "north": 50.2808}).json()
    assert 3 < r["area_km2"] < 6 and not r["too_large"]
    assert r["tiles"]["allowed"] is False and "tile.openstreetmap.org" in r["tiles"]["reason"]
    r = client.post("/api/areas/estimate", json={"west": 14.0, "south": 50.0, "east": 14.8, "north": 50.5}).json()
    assert r["too_large"]


def test_prepare_default_area_drinov(client, tmp_path, monkeypatch):
    """The default-area button (name and extent from config.json) – the download is faked:
    instead of Overpass the data of the made-up village Test are returned."""
    import container_access.areas as areas_module

    source = osm_file(tmp_path)
    calls = []
    copy = fake_download(source)
    monkeypatch.setattr(areas_module, "download_osm", lambda bbox, target, *a, **k: calls.append(("osm", bbox)) or copy(bbox, target))
    r = client.post("/api/areas/prepare", json={"default": True})
    assert r.status_code == 200
    t = wait_for_task(client)
    assert t["phase"] == "done", t
    assert client.get("/api/status").json()["area"] is None  # the browser opens a new area
    assert client.post("/api/areas/open", json={"slug": t["slug"]}).status_code == 200
    assert [c[0] for c in calls] == ["osm"]  # one query for the network and the basemap
    # bbox = default extent + 300 m
    w, s, e, n = calls[0][1]
    assert w < 14.3862 and n > 50.2808
    st = client.get("/api/status").json()
    assert st["area"]["name"] == "Dřínov (okres Mělník)"
    assert st["area"]["slug"] == "drinov_okres_melnik"
    assert st["area"]["tiles"]["downloaded"] is False
    assert "zakazují" in st["area"]["tiles"]["reason"]
    assert st["network"]["segment_count"] > 100
    meta = client.get("/api/areas").json()["areas"][0]
    for key in ("name", "bbox", "extent", "downloaded", "source", "attribution"):
        assert key in meta
    assert "OpenStreetMap" in meta["attribution"]


def test_prepare_refused_offline(client):
    client.state.connectivity.manual = True
    r = client.post("/api/areas/prepare", json={"default": True})
    assert r.status_code == 409 and "internet" in r.json()["detail"]


def test_manual_offline_switch(client):
    r = client.post("/api/connectivity", json={"offline": True}).json()
    assert r["online"] is False and r["reason"] == "manual"
    assert client.get("/api/status").json()["connectivity"]["reason"] == "manual"
    assert (client.data / "settings.json").exists()
    r = client.post("/api/connectivity", json={"offline": False}).json()
    assert r["online"] is True


def test_area_from_osm_file_works_offline(client):
    client.state.connectivity.manual = True
    ways, points = village_basemap()
    r = client.post("/api/areas/osm?name=Moje%20obec", content=osm_xml(village() + ways, points).encode(),
                    headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 200, r.text
    t = wait_for_task(client)
    assert t["phase"] == "done", t
    client.post("/api/areas/open", json={"slug": t["slug"]})
    st = client.get("/api/status").json()
    assert st["area"]["name"] == "Moje obec" and "soubor .osm" in st["area"]["source"]


def test_basemap_and_segments(client_with_area):
    c = client_with_area
    b = c.get("/api/basemap").json()
    kinds = {f["properties"]["k"] for f in b["features"]}
    assert {"building", "road", "water", "stream", "forest", "green", "railway", "label", "place"} <= kinds
    d = c.get("/api/network/segments").json()
    assert len(d["segments"]) > 100 and len(d["lengths"]) == len(d["segments"])
    assert c.get("/tiles/16/1/1.png").status_code == 404  # area without tiles


def test_containers_per_area(client_with_area, cfg):
    c = client_with_area
    c.put("/api/containers", json=CONTAINERS)
    assert (c.data / "areas" / c.slug / "containers.geojson").exists()
    slug2 = create_area(c.data, cfg, name="Jiná obec")
    c.post("/api/areas/open", json={"slug": slug2})
    assert c.get("/api/containers").json()["features"] == []
    c.post("/api/areas/open", json={"slug": c.slug})
    assert len(c.get("/api/containers").json()["features"]) == 5
    areas = {a["slug"]: a for a in c.get("/api/areas").json()["areas"]}
    assert areas[c.slug]["container_count"] == 5 and areas[slug2]["container_count"] == 0


def test_compute(client_with_area):
    c = client_with_area
    n = len(c.get("/api/network/segments").json()["segments"])
    c.put("/api/containers", json=CONTAINERS)
    j = c.post("/api/compute", json={"types": ["plast"]}).json()
    assert len(j["results"]["plast"]) == n and j["checks"]["plast"]["ok"]
    assert j["snaps"]["1"]["connection_m"] < 10
    r = c.post("/api/compute", json={"types": ["textil"]})
    assert r.status_code == 400 and "nemá žádný kontejner" in r.json()["detail"]
    j = c.post("/api/compute", json={"types": "all"}).json()
    assert set(j["results"]) == {"plast", "papir", "sklo", "kovy"}
    assert any("Textil" in w for w in j["warnings"])
    assert any("mimo načtenou síť" in w for w in j["warnings"])
    assert all(x is None for x in j["summary"])  # metal not connected -> summary unreachable
    c.put("/api/containers", json=fc(*CONTAINERS["features"][:4]))
    j = c.post("/api/compute", json={"types": "all"}).json()
    for i in range(0, n, 37):
        values = [j["results"][t][i] for t in ("plast", "papir", "sklo")]
        if None in values:
            assert j["summary"][i] is None
        else:
            assert j["summary"][i] == pytest.approx(max(values), abs=0.11)


def test_variants(client_with_area):
    c = client_with_area
    c.put("/api/containers", json=CONTAINERS)
    assert c.post("/api/variants", json={"name": "Varianta A: návrh/1"}).json()["name"] == "Varianta A_ návrh_1"
    assert (c.data / "areas" / c.slug / "variants" / "Varianta A_ návrh_1.geojson").exists()
    c.put("/api/containers", json=fc(container(0, 0, "sklo", 1)))
    lst = c.get("/api/variants").json()
    assert lst[0]["name"] == "Varianta A_ návrh_1" and lst[0]["count"] == 5
    r = c.post("/api/variants/load", json={"name": "Varianta A_ návrh_1"}).json()
    assert len(r["containers"]["features"]) == 5
    assert c.post("/api/variants/load", json={"name": "missing"}).status_code == 400
    assert c.post("/api/variants", json={"name": "  "}).status_code == 400
    assert c.post("/api/variants", json={"name": "CON"}).json()["name"] == "_CON"


def test_import_unknown_type_and_id(client_with_area):
    data = fc(container(0, 0, "Sklo"), container(10, 0, "bioodpad", 3), container(20, 0, "plast", 3),
              {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}, "properties": {}})
    r = client_with_area.post("/api/containers/import", json=data).json()
    feats = r["containers"]["features"]
    assert [f["properties"]["typ"] for f in feats] == ["sklo", "bioodpad", "plast"]
    assert len({f["properties"]["id"] for f in feats}) == 3
    assert any(t["key"] == "bioodpad" and t.get("temporary") for t in r["types"])


def test_import_in_other_crs(client_with_area):
    from pyproj import Transformer

    lat, lon = m_to_ll(0, 0)
    x, y = Transformer.from_crs(4326, 5514, always_xy=True).transform(lon, lat)
    data = {"type": "FeatureCollection", "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::5514"}},
            "features": [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [x, y]},
                          "properties": {"typ": "plast", "id": 1}}]}
    r = client_with_area.post("/api/containers/import", json=data).json()
    lon2, lat2 = r["containers"]["features"][0]["geometry"]["coordinates"]
    assert lon2 == pytest.approx(lon, abs=1e-6) and lat2 == pytest.approx(lat, abs=1e-6)
    bad = fc({"type": "Feature", "geometry": {"type": "Point", "coordinates": [450000, 5570000]},
              "properties": {"typ": "plast"}})
    r = client_with_area.post("/api/containers/import", json=bad)
    assert r.status_code == 400 and "WGS84" in r.json()["detail"]


def test_export_gpkg(client_with_area):
    import pyogrio

    c = client_with_area
    c.put("/api/containers", json=CONTAINERS)
    r = c.post("/api/export/gpkg", json={"bands": [150, 300]})
    assert r.status_code == 200, r.text
    file = c.data / "test.gpkg"
    file.write_bytes(r.content)
    # layer and column names stay Czech – users see them in QGIS
    assert {n for n, _ in pyogrio.list_layers(file)} == {"kontejnery", "sit_vzdalenosti"}
    net = pyogrio.read_dataframe(file, layer="sit_vzdalenosti")
    for column in ("d_plast", "d_papir", "d_sklo", "d_kovy", "d_vse", "pasmo_plast", "delka_m"):
        assert column in net.columns
    assert net.crs.to_epsg() == 32633
    assert set(net["pasmo_plast"]) <= {"0–150 m", "150–300 m", "nad 300 m", "nedosažitelné"}
    cont = pyogrio.read_dataframe(file, layer="kontejnery")
    assert cont.loc[cont["id"] == 5, "varovani"].iloc[0] == "mimo načtenou síť"
    assert list((c.data / "areas" / c.slug / "outputs").glob("*.gpkg"))


def test_export_html_offline(client_with_area):
    c = client_with_area
    c.put("/api/containers", json=CONTAINERS)
    r = c.post("/api/export/html", json={"title": "Mapa <Test>", "layer": "sklo"})
    assert r.status_code == 200, r.text
    html = r.text
    assert "const DATA = {" in html and "__DATA__" not in html and "__TITLE__" not in html
    assert "<title>Mapa &lt;Test&gt;</title>" in html
    assert "tile.openstreetmap.org" not in html  # no online tiles
    assert "<script src=" not in html and "<link" not in html  # everything embedded
    assert '"basemap":{"type":"FeatureCollection","features":[{' in html
    assert '"tiles":null' in html and '"layer":"sklo"' in html
    assert "přispěvatelé OpenStreetMap" in html


def test_png_from_vector_basemap(client_with_area, monkeypatch):
    from PIL import Image

    import requests

    def no_download(*a, **kw):
        raise AssertionError("the PNG export must not download anything")

    monkeypatch.setattr(requests.Session, "request", no_download)
    c = client_with_area
    c.put("/api/containers", json=CONTAINERS)
    r = c.post("/api/export/png", json={"layer": "plast", "title": "Test – mapa"})
    assert r.status_code == 200, r.text
    assert Image.open(io.BytesIO(r.content)).size == (3507, 2481)
    assert "_Test_mapa_plast.png" in unquote(r.headers["content-disposition"])
    assert "Podklad" not in unquote(r.headers.get("X-Warnings", ""))
    r = c.post("/api/export/png", json={"all": True, "basemap": "none", "mode": "continuous"})
    assert len(zipfile.ZipFile(io.BytesIO(r.content)).namelist()) == 5
    assert c.post("/api/export/png", json={"layer": "textil"}).status_code == 400


def test_area_with_stored_tiles(tmp_path, cfg):
    """An area with stored tiles (allowed server): serving, HTML with embedded tiles, PNG from the mosaic."""
    slug = create_area(tmp_path, cfg, tiles=True)
    app = create_app(tmp_path, cfg)
    with TestClient(app) as c:
        c.post("/api/areas/open", json={"slug": slug})
        st = c.get("/api/status").json()["area"]
        assert st["tiles_stored"] and st["tiles_max_zoom"] == 16 and st["tiles_html_bytes"] > 0
        from container_access import tiles as tl

        x0, _, y0, _ = tl.tile_range(st["bbox"], 15)
        r = c.get(f"/tiles/15/{x0}/{y0}.png")
        assert r.status_code == 200 and r.headers["content-type"] == "image/png"
        c.put("/api/containers", json=CONTAINERS)
        html = c.post("/api/export/html", json={"embed_tiles": True}).text
        assert '"tiles":{"' in html and "data:image/png;base64," in html
        b = st["bbox"]
        r = c.post("/api/export/png", json={"layer": "plast", "basemap": "tiles",
                                            "extent": [b[0] + 0.003, b[1] + 0.003, b[2] - 0.003, b[3] - 0.003]})
        assert r.status_code == 200
        assert "nepokrývají" not in unquote(r.headers.get("X-Warnings", ""))


def test_isolated_piece_of_road(tmp_path, cfg):
    from container_access.areas import AreaManager, prepare

    file = osm_file(tmp_path, extra_ways=[([(-100, 120), (-60, 120)], {"highway": "footway"})])
    meta = prepare(AreaManager(tmp_path / "areas"), cfg, "Izolace", osm_file=file)
    app = create_app(tmp_path, cfg)
    with TestClient(app) as c:
        c.post("/api/areas/open", json={"slug": meta["slug"]})
        c.put("/api/containers", json=fc(container(-80, 123, "plast", 1)))
        j = c.post("/api/compute", json={"types": ["plast"]}).json()
        assert j["snaps"]["1"]["isolated"]
        assert any("izolovanému kousku" in w for w in j["warnings"])


def test_adopting_pre_areas_data(client, tmp_path, monkeypatch):
    import json

    import container_access.areas as areas_module

    (tmp_path / "autosave.geojson").write_text(json.dumps(CONTAINERS), encoding="utf-8")
    (tmp_path / "varianty").mkdir()
    (tmp_path / "varianty" / "stara.geojson").write_text(json.dumps(CONTAINERS), encoding="utf-8")
    monkeypatch.setattr(areas_module, "download_osm", fake_download(osm_file(tmp_path)))
    client.post("/api/areas/prepare", json={"default": True})
    t = wait_for_task(client)
    assert t["phase"] == "done"
    client.post("/api/areas/open", json={"slug": t["slug"]})
    assert len(client.get("/api/containers").json()["features"]) == 5
    assert [v["name"] for v in client.get("/api/variants").json()] == ["stara"]


def test_foreign_website_refused(client):
    assert client.get("/api/status", headers={"Origin": "https://evil-site.example"}).status_code == 403
    assert client.post("/api/areas/osm", content=b"<osm/>", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.post("/api/areas/osm", content=b"<osm/>", headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.get("/api/status", headers={"Host": "evil-site.example"}).status_code == 403
    assert client.get("/api/status", headers={"Origin": "http://127.0.0.1:8765"}).status_code == 200


def test_static_files(client):
    r = client.get("/")
    assert r.status_code == 200 and "Dostupnost kontejnerů" in r.text
    for file in ("/app.js", "/render.js", "/export-template.html", "/leaflet/leaflet.js", "/leaflet/leaflet.css", "/style.css"):
        assert client.get(file).status_code == 200, file
    assert "https://" not in r.text  # no CDN


def test_area_name_in_list(client_with_area):
    assert client_with_area.get("/api/areas").json()["areas"][0]["name"] == NAME


def test_update_keeps_containers_and_old_data_on_error(client_with_area, tmp_path, monkeypatch):
    import container_access.areas as areas_module
    from container_access.network import ConnectionFailed

    c = client_with_area
    c.state.connectivity.reachable = True
    c.state.connectivity.check = lambda force=False: c.state.connectivity.status()
    c.put("/api/containers", json=CONTAINERS)
    c.post("/api/variants", json={"name": "A"})
    folder = c.data / "areas" / c.slug
    old_date = c.get("/api/status").json()["area"]["downloaded"]

    # 1) connection failure during the update -> old data stay, the app switches to offline
    def outage(bbox, target, *a, **k):
        raise ConnectionFailed("Nepodařilo se spojit se serverem Overpass. Jsi připojený k internetu?")

    monkeypatch.setattr(areas_module, "download_osm", outage)
    net_before = (folder / "network.graphml").read_bytes()
    assert c.post("/api/areas/update").status_code == 200
    t = wait_for_task(c)
    assert t["phase"] == "error" and "internet" in t["error"]
    assert (folder / "network.graphml").read_bytes() == net_before
    assert c.get("/api/status").json()["connectivity"]["reason"] == "unreachable"
    assert not [p for p in (c.data / "areas").iterdir() if p.name.startswith(".prepare")]

    # 2) successful update -> new date, containers and variants stay
    monkeypatch.setattr(areas_module, "download_osm", fake_download(osm_file(tmp_path)))
    c.state.connectivity.reachable = True
    time.sleep(1.1)
    assert c.post("/api/areas/update").status_code == 200
    assert wait_for_task(c)["phase"] == "done"
    st = c.get("/api/status").json()["area"]
    assert st["downloaded"] != old_date and st["source"] == "OpenStreetMap (Overpass API)"
    assert len(c.get("/api/containers").json()["features"]) == 5
    assert [v["name"] for v in c.get("/api/variants").json()] == ["A"]


def test_request_for_another_area_refused(client_with_area, cfg):
    c = client_with_area
    slug2 = create_area(c.data, cfg, name="Jiná obec")
    c.post("/api/areas/open", json={"slug": slug2})
    # the browser still shows the original area and sends its containers
    r = c.put("/api/containers", json=CONTAINERS, headers={"X-Area": c.slug})
    assert r.status_code == 409
    assert c.get("/api/containers").json()["features"] == []
    r = c.post("/api/compute", json={"types": "all", "containers": CONTAINERS}, headers={"X-Area": c.slug})
    assert r.status_code == 409
    assert c.put("/api/containers", json=CONTAINERS, headers={"X-Area": slug2}).status_code == 200


def test_unchecked_status_is_not_online(tmp_path, cfg):
    app = create_app(tmp_path, cfg)
    with TestClient(app) as c:
        s = c.get("/api/status").json()["connectivity"]
        assert s["online"] is False and s["reason"] == "unchecked"


def test_invalid_slug(client):
    for slug in ("../x", "C:x", "a/b", ".hidden", "Velka"):
        assert client.post("/api/areas/open", json={"slug": slug}).status_code == 400


def test_failed_check_does_not_block_downloading(client, monkeypatch):
    """When the connectivity check fails (proxy, antivirus…), downloading can still be tried; manual offline forbids it."""
    import requests

    from container_access.connectivity import Connectivity

    def fail(*a, **kw):
        raise requests.exceptions.SSLError("certificate verify failed")

    monkeypatch.setattr(requests, "get", fail)
    conn = Connectivity("https://overpass-api.de/api/status", "UA")
    st = conn.check(force=True)
    assert st["online"] is False and st["reason"] == "unreachable" and st["can_download"] is True
    assert "certifikátu" in st["text"]
    conn.manual = True
    assert conn.status()["can_download"] is False
