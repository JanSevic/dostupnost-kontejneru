// In-browser "server" for the editor. Answers the same calls as the Python desktop
// server (same /api/… paths) and keeps work in progress in the browser's IndexedDB.
import { CONFIG, OSM_ATTRIBUTION } from "./config.js";
import { expandBbox, areaKm2 } from "./geo.js";
import { fetchOverpass, fromXml, walkingNetwork, vectorBasemap, dataBbox, DataError } from "./osm.js";
import { buildNetwork, bboxPolygon } from "./network.js";
import { computeType, summary, checkStraightLine } from "./compute.js";
import * as db from "./storage.js";
import * as exports from "./exports.js";
import { createState, validateState } from "./state.js";
import { normaliseCollection, isDoorToDoor, sourcesByType, summaryKeys } from "./collection.js";
import { emptyExclusions, normaliseExclusions, exclusionMask, edgeKey, maskToList } from "./exclusions.js";

const SUMMARY = CONFIG.summary_key;

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const S = {
  types: CONFIG.types.map((t) => ({ ...t })),
  slug: null,
  meta: null,
  net: null,
  networkData: null, // {nodes, edges} the network was built from (for exclusion keys)
  netVersion: 0,
  exclusions: emptyExclusions(),
  excluded: new Uint8Array(0), // 1 = segment excluded from evaluation
  containers: { type: "FeatureCollection", features: [] },
  basemap: null,
  task: { running: false },
};

// ------------------------------------------------------------------ containers

function normaliseKey(text) {
  const t = String(text).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return t || "typ";
}
const UNKNOWN_TYPE_COLORS = ["#e8590c", "#0b7285", "#5f3dc4", "#a61e4d", "#2b8a3e", "#495057"];

/**
 * Validates and normalises a container FeatureCollection. Properties of the features stay Czech
 * (id, typ, poznamka) – it is the file format users edit in QGIS.
 */
export function normaliseContainers(fc, types) {
  if (!fc || fc.type !== "FeatureCollection") throw new ApiError(400, "Soubor není GeoJSON FeatureCollection.");
  const crs = fc.crs && fc.crs.properties && fc.crs.properties.name;
  if (crs && !/(CRS84|EPSG:+4326)$/.test(crs)) {
    throw new ApiError(400, "Souřadnice nejsou ve WGS84 (EPSG:4326). V QGIS ulož vrstvu jako GeoJSON se systémem EPSG:4326.");
  }
  const byKey = Object.fromEntries(types.map((t) => [t.key, t]));
  const byName = Object.fromEntries(types.map((t) => [t.name.trim().toLowerCase(), t]));
  const added = [], warnings = [], out = [], withoutId = [], used = new Set();
  let skipped = 0;
  for (const f of fc.features || []) {
    const g = (f && f.geometry) || {};
    if (g.type !== "Point" || !Array.isArray(g.coordinates) || g.coordinates.length < 2) { skipped++; continue; }
    const x = Number(g.coordinates[0]), y = Number(g.coordinates[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { skipped++; continue; }
    if (x < -180 || x > 180 || y < -90 || y > 90) {
      throw new ApiError(400, "Souřadnice nejsou ve stupních WGS84 (EPSG:4326). V QGIS ulož vrstvu jako GeoJSON se systémem EPSG:4326.");
    }
    const p = f.properties || {};
    const typeText = String(p.typ || p.type || "").trim();
    if (!typeText) { skipped++; continue; }
    let type = byKey[typeText] || byName[typeText.toLowerCase()];
    if (!type) {
      let key = normaliseKey(typeText);
      if (key === SUMMARY) key = "vse_typ";
      type = byKey[key];
      if (!type) {
        type = { key, name: typeText, color: UNKNOWN_TYPE_COLORS[added.length % UNKNOWN_TYPE_COLORS.length], abbr: typeText.slice(0, 2), temporary: true };
        added.push(type);
        byKey[key] = type;
        byName[typeText.toLowerCase()] = type;
      }
    }
    let id = parseInt(p.id, 10);
    if (!Number.isFinite(id)) id = null;
    const feature = { type: "Feature", geometry: { type: "Point", coordinates: [Math.round(x * 1e7) / 1e7, Math.round(y * 1e7) / 1e7] },
      properties: { id, typ: type.key, poznamka: String(p.poznamka || "") } };
    if (id === null || used.has(id)) withoutId.push(feature);
    else used.add(id);
    out.push(feature);
  }
  let next = Math.max(0, ...used) + 1;
  for (const feature of withoutId) feature.properties.id = next++;
  if (withoutId.length) warnings.push(`${withoutId.length} kontejner(ů) nemělo platné nebo jedinečné id – bylo přiděleno nové.`);
  if (skipped) warnings.push(`${skipped} prvek(ů) nebyl bod s vyplněným typem – vynecháno.`);
  for (const t of added) warnings.push(`Typ „${t.name}“ není v konfiguraci – přidán dočasně.`);
  const result = { type: "FeatureCollection", features: out };
  const collection = normaliseCollection(fc.sber);
  if (Object.keys(collection).length) result.sber = collection;
  return { fc: result, warnings, added };
}

function requireArea() {
  if (!S.slug) throw new ApiError(409, "Není otevřená žádná oblast – vyber nebo připrav oblast.");
}

async function setContainers(fc) {
  requireArea();
  const { fc: n, warnings, added } = normaliseContainers(fc, S.types);
  S.types.push(...added);
  S.containers = n;
  const work = (await db.get("work", S.slug)) || { slug: S.slug, variants: {} };
  work.containers = n;
  await db.put("work", work);
  return warnings;
}

// ------------------------------------------------------------------ areas

function areaInfo() {
  if (!S.meta) return null;
  return { ...S.meta, slug: S.slug, tiles_stored: false, tiles_html_bytes: 0, tiles_max_zoom: null };
}

async function openArea(slug) {
  const o = await db.get("areas", slug);
  if (!o) throw new ApiError(400, "Oblast neexistuje.");
  const net = buildNetwork(o.network, o.meta.bbox, CONFIG.segment_length_m);
  const types = CONFIG.types.map((t) => ({ ...t }));
  const work = (await db.get("work", slug)) || { slug, variants: {}, containers: null };
  let fc = { type: "FeatureCollection", features: [] };
  if (work.containers) {
    try {
      const r = normaliseContainers(work.containers, types);
      types.push(...r.added);
      fc = r.fc;
    } catch (e) { /* damaged data – start from scratch */ }
  }
  const exclusions = normaliseExclusions(work.exclusions);
  Object.assign(S, { slug, meta: o.meta, net, networkData: o.network, types, containers: fc, basemap: o.basemap, exclusions,
    excluded: exclusionMask(o.network, net, exclusions) });
  S.netVersion++;
  await db.put("settings", { key: "last_area", value: slug });
}

async function newSlug(name) {
  const base = normaliseKey(name).slice(0, 40) || "oblast";
  let slug = base, i = 2;
  while (await db.get("areas", slug)) slug = `${base}_${i++}`;
  return slug;
}

async function prepare({ name, extent, slug, osmText }, progress) {
  const updating = !!slug;
  const old = updating ? await db.get("areas", slug) : null;
  let data, bbox, source;
  if (osmText != null) {
    progress("network", "Načítám data ze souboru .osm…");
    data = fromXml(osmText);
    bbox = expandBbox(dataBbox(data), 50);
    extent = bbox;
    source = "soubor .osm";
  } else {
    bbox = expandBbox(extent, CONFIG.network_margin_m);
    const area = areaKm2(bbox);
    if (area > CONFIG.max_area_km2) {
      throw new DataError(`Oblast je příliš velká (${Math.round(area)} km² i s okrajem, limit ${CONFIG.max_area_km2} km²). Přibliž mapu.`);
    }
    progress("network", "Stahuji pěší síť a podklad z OpenStreetMap… (může trvat i minutu)");
    data = await fetchOverpass(bbox, CONFIG.overpass_url);
    source = "OpenStreetMap (Overpass API)";
  }
  progress("basemap", "Zpracovávám pěší síť a vektorový podklad…");
  const networkData = walkingNetwork(data);
  const basemap = vectorBasemap(data, bbox);
  const net = buildNetwork(networkData, bbox, CONFIG.segment_length_m);
  const now = new Date().toISOString().slice(0, 19);
  const meta = {
    name, extent: extent.map((x) => +x.toFixed(7)), bbox: bbox.map((x) => +x.toFixed(7)),
    margin_m: osmText != null ? 50 : CONFIG.network_margin_m, area_km2: +areaKm2(bbox).toFixed(2),
    downloaded: now, created: (old && old.meta.created) || now, source, attribution: `${OSM_ATTRIBUTION} (data ODbL)`,
    network: { length_km: +net.lengthKm.toFixed(2), segment_count: net.segments.count },
    basemap: basemap.summary,
  };
  progress("saving", "Ukládám oblast do prohlížeče…");
  if (!updating) slug = await newSlug(name);
  meta.slug = slug;
  await db.put("areas", { slug, meta, network: networkData, basemap });
  return meta;
}

function startTask(description, fn) {
  if (S.task.running) throw new ApiError(409, "Už běží jiná příprava oblasti – počkej na dokončení.");
  S.task = { running: true, description, phase: "start", message: description, done: null, total: null, error: null, slug: null };
  const progress = (phase, message, done = null, total = null) => Object.assign(S.task, { phase, message, done, total });
  (async () => {
    try {
      const meta = await fn(progress);
      if (meta.slug === S.slug) {
        progress("opening", "Načítám aktualizovaná data…");
        await openArea(meta.slug);
      }
      Object.assign(S.task, { running: false, phase: "done", message: `Oblast „${meta.name}“ je připravená.`, slug: meta.slug });
    } catch (e) {
      const message = e instanceof DataError ? e.message : "Neočekávaná chyba: " + e.message;
      if (!(e instanceof DataError)) console.error(e);
      Object.assign(S.task, { running: false, phase: "error", error: message, message });
    }
  })();
}

// ------------------------------------------------------------------ computation

function compute(keys, withSummary) {
  if (!S.net) throw new ApiError(409, "Není otevřená žádná oblast – vyber nebo připrav oblast.");
  const collection = normaliseCollection(S.containers.sber);
  const sources = sourcesByType(S.containers, S.types, collection);
  const names = Object.fromEntries(S.types.map((t) => [t.key, t.name]));
  const warnings = [];
  if (keys === null) {
    keys = S.types.map((t) => t.key);
    const empty = keys.filter((k) => !sources[k] && !isDoorToDoor(collection, k)).map((k) => names[k]);
    if (empty.length) warnings.push("Bez kontejnerů (nepočítáno): " + empty.join(", ") + ".");
    const doorEmpty = keys.filter((k) => !sources[k] && isDoorToDoor(collection, k)).map((k) => names[k]);
    if (doorEmpty.length) warnings.push("Svoz od domu bez záložních míst (nepočítáno): " + doorEmpty.join(", ") + ".");
    keys = keys.filter((k) => sources[k]);
    if (!keys.length) throw new ApiError(400, "Zatím není zadaný žádný kontejner.");
  } else {
    for (const k of keys) {
      if (!names[k]) throw new ApiError(400, `Neznámý typ odpadu „${k}“.`);
      if (!sources[k]) {
        throw new ApiError(400, isDoorToDoor(collection, k)
          ? `Typ „${names[k]}“ má svoz od domu a zatím nemá žádné záložní místo – nejdřív nějaké přidej.`
          : `Typ „${names[k]}“ nemá žádný kontejner – nejdřív nějaký přidej.`);
      }
    }
  }
  const results = {}, checks = {}, snaps = {};
  for (const k of keys) {
    const points = sources[k];
    const r = computeType(S.net, names[k], points, CONFIG.connection_warning_m);
    results[k] = r.d;
    warnings.push(...r.warnings);
    checks[k] = checkStraightLine(S.net, r.d, points.filter((_, i) => r.snaps[i].edge !== null));
    for (const p of r.snaps) {
      snaps[p.id] = { id: p.id, connection_m: p.edge === null ? null : Math.round(p.s * 10) / 10, outside: p.outside,
        long_connection: p.edge !== null && p.s > CONFIG.connection_warning_m, isolated: p.isolated };
    }
    if (!r.d.some(Number.isFinite)) warnings.push(`${names[k]}: žádný kontejner není připojen k síti.`);
  }
  let summaryD = null, summaryTypes = [];
  const forSummary = summaryKeys(keys, collection);
  if (withSummary && forSummary.length) {
    summaryTypes = forSummary;
    summaryD = summary(forSummary.map((k) => results[k]), S.net.segments.count);
  }
  return { results, summary: summaryD, summaryTypes, snaps, warnings, checks, version: S.netVersion };
}

const toJson = (d) => Array.from(d, (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null));

function renderSettings(data) {
  let bands = data.bands || CONFIG.bands_m;
  bands = bands.map(Number).sort((a, b) => a - b);
  if (bands.length !== CONFIG.bands_m.length || bands.some((p) => !(p > 0))) throw new ApiError(400, "Neplatné hranice pásem.");
  return { mode: data.mode === "continuous" ? "continuous" : "bands", bands, band_colors: CONFIG.band_colors,
    unreachable_color: CONFIG.unreachable_color, continuous_max_m: CONFIG.continuous_max_m };
}

// ------------------------------------------------------------------ router

/** Same calls as the desktop server. Returns the response (object) or throws an Error with a message. */
export async function call(method, url, body) {
  const path = url.split("?")[0];
  const route = method + " " + path;
  switch (route) {
    case "GET /api/config":
      return { ...CONFIG, types: S.types };
    case "GET /api/status":
      return { area: areaInfo(),
        network: { version: S.netVersion, length_km: S.net ? +S.net.lengthKm.toFixed(2) : null, segment_count: S.net ? S.net.segments.count : null },
        task: { ...S.task } };
    case "GET /api/areas": {
      const all = await db.getAll("areas");
      const work = Object.fromEntries((await db.getAll("work")).map((p) => [p.slug, p]));
      const last = await db.get("settings", "last_area");
      return {
        areas: all.map((o) => ({ ...o.meta, slug: o.slug,
          container_count: ((work[o.slug] || {}).containers || { features: [] }).features.length,
          variant_count: Object.keys((work[o.slug] || {}).variants || {}).length })).sort((a, b) => a.name.localeCompare(b.name, "cs")),
        last: last ? last.value : null, open: S.slug,
      };
    }
    case "POST /api/areas/open":
      if (S.task.running) throw new ApiError(409, "Právě se připravuje oblast – počkej na dokončení.");
      await openArea(String(body.slug || ""));
      return call("GET", "/api/status");
    case "POST /api/areas/estimate": {
      const bbox = expandBbox([body.west, body.south, body.east, body.north], CONFIG.network_margin_m);
      const area = areaKm2(bbox);
      return { area_km2: +area.toFixed(2), limit_km2: CONFIG.max_area_km2, too_large: area > CONFIG.max_area_km2 };
    }
    case "POST /api/areas/prepare": {
      let name, extent;
      if (body.default) ({ name, extent } = CONFIG.default_area);
      else { name = String(body.name || "").trim(); extent = [body.west, body.south, body.east, body.north].map(Number); }
      if (!name) throw new ApiError(400, "Zadej název oblasti.");
      startTask(`Příprava oblasti „${name}“`, (p) => prepare({ name, extent }, p));
      return call("GET", "/api/status");
    }
    case "POST /api/areas/update": {
      requireArea();
      const m = S.meta, slug = S.slug;
      startTask(`Aktualizace oblasti „${m.name}“`, (p) => prepare({ name: m.name, extent: m.extent, slug }, p));
      return call("GET", "/api/status");
    }
    case "GET /api/task":
      return { ...S.task };
    case "GET /api/basemap":
      requireArea();
      return S.basemap || { type: "FeatureCollection", features: [] };
    case "GET /api/network/segments":
      requireArea();
      return { version: S.netVersion, segments: S.net.segments.ll, lengths: Array.from(S.net.segments.length, (x) => Math.round(x * 100) / 100),
        area: bboxPolygon(S.meta.bbox), excluded: maskToList(S.excluded) };
    case "GET /api/exclusions":
      requireArea();
      return exclusionsResponse();
    case "PUT /api/exclusions":
      requireArea();
      await setExclusions(normaliseExclusions(body));
      return exclusionsResponse();
    case "POST /api/exclusions/toggle-segment": {
      requireArea();
      const k = Number(body.segment);
      if (!(k >= 0 && k < S.net.segments.count)) throw new ApiError(400, "Neplatný úsek sítě.");
      const [a, b] = S.networkData.edges[S.net.segments.edge[k]];
      const key = edgeKey(S.networkData.nodes, a, b);
      const edges = new Set(S.exclusions.edges);
      if (edges.has(key)) edges.delete(key);
      else if (S.excluded[k]) throw new ApiError(400, "Úsek leží ve vyloučené oblasti – pro jeho vrácení smaž tu oblast.");
      else edges.add(key);
      await setExclusions({ polygons: S.exclusions.polygons, edges: [...edges] });
      return exclusionsResponse();
    }
    case "GET /api/containers":
      requireArea();
      return S.containers;
    case "PUT /api/containers": {
      const warnings = await setContainers(body);
      return { ok: true, warnings, count: S.containers.features.length };
    }
    case "POST /api/containers/import": {
      const warnings = await setContainers(body);
      return { containers: S.containers, warnings, types: S.types };
    }
    case "GET /api/variants": {
      requireArea();
      const work = (await db.get("work", S.slug)) || { variants: {} };
      return Object.entries(work.variants || {}).map(([name, v]) => ({ name, changed: v.changed, count: v.fc.features.length }))
        .sort((a, b) => b.changed.localeCompare(a.changed));
    }
    case "POST /api/variants": {
      requireArea();
      const name = String(body.name || "").trim().slice(0, 80);
      if (!name) throw new ApiError(400, "Zadej název varianty.");
      if (body.containers) await setContainers(body.containers);
      await saveVariant(name);
      return { name };
    }
    case "POST /api/variants/load": {
      requireArea();
      const work = (await db.get("work", S.slug)) || { variants: {} };
      const v = (work.variants || {})[body.name];
      if (!v) throw new ApiError(400, `Varianta „${body.name}“ neexistuje.`);
      const warnings = await setContainers(v.fc);
      return { containers: S.containers, warnings, types: S.types };
    }
    case "POST /api/compute": {
      if (body.containers) await setContainers(body.containers);
      const all = body.types == null || body.types === "all";
      const r = compute(all ? null : [...body.types], all);
      return { network_version: r.version, results: Object.fromEntries(Object.entries(r.results).map(([k, d]) => [k, toJson(d)])),
        summary: r.summary ? toJson(r.summary) : null, summary_types: r.summaryTypes,
        snaps: Object.fromEntries(Object.entries(r.snaps).map(([k, v]) => [String(k), v])), warnings: r.warnings, checks: r.checks };
    }
  }
  throw new ApiError(404, "Neznámé volání " + route);
}

function exclusionsResponse() {
  return { ...S.exclusions, excluded: maskToList(S.excluded) };
}

async function setExclusions(ex) {
  S.exclusions = ex;
  S.excluded = exclusionMask(S.networkData, S.net, ex);
  const work = (await db.get("work", S.slug)) || { slug: S.slug, variants: {} };
  work.exclusions = ex;
  await db.put("work", work);
}

/** Exports show only the evaluated part of the network (excluded segments are left out). */
function evaluatedView(r) {
  if (!S.excluded.some(Boolean)) return { net: S.net, results: r.results, summary: r.summary };
  const keep = [];
  for (let k = 0; k < S.excluded.length; k++) if (!S.excluded[k]) keep.push(k);
  const pick = (d) => Float64Array.from(keep, (k) => d[k]);
  const seg = S.net.segments;
  return {
    net: { segments: { count: keep.length, ll: keep.map((k) => seg.ll[k]), length: pick(seg.length) } },
    results: Object.fromEntries(Object.entries(r.results).map(([k, d]) => [k, pick(d)])),
    summary: r.summary ? pick(r.summary) : null,
  };
}

async function saveVariant(name) {
  const work = (await db.get("work", S.slug)) || { slug: S.slug, variants: {} };
  work.variants = work.variants || {};
  work.variants[name] = { fc: S.containers, changed: new Date().toISOString().slice(0, 16) };
  await db.put("work", work);
}

/** New area from an .osm file. */
export async function areaFromOsm(file, name) {
  const text = await file.text();
  startTask(`Oblast ze souboru .osm „${name}“`, (p) => prepare({ name, osmText: text }, p));
  return call("GET", "/api/status");
}

/** Downloaded file name, e.g. "2026-11-07_1530_Dřínov_qgis.geojson" (Czech, users see it). */
function downloadName(name, extension, suffix = "") {
  const t = new Date();
  const d = (n) => String(n).padStart(2, "0");
  const stamp = `${t.getFullYear()}-${d(t.getMonth() + 1)}-${d(t.getDate())}_${d(t.getHours())}${d(t.getMinutes())}`;
  let b = String(name).replace(/[^\p{L}\p{N}-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "mapa";
  if (suffix) b += "_" + suffix;
  return `${stamp}_${b}.${extension}`;
}

/** Export: returns {blob, name, warnings}. */
export async function exportData(kind, body) {
  if (body.containers) await setContainers(body.containers);
  const settings = renderSettings(body);
  const r = compute(null, true);
  const title = String(body.title || "Pěší dostupnost kontejnerů");
  const attribution = (S.meta && S.meta.attribution) || OSM_ATTRIBUTION;
  const view = evaluatedView(r);
  const common = { net: view.net, fc: S.containers, types: S.types, results: view.results, summary: view.summary, settings,
    snaps: r.snaps, basemap: S.basemap, attribution, title, extent: body.extent, area: bboxPolygon(S.meta.bbox) };
  const warnings = [...r.warnings];
  if (kind === "geojson") {
    return { blob: exports.geojsonForQgis(common), name: downloadName(S.meta.name, "geojson", "qgis"), warnings };
  }
  if (kind === "html") {
    return { blob: await exports.html({ ...common, layer: body.layer }), name: downloadName(title, "html"), warnings };
  }
  if (kind === "png") {
    const layers = [...Object.keys(view.results), ...(view.summary ? [SUMMARY] : [])];
    const selected = body.all ? layers : [body.layer];
    if (!body.all && !layers.includes(body.layer)) throw new ApiError(400, "Zvolená vrstva nemá výsledek (typ bez kontejnerů?).");
    const files = [];
    for (const k of selected) {
      const d = k === SUMMARY ? view.summary : view.results[k];
      const blob = await exports.png({ ...common, d, layer: k, basemapMode: body.basemap || "auto" });
      files.push({ name: downloadName(title, "png", k), blob });
    }
    if (files.length === 1) return { blob: files[0].blob, name: files[0].name, warnings };
    return { blob: await exports.zip(files), name: downloadName(title, "zip"), warnings };
  }
  throw new ApiError(400, "Neznámý export.");
}

// ------------------------------------------------------------------ states for sharing

/** The open area and current containers as a state object to save to a file. */
export async function stateForSaving({ name, description, order, bands, layer, mode, containers }) {
  requireArea();
  if (containers) await setContainers(containers);
  if (!S.containers.features.length) throw new ApiError(400, "Zatím není zadaný žádný kontejner.");
  const o = await db.get("areas", S.slug);
  const used = new Set(S.containers.features.map((f) => f.properties.typ));
  return createState({
    name, description, order, meta: o.meta, network: o.network, basemap: o.basemap, exclusions: S.exclusions,
    types: S.types.filter((t) => !t.temporary || used.has(t.key)),
    containers: S.containers, display: { bands: bands || CONFIG.bands_m, layer, mode },
  });
}

/**
 * Takes over a saved state for editing: its area (same data = same area) and its containers.
 * If the area already exists and has containers, they are first saved as a variant.
 */
export async function takeOverState(o) {
  try { validateState(o); } catch (e) { throw new ApiError(400, e.message); }
  if (S.task.running) throw new ApiError(409, "Právě se připravuje oblast – počkej na dokončení.");
  const all = await db.getAll("areas");
  const same = all.find((x) => x.meta.downloaded === o.area.downloaded && JSON.stringify(x.meta.bbox) === JSON.stringify(o.area.bbox));
  let slug;
  if (same) slug = same.slug;
  else {
    slug = await newSlug(o.area.name || "oblast");
    const net = buildNetwork(o.area.network, o.area.bbox, CONFIG.segment_length_m);
    const now = new Date().toISOString().slice(0, 19);
    const meta = { name: o.area.name, extent: o.area.extent || o.area.bbox, bbox: o.area.bbox,
      margin_m: 0, area_km2: o.area.area_km2 ?? +areaKm2(o.area.bbox).toFixed(2),
      downloaded: o.area.downloaded, created: now, source: (o.area.source || "OpenStreetMap") + ` (ze stavu „${o.name}“)`,
      attribution: o.area.attribution || `${OSM_ATTRIBUTION} (data ODbL)`,
      network: { length_km: +net.lengthKm.toFixed(2), segment_count: net.segments.count }, basemap: {}, slug };
    await db.put("areas", { slug, meta, network: o.area.network, basemap: o.area.basemap });
  }
  await openArea(slug);
  let backup = null;
  if (same && S.containers.features.length) {
    const t = new Date();
    backup = `před načtením „${o.name}“ ${t.toLocaleDateString("cs-CZ")} ${t.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`.slice(0, 80);
    await saveVariant(backup);
  }
  // the network exclusions of the state replace those of the area
  await setExclusions(normaliseExclusions(o.area.exclusions));
  // types from the state that are not in the configuration are added temporarily
  for (const t of o.types) if (!S.types.some((x) => x.key === t.key)) S.types.push({ ...t, temporary: true });
  const warnings = await setContainers(o.containers);
  return { slug, newArea: !same, backup, warnings };
}

/** Saves a preview (a state not published yet) – the viewer page opens it. */
export async function savePreview(o) {
  await db.put("settings", { key: "preview", value: o });
}

/** Opens browser storage at startup and reopens the area that was open last time. */
export async function initialise() {
  try {
    await db.open();
  } catch (e) {
    throw new Error("Prohlížeč nedovoluje ukládat data (IndexedDB). Zkus jiný prohlížeč nebo vypni anonymní režim.");
  }
  try {
    const last = await db.get("settings", "last_area");
    if (last && last.value) await openArea(last.value);
  } catch (e) { /* the area was deleted or is damaged – the user picks another one */ }
}
