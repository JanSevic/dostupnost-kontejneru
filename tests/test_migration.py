"""Migration of the data folder from the version with Czech file names and keys."""

import json

from container_access.migration import migrate_legacy_data
from container_access.server import create_app


def _old_data(root):
    area = root / "oblasti" / "test"
    (area / "varianty").mkdir(parents=True)
    (area / "vystupy").mkdir()
    (area / "dlazdice" / "14" / "1").mkdir(parents=True)
    (area / "dlazdice" / "14" / "1" / "2.png").write_bytes(b"png")
    (area / "dlazdice" / "index.json").write_text(json.dumps({"14/1/2": {"etag": "x", "stazeno": "2026-10-01"}}))
    (area / "sit.graphml").write_text("<graphml/>")
    meta = {"verze": 1, "nazev": "Test", "vyrez": [1, 2, 3, 4], "bbox": [1, 2, 3, 4], "okraj_m": 300,
            "plocha_km2": 1.5, "stazeno": "2026-10-01T10:00:00", "vytvoreno": "2026-09-01T10:00:00",
            "zdroj": "OpenStreetMap", "atribuce": "© OSM", "sit": {"delka_km": 11.0, "pocet_kousku": 1100, "crs": "EPSG:32633"},
            "podklad": {"budova": 10, "cesta": 5}, "dlazdice": {"stazeny": True, "pocet": 1, "max_zoom": 14},
            "slug": "test"}
    (area / "oblast.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    basemap = {"type": "FeatureCollection", "souhrn": {"cesta": 2, "popisek": 1}, "features": [
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
         "properties": {"v": "cesta", "t": "ulice", "n": "Ulice A"}},
        {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
         "properties": {"v": "tok", "t": "stream"}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 0]},
         "properties": {"v": "popisek", "t": "ulice", "n": "Ulice A", "a": 12.5}},
    ]}
    (area / "podklad.geojson").write_text(json.dumps(basemap, ensure_ascii=False), encoding="utf-8")
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [14.4, 50.27]},
         "properties": {"id": 1, "typ": "plast", "poznamka": "u obchodu"}}]}
    (area / "kontejnery.geojson").write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    (area / "varianty" / "návrh.geojson").write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    (root / "nastaveni.json").write_text(json.dumps({"posledni_oblast": "test", "offline_rucne": True}))
    return fc


def test_old_data_folder_is_migrated(tmp_path):
    fc = _old_data(tmp_path)
    assert migrate_legacy_data(tmp_path)
    area = tmp_path / "areas" / "test"
    assert not (tmp_path / "oblasti").exists()
    assert sorted(p.name for p in area.iterdir()) == [
        "area.json", "basemap.geojson", "containers.geojson", "network.graphml", "outputs", "tiles", "variants"]
    meta = json.loads((area / "area.json").read_text(encoding="utf-8"))
    assert meta["name"] == "Test" and meta["extent"] == [1, 2, 3, 4] and meta["downloaded"] == "2026-10-01T10:00:00"
    assert meta["network"] == {"length_km": 11.0, "segment_count": 1100, "crs": "EPSG:32633"}
    assert meta["basemap"] == {"building": 10, "road": 5}
    assert meta["tiles"] == {"downloaded": True, "count": 1, "max_zoom": 14}
    basemap = json.loads((area / "basemap.geojson").read_text(encoding="utf-8"))
    assert [f["properties"] for f in basemap["features"]] == [
        {"k": "road", "t": "street", "n": "Ulice A"}, {"k": "stream", "t": "stream"},
        {"k": "label", "t": "street", "n": "Ulice A", "a": 12.5}]
    assert basemap["summary"] == {"road": 2, "label": 1} and "souhrn" not in basemap
    # containers keep their (user-facing) format
    assert json.loads((area / "containers.geojson").read_text(encoding="utf-8")) == fc
    assert (area / "variants" / "návrh.geojson").exists()
    assert json.loads((area / "tiles" / "index.json").read_text()) == {"14/1/2": {"etag": "x", "downloaded": "2026-10-01"}}
    assert json.loads((tmp_path / "settings.json").read_text()) == {"last_area": "test", "manual_offline": True}
    assert not (tmp_path / "nastaveni.json").exists()
    # second run does nothing
    assert not migrate_legacy_data(tmp_path)


def test_app_start_migrates_and_lists_the_area(tmp_path):
    from fastapi.testclient import TestClient

    _old_data(tmp_path)
    client = TestClient(create_app(tmp_path))
    r = client.get("/api/areas").json()
    assert [a["name"] for a in r["areas"]] == ["Test"] and r["last"] == "test"
    assert r["areas"][0]["container_count"] == 1 and r["areas"][0]["variant_count"] == 1
