"""Unit tests of the computation on small artificial networks with a known result."""

import math

import numpy as np
import pytest
from shapely.geometry import box

from container_access.compute import (
    INF,
    band,
    band_label,
    check_straight_line,
    compute_type,
    distances,
    snap_containers,
    summary,
)
from container_access.network import _split_line

from .helpers import X0, Y0, brute_force, network, point, random_grid

# ---------------------------------------------------------------------------
# Line A — B — C
# ---------------------------------------------------------------------------


@pytest.fixture
def line():
    return network({"A": (0, 0), "B": (100, 0), "C": (250, 0)}, [("A", "B"), ("B", "C")])


def test_line_nodes_and_segments(line):
    s = line
    r = compute_type(s, "plast", point(30, 5), [1])
    p = r.snaps[0]
    assert p.edge is not None
    assert p.t == pytest.approx(30.0)
    assert p.s == pytest.approx(5.0)
    iA, iB, iC = 0, 1, 2
    assert r.d_nodes[iA] == pytest.approx(35.0)
    assert r.d_nodes[iB] == pytest.approx(75.0)
    assert r.d_nodes[iC] == pytest.approx(225.0)
    # on the edge with the container: d(x) = 5 + |x - 30|
    eAB = int(np.nonzero((s.edge_u == iA) & (s.edge_v == iB) | (s.edge_u == iB) & (s.edge_v == iA))[0][0])
    idx = np.nonzero(s.segment_edge == eAB)[0]
    assert len(idx) == 10  # 100 m in 10 m steps
    for i in idx:
        x = s.segment_x[i] if s.edge_u[eAB] == iA else 100 - s.segment_x[i]
        assert r.d_segments[i] == pytest.approx(5 + abs(x - 30))
    # on edge B–C: d = 75 + distance from B
    eBC = 1 - eAB
    idx = np.nonzero(s.segment_edge == eBC)[0]
    assert len(idx) == 15
    for i in idx:
        x_from_B = s.segment_x[i] if s.edge_u[eBC] == iB else 150 - s.segment_x[i]
        assert r.d_segments[i] == pytest.approx(75 + x_from_B)


def test_two_containers_take_the_nearer(line):
    s = line
    pts = np.vstack([point(30, 5), point(240, -3)])
    r = compute_type(s, "sklo", pts, [1, 2])
    # node C: 3 + 10 from the second container
    assert r.d_nodes[2] == pytest.approx(13.0)
    # node B: min(75, 3 + 140)
    assert r.d_nodes[1] == pytest.approx(75.0)
    assert np.isfinite(r.d_segments).all()


def test_distance_inside_edge_formula():
    """d(x) = min(d(u) + x, d(v) + L − x) – containers at both ends of a long edge."""
    s = network({"A": (0, 0), "B": (200, 0), "P": (-50, 0), "Q": (260, 0)},
                [("P", "A"), ("A", "B"), ("B", "Q")])
    # container at P (d(A) = 50) and at Q (d(B) = 60)
    r = compute_type(s, "papir", np.vstack([point(-50, 0), point(260, 0)]), [1, 2])
    iA, iB = 0, 1
    assert r.d_nodes[iA] == pytest.approx(50)
    assert r.d_nodes[iB] == pytest.approx(60)
    e = int(np.nonzero(((s.edge_u == iA) & (s.edge_v == iB)) | ((s.edge_u == iB) & (s.edge_v == iA)))[0][0])
    for i in np.nonzero(s.segment_edge == e)[0]:
        x = s.segment_x[i] if s.edge_u[e] == iA else 200 - s.segment_x[i]
        assert r.d_segments[i] == pytest.approx(min(50 + x, 60 + 200 - x))


def test_curved_edge_measured_along_the_curve():
    # L-shaped edge: (0,0) -> (100,0) -> (100,100), length 200
    s = network({"A": (0, 0), "B": (100, 100)}, [("A", "B", [(100, 0)])])
    assert s.edge_length[0] == pytest.approx(200)
    r = compute_type(s, "kovy", point(0, 2), [1])
    # node B is 2 + 200 away along the curve even though it is closer in a straight line
    iB = 1
    assert r.d_nodes[iB] == pytest.approx(202)
    k = check_straight_line(s, r.d_segments, point(0, 2))
    assert k["ok"]


def test_unreachable_component_is_inf():
    s = network({"A": (0, 0), "B": (100, 0), "C": (0, 300), "D": (100, 300)}, [("A", "B"), ("C", "D")])
    r = compute_type(s, "plast", point(50, 1), [1])
    e_cd = [e for e in range(2) if {int(s.edge_u[e]), int(s.edge_v[e])} == {2, 3}][0]
    idx = s.segment_edge == e_cd
    assert np.isinf(r.d_segments[idx]).all()
    assert np.isfinite(r.d_segments[~idx]).all()


def test_container_outside_network_not_counted():
    s = network({"A": (0, 0), "B": (100, 0)}, [("A", "B")],
                area=box(X0 - 50, Y0 - 50, X0 + 150, Y0 + 50))
    pts = np.vstack([point(50, 0), point(5000, 5000)])
    r = compute_type(s, "plast", pts, [1, 2], name="Plast")
    assert r.snaps[1].outside
    assert r.snaps[1].edge is None
    assert any("mimo načtenou síť" in v for v in r.warnings)
    assert np.isfinite(r.d_segments).all()


def test_long_connection_warning():
    s = network({"A": (0, 0), "B": (100, 0)}, [("A", "B")])
    r = compute_type(s, "plast", point(50, 40), [7], warning_m=30, name="Plast")
    assert r.snaps[0].s == pytest.approx(40)
    assert any("č. 7" in v and "40 m" in v for v in r.warnings)
    # the connection counts towards the distance
    assert np.min(r.d_segments) == pytest.approx(40 + 5)  # the segment midpoint is 5 m from the projection


def test_no_containers_all_inf(line):
    d_nodes, d_s = distances(line, [])
    assert np.isinf(d_nodes).all() and np.isinf(d_s).all()


def test_parallel_edges_and_loop():
    # two parallel ways A–B (straight 100 m and a 160 m detour) and a loop at B
    s = network({"A": (0, 0), "B": (100, 0)},
                [("A", "B"), ("A", "B", [(0, 30), (100, 30)]), ("B", "B", [(130, 0), (130, 30), (100, 30.5)])])
    r = compute_type(s, "plast", point(0, 0), [1])
    assert r.d_nodes[1] == pytest.approx(100)
    ref = brute_force(s, r.snaps)
    np.testing.assert_allclose(r.d_segments, ref, rtol=0, atol=1e-6)


@pytest.mark.parametrize("seed", range(8))
def test_matches_brute_force(seed):
    """The result must match Dijkstra on the densified network (every segment as a node)."""
    nodes, edges = random_grid(n=6, seed=seed)
    s = network(nodes, edges)
    rng = np.random.default_rng(seed)
    pts = np.column_stack([X0 + rng.uniform(-20, 420, 5), Y0 + rng.uniform(-20, 420, 5)])
    r = compute_type(s, "plast", pts, list(range(5)))
    ref = brute_force(s, r.snaps)
    finite = np.isfinite(ref)
    assert (np.isfinite(r.d_segments) == finite).all()
    np.testing.assert_allclose(r.d_segments[finite], ref[finite], rtol=0, atol=1e-6)


@pytest.mark.parametrize("seed", range(8))
def test_network_never_shorter_than_straight_line(seed):
    nodes, edges = random_grid(n=7, seed=100 + seed)
    s = network(nodes, edges)
    rng = np.random.default_rng(seed)
    pts = np.column_stack([X0 + rng.uniform(0, 480, 4), Y0 + rng.uniform(0, 480, 4)])
    r = compute_type(s, "plast", pts, list(range(4)))
    k = check_straight_line(s, r.d_segments, pts)
    assert k["ok"], k
    assert k["checked"] > 0


def test_summary_is_maximum():
    a = type("R", (), {"d_segments": np.array([1.0, 5.0, INF])})()
    b = type("R", (), {"d_segments": np.array([3.0, 2.0, 1.0])})()
    np.testing.assert_array_equal(summary([a, b], 3), [3.0, 5.0, INF])
    assert np.isinf(summary([], 2)).all()


def test_bands():
    h = [100, 200]
    assert band(0, h) == 0
    assert band(100, h) == 0
    assert band(100.1, h) == 1
    assert band(250, h) == 2
    assert band(math.inf, h) == -1
    assert band_label(0, h) == "0–100 m"
    assert band_label(1, h) == "100–200 m"
    assert band_label(2, h) == "nad 200 m"
    assert band_label(-1, h) == "nedosažitelné"


def test_segments_cover_edge_without_gaps():
    coords = np.array([[0, 0], [30, 0], [30, 40], [100, 40]], dtype=float)
    L = 30 + 40 + 70
    cuts = np.linspace(0, L, 15)
    pieces = _split_line(coords, cuts)
    assert len(pieces) == 14
    for a, b in zip(pieces[:-1], pieces[1:]):
        np.testing.assert_allclose(a[-1], b[0])
    np.testing.assert_allclose(pieces[0][0], coords[0])
    np.testing.assert_allclose(pieces[-1][-1], coords[-1])
    lengths = [np.sqrt(((k[1:] - k[:-1]) ** 2).sum(axis=1)).sum() for k in pieces]
    np.testing.assert_allclose(lengths, L / 14)


def test_perpendicular_snap_to_curve():
    s = network({"A": (0, 0), "B": (100, 100)}, [("A", "B", [(100, 0)])])
    p = snap_containers(s, point(103, 50), ["x"])[0]
    assert p.t == pytest.approx(150)
    assert p.s == pytest.approx(3)
    assert p.point[0] - X0 == pytest.approx(100)
    assert p.point[1] - Y0 == pytest.approx(50)
