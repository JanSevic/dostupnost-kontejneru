"""Vector basemap from OpenStreetMap data (for offline display and exports).

OSM data (ODbL licence) may be stored and used offline – unlike raster tiles from
tile.openstreetmap.org. The basemap is downloaded via the Overpass API (or read from an
.osm file), sorted into a few kinds, clipped to the area, simplified and stored as compact GeoJSON.

Feature properties: ``k`` = kind, ``t`` = subtype, ``n`` = name,
``a`` = label angle in degrees (street labels only). Same codes as web/js/osm.js.
"""

from __future__ import annotations

import math

from pyproj import Transformer
from shapely import set_precision
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box, mapping
from shapely.ops import linemerge, transform

from .network import NetworkError, utm_crs

TAGS = {
    "building": True,
    "highway": True,
    "railway": ["rail", "light_rail", "narrow_gauge", "tram", "subway"],
    "waterway": ["river", "stream", "canal", "ditch", "drain", "riverbank"],
    "water": True,
    "natural": ["water", "wood", "scrub", "wetland", "grassland", "heath"],
    "landuse": [
        "forest", "grass", "meadow", "orchard", "vineyard", "recreation_ground", "village_green",
        "allotments", "cemetery", "reservoir", "basin", "plant_nursery",
    ],
    "leisure": ["park", "garden", "pitch", "playground"],
    "place": ["city", "town", "village", "hamlet", "suburb", "neighbourhood", "quarter", "isolated_dwelling"],
}

# drawing order (bottom up)
ORDER = ["green", "forest", "water", "stream", "building", "road", "railway", "label", "place"]

ROAD_CLASSES = {
    "major": {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
              "secondary", "secondary_link", "tertiary", "tertiary_link"},
    "street": {"residential", "unclassified", "living_street", "road"},
    "service": {"service"},
    "track": {"track"},
    "path": {"footway", "path", "steps", "pedestrian", "cycleway", "bridleway", "corridor"},
}
GREEN_LANDUSE = {"grass", "meadow", "orchard", "vineyard", "recreation_ground", "village_green", "allotments",
                 "cemetery", "plant_nursery"}
GREEN_NATURAL = {"scrub", "wetland", "grassland", "heath"}
GREEN_LEISURE = {"park", "garden", "pitch", "playground"}
STREAMS = {"river", "stream", "canal", "ditch", "drain"}
RAILWAYS = {"rail", "light_rail", "narrow_gauge", "tram", "subway"}
PLACES = set(TAGS["place"])


def _value(row, key):
    v = row.get(key) if hasattr(row, "get") else None
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    if isinstance(v, (list, tuple)):
        v = v[0] if v else None
    return None if v is None else str(v)


def road_class(highway: str | None) -> str | None:
    for cls, values in ROAD_CLASSES.items():
        if highway in values:
            return cls
    return None


def classify(tags, geom) -> tuple[str, str | None] | None:
    """Assigns an OSM feature to a basemap kind. Returns (kind, subtype) or None."""
    area = isinstance(geom, (Polygon, MultiPolygon))
    line = isinstance(geom, (LineString, MultiLineString))
    point = isinstance(geom, Point)
    g = lambda k: _value(tags, k)  # noqa: E731

    if point:
        if g("place") in PLACES and g("name"):
            return "place", g("place")
        return None
    if area:
        building = g("building")
        if building and building != "no":
            return "building", None
        if g("natural") == "water" or g("water") or g("landuse") in ("reservoir", "basin") or g("waterway") == "riverbank":
            return "water", None
        if g("landuse") == "forest" or g("natural") == "wood":
            return "forest", None
        if g("landuse") in GREEN_LANDUSE or g("natural") in GREEN_NATURAL or g("leisure") in GREEN_LEISURE:
            return "green", g("landuse") or g("leisure") or g("natural")
        return None
    if line:
        if g("highway"):
            cls = road_class(g("highway"))
            return ("road", cls) if cls else None
        if g("railway") in RAILWAYS:
            return "railway", g("railway")
        if g("waterway") in STREAMS:
            return "stream", g("waterway")
    return None


def _label_angle(line: LineString) -> tuple[Point, float]:
    """Midpoint of the line and the direction there (degrees, -90..90 for readability)."""
    d = line.length / 2
    p = line.interpolate(d)
    a = line.interpolate(max(d - 5, 0))
    b = line.interpolate(min(d + 5, line.length))
    angle = math.degrees(math.atan2(b.y - a.y, b.x - a.x))
    if angle > 90:
        angle -= 180
    elif angle < -90:
        angle += 180
    return p, angle


def process_features(gdf, bbox) -> dict:
    """GeoDataFrame of OSM features (WGS84) -> compact GeoJSON FeatureCollection of the basemap."""
    w, s, e, n = bbox
    crs = utm_crs((w + e) / 2, (s + n) / 2)
    to_utm = Transformer.from_crs(4326, crs, always_xy=True).transform
    to_wgs = Transformer.from_crs(crs, 4326, always_xy=True).transform
    clip = transform(to_utm, box(w, s, e, n))

    by_kind: dict[str, list] = {k: [] for k in ORDER}
    streets: dict[str, list] = {}
    if gdf is not None and len(gdf):
        for _, row in gdf.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            c = classify(row, geom)
            if c is None:
                continue
            kind, subtype = c
            gu = transform(to_utm, geom)
            if not gu.is_valid:
                gu = gu.buffer(0)
            gu = gu.intersection(clip)
            if gu.is_empty:
                continue
            if kind != "place":
                gu = gu.simplify(0.5, preserve_topology=True)
                if gu.is_empty:
                    continue
            props = {"k": kind}
            if subtype:
                props["t"] = subtype
            name = _value(row, "name")
            if name and kind in ("road", "place", "stream"):
                props["n"] = name
            if kind == "road" and name:
                lines = [gu] if isinstance(gu, LineString) else list(getattr(gu, "geoms", []))
                streets.setdefault(name, []).extend(x for x in lines if isinstance(x, LineString))
            gw = set_precision(transform(to_wgs, gu), 1e-6)
            if gw.is_empty:
                continue
            by_kind[kind].append({"type": "Feature", "geometry": mapping(gw), "properties": props})

    # street labels: one per name, on the longest continuous piece
    for name, lines in streets.items():
        merged = linemerge(lines)
        pieces = [merged] if isinstance(merged, LineString) else list(merged.geoms)
        longest = max(pieces, key=lambda x: x.length)
        if longest.length < 40:
            continue
        p, angle = _label_angle(longest)
        lon, lat = to_wgs(p.x, p.y)
        by_kind["label"].append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
            "properties": {"k": "label", "t": "street", "n": name, "a": round(angle, 1)},
        })

    features = [f for k in ORDER for f in by_kind[k]]
    summary = {k: len(by_kind[k]) for k in ORDER if by_kind[k]}
    return {"type": "FeatureCollection", "features": features, "summary": summary, "bbox": [w, s, e, n]}


def basemap_from_xml(file, bbox) -> dict:
    """Basemap from an .osm file."""
    from .network import _configure_osmnx

    ox = _configure_osmnx()
    from osmnx._errors import InsufficientResponseError

    try:
        gdf = ox.features_from_xml(file, tags=TAGS)
    except InsufficientResponseError:
        gdf = None
    except Exception as e:  # noqa: BLE001
        raise NetworkError(f"Podklad ze souboru .osm se nepodařilo načíst: {e}") from e
    return process_features(gdf, bbox)


def empty_basemap(bbox=None) -> dict:
    return {"type": "FeatureCollection", "features": [], "summary": {}, "bbox": list(bbox) if bbox else None}
