"""Exports of the result map: standalone HTML, PNG for print (A4) and GeoPackage for QGIS.

Layer and attribute names in the GeoPackage stay Czech – users see them in QGIS.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np

from . import tiles as tl
from .compute import band, band_label
from .config import OSM_ATTRIBUTION, SUMMARY_KEY
from .network import WalkingNetwork

ATTRIBUTION = OSM_ATTRIBUTION
SUMMARY_NAME = "Všechny typy"
SUMMARY_CAPTION = "nejdelší z cest k nejbližším kontejnerům jednotlivých typů"


def _nan(d: np.ndarray) -> np.ndarray:
    d = np.asarray(d, dtype=float).copy()
    d[~np.isfinite(d)] = np.nan
    return d


def layer_name(key: str, types: list[dict]) -> str:
    if key == SUMMARY_KEY:
        return SUMMARY_NAME
    for t in types:
        if t["key"] == key:
            return t["name"]
    return key


# ---------------------------------------------------------------------------
# GeoPackage
# ---------------------------------------------------------------------------


def segments_gdf(net: WalkingNetwork, results: dict, summary_d, bands: list[float]):
    import geopandas as gpd
    from shapely.geometry import LineString

    data = {"delka_m": np.round(net.segment_length, 2)}
    columns = list(results.items())
    if summary_d is not None:
        columns.append((SUMMARY_KEY, summary_d))
    for key, d in columns:
        data[f"d_{key}"] = np.round(_nan(d), 1)
        data[f"pasmo_{key}"] = [band_label(band(x, bands), bands) for x in d]
    geom = [LineString(c) for c in net.segment_coords]
    return gpd.GeoDataFrame(data, geometry=geom, crs=net.crs)


def containers_gdf(net: WalkingNetwork, fc: dict, types: list[dict], snaps: dict):
    import geopandas as gpd
    from shapely.geometry import Point

    names = {t["key"]: t["name"] for t in types}
    tr = net.from_wgs()
    rows, geom = [], []
    for f in fc["features"]:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        x, y = tr.transform(lon, lat)
        info = snaps.get(p["id"], {})
        status = []
        if info.get("outside"):
            status.append("mimo načtenou síť")
        if info.get("long_connection"):
            status.append("daleko od cesty")
        if info.get("isolated"):
            status.append("izolovaný kousek cesty")
        rows.append({
            "id": int(p["id"]),
            "typ": p["typ"],
            "typ_nazev": names.get(p["typ"], p["typ"]),
            "poznamka": p.get("poznamka") or "",
            "pripojeni_m": info.get("connection_m"),
            "varovani": ", ".join(status),
        })
        geom.append(Point(x, y))
    import pandas as pd

    df = pd.DataFrame(rows, columns=["id", "typ", "typ_nazev", "poznamka", "pripojeni_m", "varovani"])
    return gpd.GeoDataFrame(df, geometry=geom, crs=net.crs)


def export_gpkg(path: Path, net: WalkingNetwork, fc: dict, types: list[dict], results: dict, summary_d,
                bands: list[float], snaps: dict) -> Path:
    path = Path(path)
    if path.exists():
        path.unlink()
    containers_gdf(net, fc, types, snaps).to_file(path, layer="kontejnery", driver="GPKG")
    segments_gdf(net, results, summary_d, bands).to_file(path, layer="sit_vzdalenosti", driver="GPKG")
    return path


# ---------------------------------------------------------------------------
# HTML (works without internet: Leaflet, data and the vector basemap are embedded)
# ---------------------------------------------------------------------------


def _json_for_script(data) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def _d_list(d) -> list:
    return [None if not math.isfinite(x) else round(float(x), 1) for x in d]


def tiles_size_estimate(folder: Path | None) -> int:
    """How many bytes stored tiles add to the HTML (base64 ≈ 4/3 of the size)."""
    if not folder or not Path(folder).exists():
        return 0
    return int(tl.folder_size(folder) * 4 / 3) + 60 * sum(1 for _ in Path(folder).rglob("*.png"))


def _embedded_tiles(folder: Path) -> dict:
    import base64

    result = {}
    for p in sorted(Path(folder).rglob("*.png")):
        try:
            z, x, y = int(p.parent.parent.name), int(p.parent.name), int(p.stem)
        except ValueError:
            continue
        result[f"{z}/{x}/{y}"] = "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()
    return result


def export_html(path: Path, net: WalkingNetwork, fc: dict, types: list[dict], results: dict, summary_d,
                settings: dict, title: str, layer: str | None, static_dir: Path, extent=None,
                basemap_fc: dict | None = None, tiles_folder: Path | None = None,
                embed_tiles: bool = False, attribution: str = ATTRIBUTION) -> Path:
    layers = list(results.keys()) + ([SUMMARY_KEY] if summary_d is not None else [])
    if not layers:
        raise ValueError("Není co exportovat – žádný typ nemá spočítaný výsledek.")
    if layer not in layers:
        layer = layers[0]
    data = {
        "title": title,
        "date": "Stav k " + datetime.now().strftime("%d. %m. %Y"),
        "attribution": attribution,
        "types": types,
        "settings": settings,
        "layers": layers,
        "layer": layer,
        "summary_key": SUMMARY_KEY,
        "segments": net.segments_wgs(),
        "results": {k: _d_list(d) for k, d in results.items()},
        "summary": _d_list(summary_d) if summary_d is not None else None,
        "containers": fc,
        "area": net.area_wgs(),
        "extent": extent,
        "basemap": {"type": "FeatureCollection", "features": (basemap_fc or {}).get("features", [])},
        "tiles": _embedded_tiles(tiles_folder) if (embed_tiles and tiles_folder) else None,
    }
    template = (static_dir / "export-template.html").read_text(encoding="utf-8")
    leaflet_css = (static_dir / "leaflet" / "leaflet.css").read_text(encoding="utf-8")
    leaflet_js = (static_dir / "leaflet" / "leaflet.js").read_text(encoding="utf-8")
    render_js = (static_dir / "render.js").read_text(encoding="utf-8")
    from html import escape

    # the title first; scripts and data last, so that nothing gets replaced inside them
    html = template.replace("__TITLE__", escape(title), 1)
    html = html.replace("/*__LEAFLET_CSS__*/", leaflet_css, 1)
    html = html.replace("/*__LEAFLET_JS__*/", leaflet_js.replace("</script", "<\\/script"), 1)
    html = html.replace("/*__RENDER_JS__*/", render_js, 1)
    html = html.replace("/*__DATA__*/null", _json_for_script(data), 1)
    path = Path(path)
    path.write_text(html, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# PNG (A4 landscape) – basemap only from stored tiles or vector data, never by downloading
# ---------------------------------------------------------------------------

A4_LANDSCAPE = (11.69, 8.27)  # inches

AREA_STYLE = {  # kind: (fill, edge, edge width)
    "green": ("#e1eed4", None, 0),
    "forest": ("#c9e0b8", None, 0),
    "water": ("#b8d6f0", "#9cc3e6", 0.3),
    "building": ("#ddd4ca", "#b9ada0", 0.25),
}
ROAD_STYLE = {  # class: (colour, casing, width in points, dash pattern)
    "major": ("#f7d39b", "#d39a52", 2.4, None),
    "street": ("#ffffff", "#c3bbb0", 2.0, None),
    "service": ("#ffffff", "#cdc6bc", 1.2, None),
    "track": ("#a8875c", None, 0.6, (0, (4, 3))),
    "path": ("#937c66", None, 0.5, (0, (1.5, 2))),
}


def _nice_length(m: float) -> float:
    candidates = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000]
    ok = [k for k in candidates if k <= m]
    return ok[-1] if ok else candidates[0]


def _rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))


def _continuous_color(d: float, mx: float):
    scale = [(0.0, (26, 152, 80)), (0.25, (145, 207, 96)), (0.5, (254, 224, 139)), (0.75, (252, 141, 89)), (1.0, (215, 48, 39))]
    if d > mx:
        return _rgb("#a50026")
    t = max(0.0, d / mx)
    for (t0, c0), (t1, c1) in zip(scale[:-1], scale[1:]):
        if t <= t1:
            f = (t - t0) / (t1 - t0)
            return tuple((a + f * (b - a)) / 255 for a, b in zip(c0, c1))
    return tuple(v / 255 for v in scale[-1][1])


def segment_colors(d: np.ndarray, settings: dict) -> list:
    unreachable = _rgb(settings["unreachable_color"])
    if settings.get("mode") == "continuous":
        mx = float(settings["continuous_max_m"])
        return [unreachable if not math.isfinite(x) else _continuous_color(x, mx) for x in d]
    bands = settings["bands"]
    colors = [_rgb(b) for b in settings["band_colors"]]
    return [unreachable if (i := band(x, bands)) < 0 else colors[i] for x in d]


def _geom_3857(geom: dict, tr):
    """GeoJSON geometry (WGS84) -> shapely in EPSG:3857."""
    from shapely.geometry import shape
    from shapely.ops import transform

    return transform(tr, shape(geom))


def _area_path(g):
    from matplotlib.path import Path as MPath

    polygons = [g] if g.geom_type == "Polygon" else list(getattr(g, "geoms", []))
    vertices, codes = [], []
    for p in polygons:
        if p.geom_type != "Polygon" or p.is_empty:
            continue
        for ring in [p.exterior, *p.interiors]:
            c = np.asarray(ring.coords)[:, :2]
            if len(c) < 3:
                continue
            vertices.append(c)
            codes.append([MPath.MOVETO] + [MPath.LINETO] * (len(c) - 2) + [MPath.CLOSEPOLY])
    if not vertices:
        return None
    return MPath(np.concatenate(vertices), np.concatenate(codes))


def _lines(g) -> list:
    if g.geom_type == "LineString":
        return [np.asarray(g.coords)[:, :2]]
    return [np.asarray(c.coords)[:, :2] for c in getattr(g, "geoms", []) if c.geom_type == "LineString"]


def draw_vector_basemap(ax, basemap_fc: dict, text_zoom: float = 1.0):
    """Draws the vector basemap (GeoJSON in WGS84) into axes in EPSG:3857."""
    from matplotlib.collections import LineCollection, PathCollection
    from pyproj import Transformer

    tr = Transformer.from_crs(4326, 3857, always_xy=True).transform
    areas = {k: [] for k in AREA_STYLE}
    roads = {k: [] for k in ROAD_STYLE}
    streams, railways, labels = [], [], []
    for f in basemap_fc.get("features", []):
        p = f.get("properties", {})
        k = p.get("k")
        if k in ("label", "place"):
            x, y = tr(*f["geometry"]["coordinates"][:2])
            labels.append((x, y, p))
            continue
        g = _geom_3857(f["geometry"], tr)
        if k in areas:
            path = _area_path(g)
            if path is not None:
                areas[k].append(path)
        elif k == "road":
            roads.setdefault(p.get("t") or "service", []).extend(_lines(g))
        elif k == "stream":
            streams.append((p.get("t"), _lines(g)))
        elif k == "railway":
            railways.extend(_lines(g))
    for k, paths in areas.items():
        if paths:
            fill, edge, w = AREA_STYLE[k]
            ax.add_collection(PathCollection(paths, facecolors=fill, edgecolors=edge or "none", linewidths=w,
                                             zorder=1))
    for t, lines in streams:
        ax.add_collection(LineCollection(lines, colors="#8ab8de", linewidths=1.4 if t in ("river", "canal") else 0.7,
                                         zorder=1.2))
    for t in ("path", "track", "service", "street", "major"):
        lines = roads.get(t) or []
        if not lines:
            continue
        color, casing, w, dash = ROAD_STYLE[t]
        if casing:
            ax.add_collection(LineCollection(lines, colors=casing, linewidths=w + 0.8, capstyle="round", zorder=1.3))
        ax.add_collection(LineCollection(lines, colors=color, linewidths=w, linestyles=dash or "solid",
                                         capstyle="round", zorder=1.4))
    if railways:
        ax.add_collection(LineCollection(railways, colors="#7b7b7b", linewidths=1.0, zorder=1.5))
    x0, x1 = ax.get_xlim()
    y0, y1 = ax.get_ylim()
    shift = (x1 - x0) / 700  # street label slightly above the road axis so the walking network does not cover it
    for x, y, p in labels:
        if p.get("k") == "label":
            angle = math.radians(p.get("a", 0))
            x, y = x - math.sin(angle) * shift, y + math.cos(angle) * shift
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            continue
        if p.get("k") == "place":
            ax.text(x, y, p.get("n", ""), ha="center", va="center", fontsize=11 * text_zoom, fontweight="bold",
                    color="#2b2f35", zorder=5.2, clip_on=True,
                    path_effects=[_halo()])
        else:
            ax.text(x, y, p.get("n", ""), ha="center", va="center", fontsize=5.5 * text_zoom, color="#4b5057",
                    rotation=p.get("a", 0), rotation_mode="anchor", zorder=5.1, clip_on=True,
                    path_effects=[_halo()])


def _halo():
    import matplotlib.patheffects as pe

    return pe.withStroke(linewidth=2, foreground="white")


def export_png(path: Path, net: WalkingNetwork, fc: dict, types: list[dict], d: np.ndarray, layer: str,
               settings: dict, title: str, extent=None, basemap: str = "auto", basemap_fc: dict | None = None,
               tiles_folder: Path | None = None, attribution: str = ATTRIBUTION, tiles_attribution: str = "",
               dpi: int = 300) -> list[str]:
    """Draws one layer into an A4 landscape PNG. Returns a list of warnings.

    basemap: "auto" (stored tiles, otherwise vector), "tiles", "vector", "none".
    """
    from matplotlib.collections import LineCollection
    from matplotlib.figure import Figure  # no pyplot – safe for concurrent exports
    from matplotlib.lines import Line2D
    from matplotlib.patches import Rectangle
    from pyproj import Transformer

    warnings = []
    tr = Transformer.from_crs(net.crs, 3857, always_xy=True)
    allc = np.concatenate(net.segment_coords)
    mx, my = tr.transform(allc[:, 0], allc[:, 1])
    m3857 = np.column_stack([mx, my])
    segments, i = [], 0
    for c in net.segment_coords:
        segments.append(m3857[i : i + len(c)])
        i += len(c)

    # map extent
    tr_wgs = Transformer.from_crs(4326, 3857, always_xy=True)
    if extent:
        x0, y0 = tr_wgs.transform(extent[0], extent[1])
        x1, y1 = tr_wgs.transform(extent[2], extent[3])
    else:
        x0, y0 = m3857.min(axis=0)
        x1, y1 = m3857.max(axis=0)

    fig = Figure(figsize=A4_LANDSCAPE, dpi=dpi)
    ax_map = fig.add_axes((0.025, 0.04, 0.70, 0.83))
    ax_leg = fig.add_axes((0.745, 0.04, 0.23, 0.83))
    ax_leg.axis("off")

    # fit the aspect ratio of the map frame
    width_in = A4_LANDSCAPE[0] * 0.70
    height_in = A4_LANDSCAPE[1] * 0.83
    ratio = width_in / height_in
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w, h = abs(x1 - x0), abs(y1 - y0)
    if w / max(h, 1e-9) > ratio:
        h = w / ratio
    else:
        w = h * ratio
    ax_map.set_xlim(cx - w / 2, cx + w / 2)
    ax_map.set_ylim(cy - h / 2, cy + h / 2)
    ax_map.set_xticks([])
    ax_map.set_yticks([])
    ax_map.set_facecolor("#f4f2ee" if basemap != "none" else "white")
    for s_ in ax_map.spines.values():
        s_.set_edgecolor("#444")
        s_.set_linewidth(0.8)

    used = []
    if basemap in ("auto", "tiles", "vector"):
        # the vector basemap is the base – stored tiles are drawn over it (where they are missing, the vector shows)
        if basemap_fc and basemap_fc.get("features"):
            draw_vector_basemap(ax_map, basemap_fc)
            used.append("vektorová data OSM")
        elif basemap == "vector" or not tiles_folder:
            warnings.append("Oblast nemá vektorový podklad – PNG je bez podkladu.")
    if basemap in ("auto", "tiles") and tiles_folder:
        target_zoom = tl.zoom_for_resolution(w, width_in * dpi)
        mos = tl.mosaic(tiles_folder, cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, target_zoom)
        if mos is not None:
            image, ext, z, coverage = mos
            ax_map.imshow(image, extent=ext, interpolation="bilinear", alpha=0.75, zorder=1.8)
            used.insert(0, f"uložené dlaždice (zoom {z})")
            if coverage < 0.999 and basemap == "tiles":
                warnings.append("Uložené dlaždice výřez nepokrývají celý – zbytek je z vektorového podkladu.")
            if tiles_attribution and tiles_attribution not in attribution:
                attribution = f"{attribution}; dlaždice {tiles_attribution}"
        elif basemap == "tiles":
            warnings.append("Pro tento výřez nejsou uložené dostatečně podrobné dlaždice – použit vektorový podklad.")
    used_basemap = " + ".join(used) if used else "žádný"
    ax_map.set_xlim(cx - w / 2, cx + w / 2)
    ax_map.set_ylim(cy - h / 2, cy + h / 2)

    colors = segment_colors(d, settings)
    order = np.argsort(np.where(np.isfinite(d), 0, -1), kind="stable")  # draw unreachable first
    seg_sorted = [segments[i] for i in order]
    ax_map.add_collection(LineCollection(seg_sorted, colors="white", linewidths=3.2, capstyle="round", zorder=3))
    ax_map.add_collection(LineCollection(seg_sorted, colors=[colors[i] for i in order], linewidths=2.0,
                                         capstyle="round", zorder=4))

    # containers
    types_by_key = {t["key"]: t for t in types}
    for f in fc["features"]:
        p = f["properties"]
        if layer != SUMMARY_KEY and p["typ"] != layer:
            continue
        t = types_by_key.get(p["typ"], {"color": "#555555", "abbr": "?"})
        x, y = tr_wgs.transform(*f["geometry"]["coordinates"][:2])
        ax_map.scatter([x], [y], s=95, c=[t["color"]], edgecolors="#222", linewidths=0.8, zorder=6)
        brightness = sum(a * b for a, b in zip(_rgb(t["color"]), (0.299, 0.587, 0.114)))
        ax_map.text(x, y, t["abbr"], ha="center", va="center", fontsize=4.6, fontweight="bold",
                    color="#222" if brightness > 0.63 else "white", zorder=7)

    # scale bar (in Mercator lengths are stretched by 1/cos(lat))
    lat_mid = Transformer.from_crs(3857, 4326, always_xy=True).transform(cx, cy)[1]
    k = 1 / math.cos(math.radians(lat_mid))
    length_m = _nice_length(w / k / 5)
    sx, sy = cx - w / 2 + w * 0.03, cy - h / 2 + h * 0.035
    ax_map.add_patch(Rectangle((sx - w * 0.01, sy - h * 0.018), length_m * k + w * 0.02, h * 0.06,
                               facecolor="white", alpha=0.85, edgecolor="none", zorder=8))
    ax_map.plot([sx, sx + length_m * k], [sy, sy], color="#222", linewidth=2.2, zorder=9, solid_capstyle="butt")
    for xx in (sx, sx + length_m * k):
        ax_map.plot([xx, xx], [sy - h * 0.006, sy + h * 0.006], color="#222", linewidth=1.2, zorder=9)
    label_m = f"{length_m / 1000:g} km" if length_m >= 1000 else f"{length_m:g} m"
    ax_map.text(sx + length_m * k / 2, sy + h * 0.012, label_m, ha="center", va="bottom", fontsize=8, zorder=9)

    # north arrow
    ax_map.annotate("S", xy=(0.965, 0.955), xytext=(0.965, 0.885), xycoords="axes fraction",
                    ha="center", va="center", fontsize=10, fontweight="bold",
                    arrowprops=dict(arrowstyle="-|>", color="#222", lw=1.4), zorder=9)

    # attribution in the map (always)
    ax_map.text(0.995, 0.005, attribution, transform=ax_map.transAxes, ha="right", va="bottom", fontsize=6.5,
                bbox=dict(facecolor="white", alpha=0.8, edgecolor="none", pad=1.5), zorder=9)

    # title and date
    name = layer_name(layer, types)
    fig.text(0.025, 0.955, title, fontsize=17, fontweight="bold", va="center")
    fig.text(0.025, 0.905, f"{name} · stav k {datetime.now().strftime('%d. %m. %Y')}", fontsize=11, color="#333",
             va="center")

    # legend
    y = 1.0
    ax_leg.text(0, y, "Legenda", fontsize=12, fontweight="bold", va="top", transform=ax_leg.transAxes)
    y -= 0.06
    caption = SUMMARY_CAPTION if layer == SUMMARY_KEY else "vzdálenost po pěších cestách k nejbližšímu kontejneru"
    ax_leg.text(0, y, f"{name}:\n{caption}", fontsize=8.5, va="top", transform=ax_leg.transAxes, wrap=True)
    y -= 0.10
    bands = settings["bands"]
    if settings.get("mode") == "continuous":
        mxm = float(settings["continuous_max_m"])
        grad = np.linspace(0, mxm, 100)
        for j, g in enumerate(grad):
            ax_leg.add_patch(Rectangle((j * 0.008, y - 0.03), 0.008, 0.03, transform=ax_leg.transAxes,
                                       color=_continuous_color(g, mxm)))
        ax_leg.text(0, y - 0.035, "0 m", fontsize=8, va="top", transform=ax_leg.transAxes)
        ax_leg.text(0.8, y - 0.035, f"{mxm:g} m+", fontsize=8, va="top", ha="right", transform=ax_leg.transAxes)
        y -= 0.09
        items = []
    else:
        items = [(settings["band_colors"][i], band_label(i, bands)) for i in range(len(bands) + 1)]
    items.append((settings["unreachable_color"], "nedosažitelné"))
    lengths = net.segment_length
    total = lengths.sum()
    for color, text in items:
        ax_leg.add_line(Line2D([0.0, 0.12], [y - 0.012, y - 0.012], transform=ax_leg.transAxes, color=color,
                               linewidth=4, solid_capstyle="round"))
        ax_leg.text(0.16, y - 0.012, text, fontsize=9.5, va="center", transform=ax_leg.transAxes)
        y -= 0.045
    # share of network length per band
    y -= 0.02
    ax_leg.text(0, y, "Délka sítě v pásmech", fontsize=9.5, fontweight="bold", va="top", transform=ax_leg.transAxes)
    y -= 0.04
    idx = np.array([band(x, bands) for x in d])
    for i in list(range(len(bands) + 1)) + [-1]:
        km = lengths[idx == i].sum() / 1000
        share = (lengths[idx == i].sum() / total * 100) if total else 0
        ax_leg.text(0, y, band_label(i, bands), fontsize=8.5, va="top", transform=ax_leg.transAxes)
        ax_leg.text(1.0, y, f"{km:.2f} km ({share:.0f} %)".replace(".", ","), fontsize=8.5, va="top", ha="right",
                    transform=ax_leg.transAxes)
        y -= 0.035
    # containers in the legend
    y -= 0.02
    ax_leg.text(0, y, "Kontejnery", fontsize=9.5, fontweight="bold", va="top", transform=ax_leg.transAxes)
    y -= 0.045
    counts = {}
    for f in fc["features"]:
        counts[f["properties"]["typ"]] = counts.get(f["properties"]["typ"], 0) + 1
    shown = types if layer == SUMMARY_KEY else [t for t in types if t["key"] == layer]
    for t in shown:
        ax_leg.scatter([0.05], [y - 0.01], s=70, c=[t["color"]], edgecolors="#222", linewidths=0.8,
                       transform=ax_leg.transAxes, clip_on=False)
        ax_leg.text(0.16, y - 0.01, f"{t['name']} ({counts.get(t['key'], 0)}×)", fontsize=9, va="center",
                    transform=ax_leg.transAxes)
        y -= 0.042
    # sources
    ax_leg.text(0, 0.0, f"Data: {attribution}\nPodklad: {used_basemap}\nVýpočet: nejkratší cesta po síti pěších cest\n"
                "(výsledek závisí na úplnosti cest v OSM)",
                fontsize=7, color="#444", va="bottom", transform=ax_leg.transAxes)

    fig.savefig(path, dpi=dpi)
    return warnings
