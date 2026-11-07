// OpenStreetMap data: Overpass API query, reading .osm files, walkable-way filter,
// walking network and vector basemap.
import { projectionForBbox } from "./geo.js";

// ------------------------------------------------------------------ walkable-way filter
const HIGHWAY_EXCLUDED = new Set(("abandoned bus_guideway busway construction motorway motorway_link no planned " +
  "platform proposed raceway razed rest_area services disused").split(" "));
const FOOT_YES = new Set(["yes", "designated", "permissive"]);
const FOOT_NO = new Set(["no", "private"]);
const ACCESS_NO = new Set(["no", "private"]);

/** Can pedestrians walk along a way with these tags? (same rule as the Python version) */
export function isWalkable(t) {
  const hw = (t.highway || "").trim().toLowerCase();
  if (!hw || HIGHWAY_EXCLUDED.has(hw)) return false;
  if ((t.area || "").toLowerCase() === "yes") return false;
  const foot = (t.foot || "").toLowerCase();
  if (FOOT_NO.has(foot)) return false;
  if (!FOOT_YES.has(foot)) {
    if (ACCESS_NO.has((t.access || "").toLowerCase())) return false;
    if ((t.service || "").toLowerCase() === "private") return false;
  }
  return true;
}

// ------------------------------------------------------------------ Overpass
export function overpassQuery([w, s, e, n]) {
  const b = `(${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)})`;
  return `[out:json][timeout:120];
(
  way["highway"]${b};
  way["building"]${b};
  way["railway"~"^(rail|light_rail|narrow_gauge|tram|subway)$"]${b};
  way["waterway"~"^(river|stream|canal|ditch|drain|riverbank)$"]${b};
  way["natural"~"^(water|wood|scrub|wetland|grassland|heath)$"]${b};
  relation["natural"~"^(water|wood|scrub|wetland)$"]${b};
  way["water"]${b};
  way["landuse"~"^(forest|grass|meadow|orchard|vineyard|recreation_ground|village_green|allotments|cemetery|reservoir|basin|plant_nursery)$"]${b};
  relation["landuse"~"^(forest|meadow|orchard|reservoir|basin)$"]${b};
  way["leisure"~"^(park|garden|pitch|playground)$"]${b};
  node["place"~"^(city|town|village|hamlet|suburb|neighbourhood|quarter|isolated_dwelling)$"]["name"]${b};
);
out geom;`;
}

/** Problem with the data or the data source; the message is shown to the user as is. */
export class DataError extends Error {}

/** Downloads data from the Overpass API. Returns normalised data (see fromJson). */
export async function fetchOverpass(bbox, url, signal) {
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      body: new URLSearchParams({ data: overpassQuery(bbox) }),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new DataError("Nepodařilo se spojit se serverem Overpass. Jsi připojený k internetu?");
  }
  if (r.status === 429 || r.status === 504) {
    throw new DataError(`Server Overpass je přetížený (HTTP ${r.status}). Zkus to za pár minut znovu.`);
  }
  if (!r.ok) throw new DataError(`Server Overpass odmítl dotaz (HTTP ${r.status}).`);
  let json;
  try {
    json = await r.json();
  } catch (e) {
    throw new DataError("Server Overpass vrátil neplatnou odpověď. Zkus to znovu.");
  }
  if (json.remark && /runtime error|timed out/i.test(json.remark)) {
    throw new DataError("Server Overpass dotaz nedokončil (" + json.remark.slice(0, 120) + "). Zkus menší oblast.");
  }
  return fromJson(json);
}

/**
 * Normalised data: { nodes: Map(id -> [lon, lat]), points: [{tags, ll}], ways: [{id, tags, nodes: [id], geom: [[lon,lat]]}],
 *   relations: [{id, tags, members: [{role, geom: [[lon,lat]]}]}] }
 */
export function fromJson(json) {
  const nodes = new Map();
  const points = [];
  const ways = [];
  const relations = [];
  for (const e of json.elements || []) {
    if (e.type === "node") {
      nodes.set(e.id, [e.lon, e.lat]);
      if (e.tags) points.push({ tags: e.tags, ll: [e.lon, e.lat] });
    } else if (e.type === "way") {
      const geom = (e.geometry || []).map((g) => (g ? [g.lon, g.lat] : null));
      const ids = e.nodes || [];
      ids.forEach((id, i) => { if (geom[i]) nodes.set(id, geom[i]); });
      ways.push({ id: e.id, tags: e.tags || {}, nodes: ids, geom: geom.filter(Boolean) });
    } else if (e.type === "relation") {
      const members = (e.members || []).filter((m) => m.type === "way" && m.geometry)
        .map((m) => ({ role: m.role || "outer", geom: m.geometry.filter(Boolean).map((g) => [g.lon, g.lat]) }));
      relations.push({ id: e.id, tags: e.tags || {}, members });
    }
  }
  // ways without geometry (e.g. JSON without "out geom") get it from their nodes
  for (const w of ways) if (!w.geom.length) w.geom = w.nodes.map((id) => nodes.get(id)).filter(Boolean);
  return { nodes, points, ways, relations };
}

function unescapeXml(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function attributes(s) {
  const a = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) a[m[1]] = unescapeXml(m[3] ?? m[4]);
  return a;
}

/** Reads an .osm file (XML from openstreetmap.org or JOSM). */
export function fromXml(text) {
  if (!/<osm[\s>]/.test(text)) throw new DataError("Soubor není ve formátu OSM XML (.osm).");
  const nodes = new Map();
  const points = [];
  const rawWays = new Map();
  const relations = [];
  const tagsOf = (inner) => {
    const t = {};
    for (const m of inner.matchAll(/<tag\b([^>]*?)\/?>/g)) {
      const a = attributes(m[1]);
      if (a.k !== undefined) t[a.k] = a.v ?? "";
    }
    return t;
  };
  for (const m of text.matchAll(/<node\b([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
    const a = attributes(m[1]);
    if (a.action === "delete" || a.visible === "false") continue;
    const ll = [parseFloat(a.lon), parseFloat(a.lat)];
    nodes.set(Number(a.id), ll);
    if (m[3]) {
      const t = tagsOf(m[3]);
      if (Object.keys(t).length) points.push({ tags: t, ll });
    }
  }
  for (const m of text.matchAll(/<way\b([^>]*?)>([\s\S]*?)<\/way>/g)) {
    const a = attributes(m[1]);
    if (a.action === "delete" || a.visible === "false") continue;
    const ids = [...m[2].matchAll(/<nd\b[^>]*?ref\s*=\s*["']([-\d]+)["']/g)].map((x) => Number(x[1]));
    rawWays.set(Number(a.id), { id: Number(a.id), tags: tagsOf(m[2]), nodes: ids });
  }
  for (const m of text.matchAll(/<relation\b([^>]*?)>([\s\S]*?)<\/relation>/g)) {
    const a = attributes(m[1]);
    const members = [];
    for (const c of m[2].matchAll(/<member\b([^>]*?)\/?>/g)) {
      const ca = attributes(c[1]);
      if (ca.type === "way" && rawWays.has(Number(ca.ref))) {
        members.push({ role: ca.role || "outer", geom: null, ref: Number(ca.ref) });
      }
    }
    relations.push({ id: Number(a.id), tags: tagsOf(m[2]), members });
  }
  const ways = [...rawWays.values()].map((w) => ({ ...w, geom: w.nodes.map((id) => nodes.get(id)).filter(Boolean) }));
  const byId = new Map(ways.map((w) => [w.id, w]));
  for (const r of relations) for (const m of r.members) m.geom = byId.get(m.ref).geom;
  if (!ways.length) throw new DataError("Soubor .osm neobsahuje žádné cesty.");
  return { nodes, points, ways, relations };
}

// ------------------------------------------------------------------ walking network
/**
 * Walking network from OSM data: { nodes: [[lon, lat]], edges: [[i, j]] } – every section between two
 * neighbouring nodes of a way is one (two-way) edge.
 */
export function walkingNetwork(data) {
  const index = new Map();
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const idx = (id) => {
    let i = index.get(id);
    if (i === undefined) {
      const ll = data.nodes.get(id);
      if (!ll) return undefined;
      i = nodes.length;
      index.set(id, i);
      nodes.push(ll);
    }
    return i;
  };
  for (const w of data.ways) {
    if (!isWalkable(w.tags)) continue;
    for (let k = 1; k < w.nodes.length; k++) {
      const a = idx(w.nodes[k - 1]), b = idx(w.nodes[k]);
      if (a === undefined || b === undefined || a === b) continue;
      const key = a < b ? a + "," + b : b + "," + a;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([a, b]);
    }
  }
  if (!edges.length) throw new DataError("V tomto území nejsou v OpenStreetMap žádné pěší cesty.");
  return { nodes, edges };
}

// ------------------------------------------------------------------ vector basemap
const ROAD_CLASSES = {
  major: "motorway motorway_link trunk trunk_link primary primary_link secondary secondary_link tertiary tertiary_link",
  street: "residential unclassified living_street road",
  service: "service",
  track: "track",
  path: "footway path steps pedestrian cycleway bridleway corridor",
};
const ROAD_CLASS = {};
for (const [c, s] of Object.entries(ROAD_CLASSES)) for (const h of s.split(" ")) ROAD_CLASS[h] = c;
const GREEN_LANDUSE = new Set("grass meadow orchard vineyard recreation_ground village_green allotments cemetery plant_nursery".split(" "));
const GREEN_NATURAL = new Set("scrub wetland grassland heath".split(" "));
const GREEN_LEISURE = new Set("park garden pitch playground".split(" "));
const STREAMS = new Set("river stream canal ditch drain".split(" "));
const RAILWAYS = new Set("rail light_rail narrow_gauge tram subway".split(" "));
const PLACES = new Set("city town village hamlet suburb neighbourhood quarter isolated_dwelling".split(" "));
export const BASEMAP_ORDER = ["green", "forest", "water", "stream", "building", "road", "railway", "label", "place"];

/** Basemap kind for an OSM element: [kind, subtype] or null. geometry: "point" | "area" | "line" */
export function classify(t, geometry) {
  if (geometry === "point") return PLACES.has(t.place) && t.name ? ["place", t.place] : null;
  if (geometry === "area") {
    if (t.building && t.building !== "no") return ["building", null];
    if (t.natural === "water" || t.water || t.landuse === "reservoir" || t.landuse === "basin" || t.waterway === "riverbank") return ["water", null];
    if (t.landuse === "forest" || t.natural === "wood") return ["forest", null];
    if (GREEN_LANDUSE.has(t.landuse) || GREEN_NATURAL.has(t.natural) || GREEN_LEISURE.has(t.leisure)) {
      return ["green", t.landuse || t.leisure || t.natural];
    }
    return null;
  }
  if (t.highway) return ROAD_CLASS[t.highway] ? ["road", ROAD_CLASS[t.highway]] : null;
  if (RAILWAYS.has(t.railway)) return ["railway", t.railway];
  if (STREAMS.has(t.waterway)) return ["stream", t.waterway];
  return null;
}

function isClosed(geom) {
  if (geom.length < 4) return false;
  const a = geom[0], b = geom[geom.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

function isOsmArea(t) {
  if (t.area === "no") return false;
  if (t.highway && t.area !== "yes") return false;
  if (t.waterway && t.waterway !== "riverbank") return false;
  if (t.railway) return false;
  return true;
}

/** Joins relation members into closed rings. */
export function rings(members) {
  const left = members.map((m) => m.geom.slice()).filter((g) => g.length >= 2);
  const result = [];
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (left.length) {
    let ring = left.shift();
    let changed = true;
    while (!same(ring[0], ring[ring.length - 1]) && changed) {
      changed = false;
      for (let i = 0; i < left.length; i++) {
        const g = left[i];
        const end = ring[ring.length - 1];
        if (same(g[0], end)) ring = ring.concat(g.slice(1));
        else if (same(g[g.length - 1], end)) ring = ring.concat(g.slice(0, -1).reverse());
        else continue;
        left.splice(i, 1);
        changed = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) result.push(ring);
  }
  return result;
}

const round6 = (g) => g.map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]);

function inBbox(geom, [w, s, e, n]) {
  for (const p of geom) if (p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n) return true;
  return false;
}

/** Vector basemap as GeoJSON (properties: k = kind, t = subtype, n = name, a = label angle). */
export function vectorBasemap(data, bbox) {
  const proj = projectionForBbox(bbox);
  const byKind = Object.fromEntries(BASEMAP_ORDER.map((k) => [k, []]));
  const streets = new Map();
  const add = (k, t, n, geometry) => {
    const p = { k };
    if (t) p.t = t;
    if (n && (k === "road" || k === "place" || k === "stream")) p.n = n;
    byKind[k].push({ type: "Feature", geometry, properties: p });
  };
  for (const w of data.ways) {
    if (w.geom.length < 2 || !inBbox(w.geom, bbox)) continue;
    const area = isClosed(w.geom) && isOsmArea(w.tags);
    const c = classify(w.tags, area ? "area" : "line");
    if (!c) continue;
    const g = round6(w.geom);
    add(c[0], c[1], w.tags.name, area ? { type: "Polygon", coordinates: [g] } : { type: "LineString", coordinates: g });
    if (c[0] === "road" && w.tags.name) {
      const length = lengthM(w.geom, proj);
      const known = streets.get(w.tags.name);
      if (!known || length > known.length) streets.set(w.tags.name, { length, geom: w.geom });
    }
  }
  for (const r of data.relations) {
    const c = classify(r.tags, "area");
    if (!c) continue;
    const outer = rings(r.members.filter((m) => m.role !== "inner" && m.geom));
    const inner = rings(r.members.filter((m) => m.role === "inner" && m.geom));
    const polys = outer.filter((g) => inBbox(g, bbox)).map((g) => [round6(g), ...inner.map(round6)]);
    if (polys.length) add(c[0], c[1], r.tags.name, { type: "MultiPolygon", coordinates: polys });
  }
  for (const p of data.points) {
    const c = classify(p.tags, "point");
    if (c && inBbox([p.ll], bbox)) add(c[0], c[1], p.tags.name, { type: "Point", coordinates: round6([p.ll])[0] });
  }
  for (const [name, { length, geom }] of streets) {
    if (length < 40) continue;
    const { ll, angle } = midpointAndAngle(geom, proj);
    byKind.label.push({ type: "Feature", geometry: { type: "Point", coordinates: round6([ll])[0] },
      properties: { k: "label", t: "street", n: name, a: Math.round(angle * 10) / 10 } });
  }
  const features = BASEMAP_ORDER.flatMap((k) => byKind[k]);
  const summary = Object.fromEntries(BASEMAP_ORDER.filter((k) => byKind[k].length).map((k) => [k, byKind[k].length]));
  return { type: "FeatureCollection", features, summary };
}

function lengthM(geom, proj) {
  let d = 0;
  for (let i = 1; i < geom.length; i++) {
    const [x1, y1] = proj.toXY(...geom[i - 1]);
    const [x2, y2] = proj.toXY(...geom[i]);
    d += Math.hypot(x2 - x1, y2 - y1);
  }
  return d;
}

function midpointAndAngle(geom, proj) {
  const xy = geom.map((p) => proj.toXY(p[0], p[1]));
  let total = 0;
  const seg = [];
  for (let i = 1; i < xy.length; i++) {
    const l = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    seg.push(l);
    total += l;
  }
  let left = total / 2;
  for (let i = 0; i < seg.length; i++) {
    if (left <= seg[i] || i === seg.length - 1) {
      const f = seg[i] ? Math.min(left / seg[i], 1) : 0;
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      let angle = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
      if (angle > 90) angle -= 180;
      else if (angle < -90) angle += 180;
      return { ll: proj.toLL(ax + f * (bx - ax), ay + f * (by - ay)), angle };
    }
    left -= seg[i];
  }
  return { ll: geom[0], angle: 0 };
}

/** Extent of the data (for an area from an .osm file). */
export function dataBbox(data) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const way of data.ways) for (const [lon, lat] of way.geom) {
    w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat);
  }
  return [w, s, e, n];
}
