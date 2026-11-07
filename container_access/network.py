"""Walking network: download from OpenStreetMap, way filter, cache and conversion to the computation structure.

The computation structure :class:`WalkingNetwork` is an undirected graph in a metric
coordinate system (UTM) whose edges are additionally split into short segments
(about 10 m) for smooth colouring.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import networkx as nx
import numpy as np
from pyproj import CRS, Transformer
from shapely import STRtree
from shapely.geometry import LineString, Polygon, box

# ---------------------------------------------------------------------------
# Walkable-way filter
# ---------------------------------------------------------------------------

# highway values never used for walking.
HIGHWAY_EXCLUDED = (
    "abandoned|bus_guideway|busway|construction|motorway|motorway_link|no|planned|"
    "platform|proposed|raceway|razed|rest_area|services|disused"
)
FOOT_YES = ("yes", "designated", "permissive")
FOOT_NO = ("no", "private")
ACCESS_NO = ("no", "private")

# Walkability rules (is_walkable):
#  1) ordinary ways: not foot=no/private, not access=no/private, not service=private
#     (unlike osmnx "walk" this includes cycleways – in Czechia often shared paths for
#     pedestrians and cyclists – and roads with separately mapped sidewalks, so that the
#     network stays connected)
#  2) ways explicitly open to pedestrians (foot=yes/designated/permissive)
#     even with access=no/private (e.g. pedestrian zones)


def _values(v) -> list[str]:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return []
    if isinstance(v, (list, tuple, set)):
        return [str(x).strip().lower() for x in v]
    return [str(v).strip().lower()]


def is_walkable(tags: dict) -> bool:
    """Walking-network filter – decides whether pedestrians can use a way with these tags.

    Values may be lists (osmnx merges ways when simplifying the graph).
    """
    highway = _values(tags.get("highway"))
    if not highway:
        return False
    excluded = set(HIGHWAY_EXCLUDED.split("|"))
    if all(h in excluded for h in highway):
        return False
    if "yes" in _values(tags.get("area")):
        return False
    foot = _values(tags.get("foot"))
    if any(f in FOOT_NO for f in foot):
        return False
    foot_allowed = any(f in FOOT_YES for f in foot)
    if not foot_allowed:
        if any(a in ACCESS_NO for a in _values(tags.get("access"))):
            return False
        if "private" in _values(tags.get("service")):
            return False
    return True


# ---------------------------------------------------------------------------
# Extent helpers
# ---------------------------------------------------------------------------

M_PER_DEGREE = 111_320.0


def expand_bbox(west: float, south: float, east: float, north: float, margin_m: float):
    """Grows an extent (WGS84 degrees) by a margin in metres. Returns (w, s, e, n)."""
    lat = (south + north) / 2
    dlat = margin_m / M_PER_DEGREE
    dlon = margin_m / (M_PER_DEGREE * max(math.cos(math.radians(lat)), 0.01))
    return (west - dlon, south - dlat, east + dlon, north + dlat)


def bbox_area_km2(bbox) -> float:
    w, s, e, n = bbox
    lat = (s + n) / 2
    return abs(n - s) * M_PER_DEGREE / 1000 * abs(e - w) * M_PER_DEGREE * math.cos(math.radians(lat)) / 1000


def bbox_contains(outer, inner) -> bool:
    return outer[0] <= inner[0] and outer[1] <= inner[1] and outer[2] >= inner[2] and outer[3] >= inner[3]


def utm_crs(lon: float, lat: float) -> CRS:
    zone = int((lon + 180) // 6) + 1
    return CRS.from_epsg((32600 if lat >= 0 else 32700) + zone)


# ---------------------------------------------------------------------------
# Computation structure
# ---------------------------------------------------------------------------


@dataclass
class WalkingNetwork:
    """Undirected walking network in metres, ready for computation."""

    crs: CRS
    nodes_xy: np.ndarray  # (N, 2)
    edge_u: np.ndarray  # (E,) node index at the start of the geometry
    edge_v: np.ndarray  # (E,) node index at the end of the geometry
    edge_length: np.ndarray  # (E,) length in metres
    edge_geoms: list  # LineStrings oriented u -> v
    neighbours: list  # for every node a list of (neighbour, length)
    tree: STRtree
    segment_edge: np.ndarray  # (M,) edge index
    segment_x: np.ndarray  # (M,) position of the segment midpoint from the start of the edge [m]
    segment_coords: list  # (M,) coordinate arrays of the segment in metres
    segment_mid_xy: np.ndarray  # (M, 2)
    segment_length: np.ndarray  # (M,) segment length [m]
    edge_component: np.ndarray  # (E,) connected-component number of the edge
    component_length: np.ndarray  # (K,) total length of the component [m]
    area: Polygon  # territory the network was loaded for (metres)
    info: dict = field(default_factory=dict)
    _wgs_cache: list | None = field(default=None, repr=False)

    @property
    def segment_count(self) -> int:
        return len(self.segment_edge)

    @property
    def length_km(self) -> float:
        return float(self.edge_length.sum()) / 1000

    def to_wgs(self) -> Transformer:
        return Transformer.from_crs(self.crs, 4326, always_xy=True)

    def from_wgs(self) -> Transformer:
        return Transformer.from_crs(4326, self.crs, always_xy=True)

    def segments_wgs(self) -> list:
        """Segment coordinates in WGS84 [[lon, lat], ...] (cached)."""
        if self._wgs_cache is None:
            tr = self.to_wgs()
            allc = np.concatenate(self.segment_coords) if self.segment_coords else np.zeros((0, 2))
            lon, lat = tr.transform(allc[:, 0], allc[:, 1])
            ll = np.round(np.column_stack([lon, lat]), 6)
            result, i = [], 0
            for c in self.segment_coords:
                result.append(ll[i : i + len(c)].tolist())
                i += len(c)
            self._wgs_cache = result
        return self._wgs_cache

    def area_wgs(self) -> list:
        tr = self.to_wgs()
        x, y = self.area.exterior.xy
        lon, lat = tr.transform(np.asarray(x), np.asarray(y))
        return [[round(a, 6), round(b, 6)] for a, b in zip(lon, lat)]


def _split_line(coords: np.ndarray, cuts: np.ndarray) -> list[np.ndarray]:
    """Splits a polyline at the given distances from its start (ascending, including 0 and L)."""
    seg = np.sqrt(((coords[1:] - coords[:-1]) ** 2).sum(axis=1))
    cum = np.concatenate([[0.0], np.cumsum(seg)])

    def point(d):
        i = int(np.clip(np.searchsorted(cum, d, side="right") - 1, 0, len(seg) - 1))
        if seg[i] == 0:
            return coords[i]
        f = (d - cum[i]) / seg[i]
        return coords[i] + f * (coords[i + 1] - coords[i])

    pieces = []
    for a, b in zip(cuts[:-1], cuts[1:]):
        inner = (cum > a) & (cum < b)
        pieces.append(np.vstack([point(a), coords[inner], point(b)]))
    return pieces


def build_network(
    G: nx.MultiGraph,
    crs,
    segment_length: float = 10.0,
    area: Polygon | None = None,
    info: dict | None = None,
) -> WalkingNetwork:
    """Builds a :class:`WalkingNetwork` from an undirected graph in metric coordinates.

    Nodes must have ``x`` and ``y`` attributes; edges may have ``geometry`` (LineString),
    otherwise the straight line between the nodes is used.
    """
    crs = CRS.from_user_input(crs)
    if not crs.is_projected:
        raise ValueError("Síť musí být v metrickém (projektovaném) souřadnicovém systému.")
    nodes = list(G.nodes)
    index = {n: i for i, n in enumerate(nodes)}
    nodes_xy = np.array([[float(G.nodes[n]["x"]), float(G.nodes[n]["y"])] for n in nodes]).reshape(-1, 2)

    eu, ev, el, eg = [], [], [], []
    for u, v, data in G.edges(data=True):
        iu, iv = index[u], index[v]
        geom = data.get("geometry")
        if geom is None or geom.is_empty:
            geom = LineString([nodes_xy[iu], nodes_xy[iv]])
        c = np.asarray(geom.coords, dtype=float)[:, :2]
        if iu != iv:
            # orient the geometry from u to v
            d_u = np.hypot(*(c[0] - nodes_xy[iu]))
            d_v = np.hypot(*(c[0] - nodes_xy[iv]))
            if d_v < d_u:
                c = c[::-1]
        geom = LineString(c)
        eu.append(iu)
        ev.append(iv)
        el.append(geom.length)
        eg.append(geom)

    edge_u = np.array(eu, dtype=np.int64)
    edge_v = np.array(ev, dtype=np.int64)
    edge_length = np.array(el, dtype=float)

    neighbours = [[] for _ in nodes]
    for a, b, L in zip(eu, ev, el):
        neighbours[a].append((b, L))
        if a != b:
            neighbours[b].append((a, L))

    s_edge, s_x, s_coords, s_mid, s_length = [], [], [], [], []
    for e, geom in enumerate(eg):
        L = el[e]
        if L < 1e-6:
            continue
        n = max(1, int(round(L / segment_length)))
        cuts = np.linspace(0.0, L, n + 1)
        pieces = _split_line(np.asarray(geom.coords), cuts)
        for i, piece in enumerate(pieces):
            x = (cuts[i] + cuts[i + 1]) / 2
            s_edge.append(e)
            s_x.append(x)
            s_coords.append(piece)
            s_length.append(cuts[i + 1] - cuts[i])
            p = geom.interpolate(x)
            s_mid.append((p.x, p.y))

    # connected components (union–find over nodes)
    parent = list(range(len(nodes)))

    def root(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in zip(eu, ev):
        ra, rb = root(a), root(b)
        if ra != rb:
            parent[ra] = rb
    ids: dict[int, int] = {}
    edge_comp = np.array([ids.setdefault(root(a), len(ids)) for a in eu], dtype=np.int64)
    comp_length = np.bincount(edge_comp, weights=edge_length, minlength=len(ids)) if len(eu) else np.zeros(0)

    if area is None:
        if len(nodes_xy):
            minx, miny = nodes_xy.min(axis=0)
            maxx, maxy = nodes_xy.max(axis=0)
            area = box(minx - 100, miny - 100, maxx + 100, maxy + 100)
        else:
            area = Polygon()

    return WalkingNetwork(
        crs=crs,
        nodes_xy=nodes_xy,
        edge_u=edge_u,
        edge_v=edge_v,
        edge_length=edge_length,
        edge_geoms=eg,
        neighbours=neighbours,
        tree=STRtree(eg),
        segment_edge=np.array(s_edge, dtype=np.int64),
        segment_x=np.array(s_x, dtype=float),
        segment_coords=s_coords,
        segment_mid_xy=np.array(s_mid, dtype=float).reshape(-1, 2),
        segment_length=np.array(s_length, dtype=float),
        edge_component=edge_comp,
        component_length=np.asarray(comp_length, dtype=float),
        area=area,
        info=dict(info or {}),
    )


# ---------------------------------------------------------------------------
# OSM: download and processing
# ---------------------------------------------------------------------------


USER_AGENT = "DostupnostKontejneru/1.1 (lokalni aplikace; Python)"  # the server sets it from config.json


class NetworkError(RuntimeError):
    """Error while obtaining the network – the message is meant for the user."""


class ConnectionFailed(NetworkError):
    """Could not connect to the server (internet is probably missing)."""


def _configure_osmnx():
    import osmnx as ox

    tags = set(ox.settings.useful_tags_way) | {"foot", "access", "highway", "service", "area", "sidewalk"}
    ox.settings.useful_tags_way = sorted(tags)
    ox.settings.use_cache = False
    ox.settings.log_console = False
    ox.settings.requests_timeout = 180
    ox.settings.http_user_agent = USER_AGENT
    return ox


def load_osm_xml(file: Path, downloaded: bool = False) -> nx.MultiDiGraph:
    """Loads the network from an .osm file (export from openstreetmap.org or JOSM) and applies the walkable-way filter."""
    ox = _configure_osmnx()
    from osmnx._errors import InsufficientResponseError

    try:
        G = ox.graph_from_xml(file, bidirectional=True, simplify=False, retain_all=True)
    except InsufficientResponseError as e:
        raise NetworkError("V tomto výřezu nejsou v OpenStreetMap žádné pěší cesty." if downloaded
                           else "Soubor .osm neobsahuje žádné pěší cesty.") from e
    except Exception as e:  # noqa: BLE001 – we want to report the error clearly to the user
        where = "Stažená data z OpenStreetMap" if downloaded else "Soubor .osm"
        raise NetworkError(f"{where} se nepodařilo načíst: {e}") from e
    bad = [(u, v, k) for u, v, k, d in G.edges(keys=True, data=True) if not is_walkable(d)]
    G.remove_edges_from(bad)
    G.remove_nodes_from([n for n in list(G.nodes) if G.degree(n) == 0])
    if len(G.edges) == 0:
        raise NetworkError("V tomto výřezu nejsou v OpenStreetMap žádné pěší cesty." if downloaded
                           else "Soubor .osm neobsahuje žádné pěší cesty.")
    G = ox.simplify_graph(G)
    return G


def graph_bbox(G: nx.MultiDiGraph, margin_m: float = 0.0):
    """Extent of the graph in WGS84 including edge geometries (not just nodes), optionally with a margin."""
    xs = [d["x"] for _, d in G.nodes(data=True)]
    ys = [d["y"] for _, d in G.nodes(data=True)]
    for _, _, d in G.edges(data=True):
        g = d.get("geometry")
        if g is not None:
            x0, y0, x1, y1 = g.bounds
            xs += [x0, x1]
            ys += [y0, y1]
    bbox = (min(xs), min(ys), max(xs), max(ys))
    return expand_bbox(*bbox, margin_m) if margin_m else bbox


def process_osm_graph(G_raw: nx.MultiDiGraph, bbox=None, segment_length: float = 10.0, info=None) -> WalkingNetwork:
    """Turns an osmnx graph (WGS84, directed) into a :class:`WalkingNetwork` in UTM."""
    ox = _configure_osmnx()
    G = G_raw.copy()
    # safety net: the same rule as in the Overpass query
    bad = [(u, v, k) for u, v, k, d in G.edges(keys=True, data=True) if not is_walkable(d)]
    G.remove_edges_from(bad)
    G.remove_nodes_from([n for n in list(G.nodes) if G.degree(n) == 0])
    if len(G.edges) == 0:
        raise NetworkError("Načtená síť neobsahuje žádné pěší cesty.")
    if bbox is None:
        bbox = graph_bbox(G, margin_m=50)
    crs = utm_crs((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
    Gp = ox.projection.project_graph(G, to_crs=crs)
    Gu = ox.convert.to_undirected(Gp)
    tr = Transformer.from_crs(4326, crs, always_xy=True)
    w, s, e, n = bbox
    lon = np.array([w, e, e, w])
    lat = np.array([s, s, n, n])
    px, py = tr.transform(lon, lat)
    area = Polygon(zip(px, py))
    info = dict(info or {})
    info["bbox"] = list(bbox)
    info["crs"] = crs.to_string()
    return build_network(Gu, crs, segment_length=segment_length, area=area, info=info)
