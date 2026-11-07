"""Walking distance to the nearest container along the network.

Method:
1. Every container snaps perpendicularly to the nearest network edge: edge *e* = (u, v)
   of length *L*, projection position *t* from u and connection length *s*.
2. Multi-source Dijkstra: node u starts at s + t, node v at s + L − t
   (minimum over containers).
3. Distance inside an edge at position x from u:
   d(x) = min(d(u) + x, d(v) + L − x); on an edge with a container also s + |x − t|.
   Computed for the midpoint of every segment (about 10 m).
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import Point

from .network import WalkingNetwork

INF = float("inf")
SMALL_COMPONENT_M = 500.0  # shorter separate pieces of the network are reported as isolated


@dataclass
class Snap:
    """Connection of one container to the network."""

    id: int | str
    edge: int | None  # edge index (None = not connected)
    t: float = 0.0  # projection position from the start of the edge [m]
    s: float = 0.0  # connection length (perpendicular) [m]
    point: tuple[float, float] | None = None  # projection onto the network (metres)
    outside: bool = False
    isolated: bool = False

    def as_dict(self, warning_m: float) -> dict:
        return {
            "id": self.id,
            "connection_m": None if self.edge is None else round(self.s, 1),
            "outside": self.outside,
            "long_connection": self.edge is not None and self.s > warning_m,
            "isolated": self.isolated,
        }


@dataclass
class TypeResult:
    key: str
    d_segments: np.ndarray  # distance for every segment (inf = unreachable)
    d_nodes: np.ndarray
    snaps: list[Snap] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def snap_containers(net: WalkingNetwork, points_xy: np.ndarray, ids: list) -> list[Snap]:
    """Perpendicular projection of every point onto the nearest network edge."""
    result = []
    if len(net.edge_geoms) == 0:
        return [Snap(id=i, edge=None, outside=True) for i in ids]
    for (x, y), cid in zip(np.asarray(points_xy, dtype=float).reshape(-1, 2), ids):
        p = Point(x, y)
        if not net.area.is_empty and not net.area.covers(p):
            result.append(Snap(id=cid, edge=None, outside=True))
            continue
        e = int(net.tree.nearest(p))
        geom = net.edge_geoms[e]
        t = float(geom.project(p))
        q = geom.interpolate(t)
        result.append(Snap(id=cid, edge=e, t=t, s=float(p.distance(q)), point=(q.x, q.y)))
    return result


def dijkstra(net: WalkingNetwork, initial: dict[int, float]) -> np.ndarray:
    """Multi-source Dijkstra with initial node distances."""
    d = np.full(len(net.nodes_xy), INF)
    heap = []
    for n, h in initial.items():
        if h < d[n]:
            d[n] = h
    for n in np.nonzero(np.isfinite(d))[0]:
        heap.append((d[n], int(n)))
    heapq.heapify(heap)
    done = np.zeros(len(d), dtype=bool)
    neighbours = net.neighbours
    while heap:
        du, u = heapq.heappop(heap)
        if done[u]:
            continue
        done[u] = True
        for v, L in neighbours[u]:
            nd = du + L
            if nd < d[v]:
                d[v] = nd
                heapq.heappush(heap, (nd, v))
    return d


def distances(net: WalkingNetwork, snaps: list[Snap]) -> tuple[np.ndarray, np.ndarray]:
    """Distance to the nearest connected container for network nodes and segments."""
    valid = [p for p in snaps if p.edge is not None]
    initial: dict[int, float] = {}
    for p in valid:
        e = p.edge
        u, v, L = int(net.edge_u[e]), int(net.edge_v[e]), float(net.edge_length[e])
        for node, h in ((u, p.s + p.t), (v, p.s + L - p.t)):
            if h < initial.get(node, INF):
                initial[node] = h
    d_nodes = dijkstra(net, initial)

    e = net.segment_edge
    x = net.segment_x
    L = net.edge_length[e]
    d_s = np.minimum(d_nodes[net.edge_u[e]] + x, d_nodes[net.edge_v[e]] + (L - x))

    # containers directly on the segment's edge
    if valid and len(e):
        order = np.argsort(e, kind="stable")
        e_sorted = e[order]
        for p in valid:
            a = np.searchsorted(e_sorted, p.edge, side="left")
            b = np.searchsorted(e_sorted, p.edge, side="right")
            if a == b:
                continue
            idx = order[a:b]
            d_s[idx] = np.minimum(d_s[idx], p.s + np.abs(x[idx] - p.t))
    return d_nodes, d_s


def compute_type(net: WalkingNetwork, key: str, points_xy: np.ndarray, ids: list, warning_m: float = 30.0,
                 name: str | None = None) -> TypeResult:
    """Computes distances for one waste type."""
    name = name or key
    snaps = snap_containers(net, points_xy, ids)
    warnings = []
    outside = [p for p in snaps if p.outside]
    if outside:
        warnings.append(
            f"{name}: {len(outside)} kontejner(ů) leží mimo načtenou síť a nebyl(y) započítán(y) "
            f"(č. {', '.join(str(p.id) for p in outside)})."
        )
    total = float(net.component_length.sum())
    for p in snaps:
        if p.edge is None:
            continue
        if p.s > warning_m:
            warnings.append(
                f"{name}: kontejner č. {p.id} je od nejbližší cesty {p.s:.0f} m (víc než {warning_m:.0f} m)."
            )
        comp_length = float(net.component_length[net.edge_component[p.edge]])
        if comp_length < min(SMALL_COMPONENT_M, 0.05 * total):
            p.isolated = True
            warnings.append(
                f"{name}: kontejner č. {p.id} je připojený k izolovanému kousku cesty ({comp_length:.0f} m), "
                "který nenavazuje na zbytek sítě. Posuň ho blíž k hlavní cestě nebo doplň spojení v OSM."
            )
    d_nodes, d_s = distances(net, snaps)
    return TypeResult(key=key, d_segments=d_s, d_nodes=d_nodes, snaps=snaps, warnings=warnings)


def summary(results: list[TypeResult], segment_count: int) -> np.ndarray:
    """"All types" summary: the longest of the walks to the nearest container of each type."""
    if not results:
        return np.full(segment_count, INF)
    return np.max(np.vstack([r.d_segments for r in results]), axis=0)


def check_straight_line(net: WalkingNetwork, d_segments: np.ndarray, points_xy: np.ndarray, tolerance: float = 1e-6) -> dict:
    """Checks that the network distance is never smaller than the straight-line distance to the nearest container."""
    points = np.asarray(points_xy, dtype=float).reshape(-1, 2)
    finite = np.isfinite(d_segments)
    if not len(points) or not finite.any():
        return {"ok": True, "violated": 0, "checked": 0}
    import shapely
    from shapely import STRtree

    mids = net.segment_mid_xy[finite]
    tree = STRtree(shapely.points(points))
    _, straight = tree.query_nearest(shapely.points(mids), return_distance=True, all_matches=False)
    diff = d_segments[finite] - straight
    violated = int((diff < -tolerance).sum())
    return {"ok": violated == 0, "violated": violated, "checked": int(finite.sum()),
            "min_margin_m": float(diff.min())}


def band(d: float, limits: list[float]) -> int:
    """Band index (0 = nearest). Returns -1 for unreachable."""
    if not np.isfinite(d):
        return -1
    for i, h in enumerate(limits):
        if d <= h:
            return i
    return len(limits)


def band_label(i: int, limits: list[float]) -> str:
    if i < 0:
        return "nedosažitelné"
    h = [0] + [int(x) if float(x).is_integer() else x for x in limits]
    if i < len(limits):
        return f"{h[i]}–{h[i + 1]} m"
    return f"nad {h[-1]} m"
