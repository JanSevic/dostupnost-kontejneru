"""Generates data for the parity test of the web (JS) and desktop (Python) versions: the made-up village Test.

Usage (from the project root): python tests/generate_web_parity.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
import osmnx as ox  # noqa: E402
from pyproj import Transformer  # noqa: E402

from container_access.compute import compute_type  # noqa: E402
from container_access.network import graph_bbox, load_osm_xml, process_osm_graph  # noqa: E402
from tests.osm_xml import m_to_ll, osm_xml, village, village_basemap  # noqa: E402

target = ROOT / "web" / "tests" / "data"
target.mkdir(parents=True, exist_ok=True)
ways, points = village_basemap()
osm = target / "village_test.osm"
osm.write_text(osm_xml(village() + ways, points), encoding="utf-8")

G = load_osm_xml(osm)
bbox = graph_bbox(G, margin_m=50)
net = process_osm_graph(G, bbox=bbox)
Gu = ox.convert.to_undirected(ox.projection.project_graph(G, to_crs=net.crs))
nodes = list(Gu.nodes)
containers = [(5, 5), (-300, 290), (300, -290), (310, 310)]
ll = [m_to_ll(*c) for c in containers]
tr = Transformer.from_crs(4326, net.crs, always_xy=True)
xy = np.array([tr.transform(lon, lat) for lat, lon in ll])
r = compute_type(net, "plast", xy, list(range(1, len(xy) + 1)))
json.dump({
    "bbox": list(bbox),
    "containers": [{"id": i + 1, "lat": lat, "lon": lon} for i, (lat, lon) in enumerate(ll)],
    "nodes": {str(nodes[i]): round(float(d), 3) for i, d in enumerate(r.d_nodes) if np.isfinite(d)},
    "length_km": round(net.length_km, 4),
}, open(target / "parity.json", "w"), indent=1)
print("done", len(nodes), "nodes")
