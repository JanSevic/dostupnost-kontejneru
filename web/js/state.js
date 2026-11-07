// Saved state for sharing: one JSON file with everything the viewer needs
// (walking network, basemap, containers, bands). Works in the browser and in Node (index generator).
import { buildNetwork } from "./network.js";
import { computeType, summary } from "./compute.js";
import { normaliseCollection, sourcesByType, summaryKeys } from "./collection.js";
import { normaliseExclusions, exclusionMask, evaluatedLengths } from "./exclusions.js";

export const FORMAT = "dostupnost-kontejneru/state";
export const VERSION = 1;
export const SUMMARY_KEY = "vse";

const r6 = (x) => Math.round(x * 1e6) / 1e6;
const r5 = (x) => Math.round(x * 1e5) / 1e5;

function roundCoordinates(c, f) {
  if (typeof c[0] === "number") return c.map(f);
  return c.map((x) => roundCoordinates(x, f));
}

/** File name from the state name: "Návrh 1", 2 -> "02-navrh-1.json" */
export function stateFileName(name, order) {
  const s = String(name).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "stav";
  const p = Number.isFinite(+order) && +order > 0 ? String(Math.round(+order)).padStart(2, "0") + "-" : "";
  return p + s + ".json";
}

/**
 * Builds a state for saving.
 * @param {object} a {name, description, order, meta (area), network {nodes, edges}, basemap (GeoJSON), exclusions,
 *   types, containers (GeoJSON incl. collection settings "sber"), display {bands, layer, mode}}
 */
export function createState(a) {
  const name = String(a.name || "").trim();
  if (!name) throw new Error("Zadej název stavu.");
  const m = a.meta;
  return {
    format: FORMAT,
    version: VERSION,
    name,
    description: String(a.description || "").trim(),
    order: a.order === null || a.order === undefined || a.order === "" || !Number.isFinite(+a.order) ? null : +a.order,
    saved: new Date().toISOString().slice(0, 19),
    area: {
      name: m.name, extent: m.extent, bbox: m.bbox, downloaded: m.downloaded, source: m.source, attribution: m.attribution,
      area_km2: m.area_km2,
      network: { nodes: a.network.nodes.map(([x, y]) => [r6(x), r6(y)]), edges: a.network.edges },
      basemap: {
        type: "FeatureCollection",
        features: ((a.basemap && a.basemap.features) || []).map((f) => ({
          type: "Feature", properties: f.properties,
          geometry: { type: f.geometry.type, coordinates: roundCoordinates(f.geometry.coordinates, r5) },
        })),
      },
      exclusions: normaliseExclusions(a.exclusions),
    },
    types: a.types.map((t) => ({ key: t.key, name: t.name, color: t.color, abbr: t.abbr })),
    containers: a.containers,
    display: {
      bands: a.display.bands.map(Number),
      layer: a.display.layer || SUMMARY_KEY,
      mode: a.display.mode === "continuous" ? "continuous" : "bands",
    },
  };
}

/** Validates a loaded state, throws an Error with a user-readable (Czech) message. */
export function validateState(o) {
  if (!o || typeof o !== "object" || o.format !== FORMAT) {
    throw new Error("Soubor není uložený stav aplikace Dostupnost kontejnerů.");
  }
  if (!(o.version <= VERSION)) throw new Error("Stav je uložený novější verzí aplikace – aktualizuj aplikaci.");
  const n = o.area && o.area.network;
  if (!n || !Array.isArray(n.nodes) || !Array.isArray(n.edges) || !n.edges.length) throw new Error("Stav neobsahuje pěší síť.");
  if (!Array.isArray(o.area.bbox) || o.area.bbox.length !== 4) throw new Error("Stav nemá rozsah oblasti.");
  if (!o.containers || !Array.isArray(o.containers.features)) throw new Error("Stav neobsahuje kontejnery.");
  if (!Array.isArray(o.types) || !o.types.length) throw new Error("Stav neobsahuje typy odpadu.");
  const bands = o.display && o.display.bands;
  if (!Array.isArray(bands) || !bands.length || !bands.every((h, i) => Number.isFinite(h) && h > 0 && (i === 0 || h > bands[i - 1]))) {
    throw new Error("Stav nemá platně nastavená pásma.");
  }
  return o;
}

/** Short entry for the list of states (presets/index.json). */
export function stateSummary(o, file) {
  const counts = {};
  for (const f of o.containers.features) counts[f.properties.typ] = (counts[f.properties.typ] || 0) + 1;
  return {
    file, name: o.name, description: o.description || "", order: o.order ?? null, saved: o.saved,
    area: o.area.name, downloaded: o.area.downloaded, containers: o.containers.features.length, counts,
  };
}

/** Sorts list entries: by order, then by file name. */
export function sortStateList(entries) {
  return entries.slice().sort((a, b) => {
    const pa = Number.isFinite(a.order) ? a.order : 1e9, pb = Number.isFinite(b.order) ? b.order : 1e9;
    return pa - pb || String(a.file).localeCompare(String(b.file));
  });
}

/**
 * Builds the network and computes distances for all types that have containers (own or shared), plus the
 * summary over types without door-to-door collection. `lengths` are segment lengths for statistics
 * (0 for segments excluded from evaluation, `excluded` = 1).
 */
export function computeState(o, segmentLength = 10) {
  const net = buildNetwork(o.area.network, o.area.bbox, segmentLength);
  const names = Object.fromEntries(o.types.map((t) => [t.key, t.name]));
  const collection = normaliseCollection(o.containers.sber);
  const sources = sourcesByType(o.containers, o.types, collection);
  const results = {}, nodes = {}, warnings = [];
  for (const t of o.types) {
    if (!sources[t.key]) continue;
    const r = computeType(net, names[t.key], sources[t.key]);
    results[t.key] = r.d;
    nodes[t.key] = r.dNodes;
    warnings.push(...r.warnings);
  }
  const keys = summaryKeys(Object.keys(results), collection);
  const all = keys.length ? summary(keys.map((k) => results[k]), net.segments.count) : null;
  const excluded = exclusionMask(o.area.network, net, normaliseExclusions(o.area.exclusions));
  const lengths = evaluatedLengths(net.segments.length, excluded);
  return { net, results, nodes, summary: all, summaryTypes: keys, warnings, collection, excluded, lengths };
}

/** Layers with a result: types with containers in state order, summary last. */
export function stateLayers(o, result) {
  const k = o.types.map((t) => t.key).filter((x) => result.results[x]);
  return result.summary ? [...k, SUMMARY_KEY] : k;
}

/** Share of network length within distance limit (0–1). */
export function shareWithin(d, lengths, limit) {
  let ok = 0, total = 0;
  for (let i = 0; i < d.length; i++) {
    total += lengths[i];
    if (Number.isFinite(d[i]) && d[i] <= limit) ok += lengths[i];
  }
  return total > 0 ? ok / total : 0;
}

/** Share of the network within each limit for every layer: {key: [share ≤ l1, share ≤ l2, …]} */
export function compareState(o, result, limits) {
  const lengths = result.lengths, out = {};
  for (const k of stateLayers(o, result)) {
    const d = k === SUMMARY_KEY ? result.summary : result.results[k];
    out[k] = limits.map((h) => shareWithin(d, lengths, h));
  }
  return out;
}

// Link to a state – the hash is visible to users, so its parameter names are Czech:
// "#stav=02-navrh-1&vrstva=plast", preview "#nahled&vrstva=vse".

/** "#stav=02-navrh-1&vrstva=plast" -> {state: "02-navrh-1", layer: "plast", preview: false} */
export function parseLink(hash) {
  const h = String(hash || "").replace(/^#/, "");
  if (h === "nahled" || h.startsWith("nahled&")) {
    const p = new URLSearchParams(h.slice(6));
    return { state: null, layer: p.get("vrstva") || null, preview: true };
  }
  const p = new URLSearchParams(h);
  const state = (p.get("stav") || "").replace(/\.json$/i, "");
  return { state: state || null, layer: p.get("vrstva") || null, preview: false };
}

/** Inverse of parseLink. */
export function buildLink({ state, layer, preview }) {
  const p = new URLSearchParams();
  if (!preview && state) p.set("stav", String(state).replace(/\.json$/i, ""));
  if (layer) p.set("vrstva", layer);
  const s = p.toString();
  return "#" + (preview ? "nahled" + (s ? "&" + s : "") : s);
}
