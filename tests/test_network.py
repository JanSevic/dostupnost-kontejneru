"""Tests of the walkable-way filter and OSM data processing (no internet – from an .osm file)."""

import numpy as np
import pytest

from container_access.compute import check_straight_line, compute_type
from container_access.network import (
    NetworkError,
    bbox_area_km2,
    bbox_contains,
    expand_bbox,
    is_walkable,
    load_osm_xml,
    process_osm_graph,
)

from .osm_xml import m_to_ll, osm_xml, village


@pytest.mark.parametrize(
    "tags, expected",
    [
        ({"highway": "residential"}, True),
        ({"highway": "footway"}, True),
        ({"highway": "cycleway"}, True),
        ({"highway": "cycleway", "foot": "designated"}, True),
        ({"highway": "cycleway", "foot": "no"}, False),
        ({"highway": "footway", "access": "private"}, False),
        ({"highway": "footway", "access": "no"}, False),
        ({"highway": "pedestrian", "access": "no", "foot": "yes"}, True),
        ({"highway": "track", "access": "private", "foot": "permissive"}, True),
        ({"highway": "service", "service": "private"}, False),
        ({"highway": "motorway"}, False),
        ({"highway": "motorway_link"}, False),
        ({"highway": "construction"}, False),
        ({"highway": "platform"}, False),
        ({"highway": "pedestrian", "area": "yes"}, False),
        ({"highway": ["residential", "footway"]}, True),
        ({"highway": "path", "foot": ["yes", "no"]}, False),
        ({}, False),
    ],
)
def test_is_walkable(tags, expected):
    assert is_walkable(tags) is expected


def test_bbox_expansion_and_area():
    b = expand_bbox(14.39, 50.27, 14.40, 50.28, 300)
    assert b[0] < 14.39 and b[2] > 14.40 and b[1] < 50.27 and b[3] > 50.28
    # 300 m in degrees of latitude
    assert (50.27 - b[1]) * 111_320 == pytest.approx(300, rel=1e-6)
    # about 0.71 × 1.11 km originally, 1.31 × 1.71 km with the margin
    assert bbox_area_km2(b) == pytest.approx(1.31 * 1.71, rel=0.03)
    assert bbox_contains(b, (14.39, 50.27, 14.40, 50.28))
    assert not bbox_contains((14.39, 50.27, 14.40, 50.28), b)


@pytest.fixture(scope="module")
def osm_file(tmp_path_factory):
    p = tmp_path_factory.mktemp("osm") / "village.osm"
    p.write_text(osm_xml(village()), encoding="utf-8")
    return p


def test_osm_loading_and_filter(osm_file):
    G = load_osm_xml(osm_file)
    hw = set()
    for _, _, d in G.edges(data=True):
        h = d.get("highway")
        hw.update(h if isinstance(h, list) else [h])
    assert "motorway" not in hw
    assert {"cycleway", "pedestrian", "footway", "residential"} <= hw
    # forbidden ways are missing
    for _, _, d in G.edges(data=True):
        assert is_walkable(d)
    # two-way: every edge has its opposite
    for u, v in G.edges():
        assert G.has_edge(v, u)


def test_processing_to_utm_and_computation(osm_file):
    G = load_osm_xml(osm_file)
    s = process_osm_graph(G, segment_length=10)
    assert s.crs.to_epsg() == 32633  # the default view lies in UTM zone 33N
    assert s.segment_count > 100
    # network length roughly matches the sum of way lengths (~ 12 km)
    assert 8 < s.length_km < 20
    # segments are about 10 m long
    lengths = [np.sqrt(((c[1:] - c[:-1]) ** 2).sum(axis=1)).sum() for c in s.segment_coords]
    assert 5 <= np.median(lengths) <= 15
    # computation with a container on the village green
    tr = s.from_wgs()
    lat, lon = m_to_ll(5, 5)
    x, y = tr.transform(lon, lat)
    r = compute_type(s, "plast", np.array([[x, y]]), [1])
    assert r.snaps[0].s < 10
    assert np.isfinite(r.d_segments).mean() > 0.95
    assert check_straight_line(s, r.d_segments, np.array([[x, y]]))["ok"]
    # coordinates for the browser
    w = s.segments_wgs()
    assert len(w) == s.segment_count
    assert 14.3 < w[0][0][0] < 14.5 and 50.2 < w[0][0][1] < 50.35


def test_empty_osm(tmp_path):
    p = tmp_path / "empty.osm"
    p.write_text(osm_xml([([(0, 0), (100, 0)], {"highway": "motorway"})]), encoding="utf-8")
    with pytest.raises(NetworkError):
        load_osm_xml(p)
