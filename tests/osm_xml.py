"""Generator of simple .osm files for tests (no internet access)."""

from __future__ import annotations

import math
from xml.sax.saxutils import quoteattr

# The made-up "village Test" lies in the fields between Dřínov (50.2736 N, 14.3975 E) and Netřeba
# (stop 50.260 N, 14.421 E): its centre is halfway between the two villages and it is rotated
# by 48° so that its longer axis runs across the line between them – it reaches neither village.
# Names and tags below are OSM data (street names like "Ulice A" stay as they are).
LAT0, LON0 = 50.2668, 14.4093
ROTATION_DEG = 48.0


def m_to_ll(dx: float, dy: float) -> tuple[float, float]:
    """Metres from the centre of the made-up village (x east, y north, before rotation) -> (lat, lon)."""
    u = math.radians(ROTATION_DEG)
    east = dx * math.cos(u) - dy * math.sin(u)
    north = dx * math.sin(u) + dy * math.cos(u)
    lat = LAT0 + north / 111_320.0
    lon = LON0 + east / (111_320.0 * math.cos(math.radians(LAT0)))
    return lat, lon


def osm_xml(ways: list[tuple[list[tuple[float, float]], dict]], points=()) -> str:
    """ways: [([(dx, dy), ...] in metres from the centre, {tags})]; points: [((dx, dy), {tags})].

    Points with the same coordinates share a node; a closed way has the same first and last point.
    """
    nodes: dict[tuple[float, float], int] = {}
    node_lines, way_lines = [], []

    def node(p, tags=None):
        key = (round(p[0], 3), round(p[1], 3))
        if key not in nodes or tags:
            nid = len(node_lines) + 1
            if not tags:
                nodes[key] = nid
            lat, lon = m_to_ll(*key)
            tg = "".join(f"\n    <tag k={quoteattr(k)} v={quoteattr(v)}/>" for k, v in (tags or {}).items())
            if tg:
                node_lines.append(f'  <node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}">{tg}\n  </node>')
            else:
                node_lines.append(f'  <node id="{nid}" version="1" lat="{lat:.7f}" lon="{lon:.7f}"/>')
            return nid
        return nodes[key]

    for wid, (way_points, tags) in enumerate(ways, start=1):
        refs = [node(p) for p in way_points]
        nd = "".join(f'\n    <nd ref="{r}"/>' for r in refs)
        tg = "".join(f"\n    <tag k={quoteattr(k)} v={quoteattr(v)}/>" for k, v in tags.items())
        way_lines.append(f'  <way id="{wid}" version="1">{nd}{tg}\n  </way>')
    for p, tags in points:
        node(p, tags)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="test">\n'
        + "\n".join(node_lines + way_lines)
        + "\n</osm>\n"
    )


def square(cx, cy, a):
    return [(cx - a, cy - a), (cx + a, cy - a), (cx + a, cy + a), (cx - a, cy + a), (cx - a, cy - a)]


def village_basemap():
    """Vector basemap features of the made-up village Test: buildings, pond, stream, forest, railway, place."""
    ways = []
    for i, (x, y) in enumerate([(-250, 40), (-200, 40), (-150, 40), (60, 40), (120, 40), (60, -60), (250, -260),
                                 (350, 260), (-350, -250), (-450, 250)]):
        ways.append((square(x, y, 12), {"building": "house" if i % 2 else "yes"}))
    ways.append((square(150, 150, 40), {"natural": "water", "name": "Rybník Test"}))
    ways.append(([(-900, 450), (-300, 480), (200, 470), (900, 520)], {"waterway": "stream", "name": "Potok Test"}))
    ways.append(([(-850, -750), (-500, -750), (-500, -450), (-850, -450), (-850, -750)], {"landuse": "forest"}))
    ways.append(([(400, -200), (550, -200), (550, -100), (400, -100), (400, -200)], {"leisure": "park"}))
    ways.append(([(-900, -650), (900, -620)], {"railway": "rail"}))
    points = [((0, 30), {"place": "village", "name": "Test"})]
    return ways, points


def village() -> list[tuple[list[tuple[float, float]], dict]]:
    """The made-up "village Test": a street grid, footpaths, a cycleway and a few forbidden ways."""
    c = []
    # through road west–east
    c.append(([(-900, 0), (-450, 10), (0, 0), (450, -15), (900, 0)], {"highway": "secondary", "name": "Ulice A"}))
    # road north–south
    c.append(([(0, -700), (0, -300), (0, 0)], {"highway": "tertiary", "name": "Ulice B"}))
    c.append(([(0, 0), (20, 300), (0, 650)], {"highway": "tertiary"}))
    # local streets (grid)
    for y in (-300, 300):
        c.append(([(-600, y), (-300, y), (0 if y < 0 else 20, y), (300, y), (600, y)],
                  {"highway": "residential", "name": "Ulice C" if y < 0 else "Ulice D"}))
    for x in (-300, 300):
        c.append(([(x, -300), (x, 0)], {"highway": "residential"}))
        c.append(([(x, 0), (x, 300)], {"highway": "residential"}))
    c.append(([(-600, -300), (-600, 300)], {"highway": "residential"}))
    c.append(([(600, -300), (600, 0), (600, 300)], {"highway": "unclassified"}))
    # footpaths and field tracks
    c.append(([(-300, 0), (-150, 150), (0, 300)], {"highway": "footway"}))
    c.append(([(300, 300), (450, 500), (600, 650), (0, 650)], {"highway": "track"}))
    c.append(([(-600, 300), (-450, 550), (0, 650)], {"highway": "path"}))
    # cycleway without a foot tag (osmnx "walk" would drop it, we keep it)
    c.append(([(600, 0), (750, -150), (900, 0)], {"highway": "cycleway"}))
    # pedestrian zone access=no, foot=yes – kept
    c.append(([(-300, -300), (-150, -150), (0, -300)], {"highway": "pedestrian", "access": "no", "foot": "yes"}))
    # forbidden: cycleway foot=no, private road, motorway, private service road
    c.append(([(-600, -300), (-750, -500), (-900, -600)], {"highway": "cycleway", "foot": "no"}))
    c.append(([(300, -300), (450, -450), (600, -600)], {"highway": "service", "access": "private"}))
    c.append(([(-900, -800), (900, -800)], {"highway": "motorway"}))
    c.append(([(600, -300), (750, -450)], {"highway": "service", "service": "private"}))
    return c


def overpass_json(ways, keep=None) -> dict:
    """Overpass API response in JSON (to substitute for real downloading)."""
    nodes: dict[tuple[float, float], int] = {}
    node_elems, way_elems = [], []
    for wid, (pts, tags) in enumerate(ways, start=1):
        if keep is not None and not keep(tags):
            continue
        refs = []
        for p in pts:
            key = (round(p[0], 3), round(p[1], 3))
            if key not in nodes:
                nodes[key] = len(nodes) + 1
                lat, lon = m_to_ll(*key)
                node_elems.append({"type": "node", "id": nodes[key], "lat": lat, "lon": lon})
            refs.append(nodes[key])
        way_elems.append({"type": "way", "id": wid, "nodes": refs, "tags": dict(tags)})
    return {"elements": node_elems + way_elems}
