"""Test helpers: artificial networks with known geometry."""

from __future__ import annotations

import math
import random

import networkx as nx
import numpy as np
from shapely.geometry import LineString

from container_access.network import build_network

# Offset so that coordinates lie in a real UTM 33N range (around the default view).
X0, Y0 = 450_000.0, 5_570_000.0
CRS = "EPSG:32633"


def graph(nodes: dict, edges: list) -> nx.MultiGraph:
    """nodes: {name: (x, y)} in metres relative to (X0, Y0); edges: [(u, v)] or [(u, v, [points])]."""
    G = nx.MultiGraph()
    for n, (x, y) in nodes.items():
        G.add_node(n, x=X0 + x, y=Y0 + y)
    for e in edges:
        u, v = e[0], e[1]
        data = {}
        if len(e) > 2:
            pts = [nodes[u]] + list(e[2]) + [nodes[v]]
            data["geometry"] = LineString([(X0 + a, Y0 + b) for a, b in pts])
        G.add_edge(u, v, **data)
    return G


def network(nodes, edges, segment_length=10.0, area=None):
    return build_network(graph(nodes, edges), CRS, segment_length=segment_length, area=area)


def point(x, y):
    return np.array([[X0 + x, Y0 + y]])


def random_grid(n=6, step=80.0, seed=0, curved=True, dropout=0.15):
    """Irregular grid with randomly curved edges and missing edges."""
    rnd = random.Random(seed)
    nodes = {}
    for i in range(n):
        for j in range(n):
            nodes[(i, j)] = (i * step + rnd.uniform(-15, 15), j * step + rnd.uniform(-15, 15))
    edges = []
    for i in range(n):
        for j in range(n):
            for di, dj in ((1, 0), (0, 1)):
                a, b = (i, j), (i + di, j + dj)
                if b not in nodes or rnd.random() < dropout:
                    continue
                if curved and rnd.random() < 0.5:
                    (x1, y1), (x2, y2) = nodes[a], nodes[b]
                    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
                    nx_, ny_ = -(y2 - y1), (x2 - x1)
                    k = rnd.uniform(-0.3, 0.3)
                    edges.append((a, b, [(mx + k * nx_, my + k * ny_)]))
                else:
                    edges.append((a, b))
    return nodes, edges


def brute_force(s, snaps):
    """Reference computation: the network is densified at every segment midpoint and container
    projection, then plain networkx Dijkstra runs from an auxiliary super-source."""
    H = nx.Graph()
    mids = {}
    on_edge = {e: {0.0: ("u", e), float(s.edge_length[e]): ("v", e)} for e in range(len(s.edge_length))}
    for k, (e, x) in enumerate(zip(s.segment_edge, s.segment_x)):
        on_edge[int(e)][float(x)] = ("k", k)
    for p in snaps:
        if p.edge is not None:
            on_edge[p.edge][float(p.t)] = on_edge[p.edge].get(float(p.t), ("c", p.id))
    source = "S"
    H.add_node(source)

    def name(e, x, label):
        if label[0] == "u":
            return ("n", int(s.edge_u[e]))
        if label[0] == "v":
            return ("n", int(s.edge_v[e]))
        return ("h", e, x)

    for e, pts in on_edge.items():
        order = sorted(pts)
        for a, b in zip(order[:-1], order[1:]):
            na, nb = name(e, a, pts[a]), name(e, b, pts[b])
            w = b - a
            if H.has_edge(na, nb):
                w = min(w, H[na][nb]["weight"])
            H.add_edge(na, nb, weight=w)
        for x, label in pts.items():
            if label[0] == "k":
                mids[label[1]] = name(e, x, label)
    for p in snaps:
        if p.edge is None:
            continue
        target = name(p.edge, float(p.t), on_edge[p.edge][float(p.t)])
        if p.t == 0.0:
            target = ("n", int(s.edge_u[p.edge]))
        elif p.t == float(s.edge_length[p.edge]):
            target = ("n", int(s.edge_v[p.edge]))
        w = p.s
        if H.has_edge(source, target):
            w = min(w, H[source][target]["weight"])
        H.add_edge(source, target, weight=w)
    d = nx.single_source_dijkstra_path_length(H, source, weight="weight")
    return np.array([d.get(mids[k], math.inf) for k in range(len(s.segment_edge))])
