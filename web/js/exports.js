// Exports of the web version: GeoJSON for QGIS, standalone HTML (works offline), A4 PNG for print, ZIP.
// Attribute names in the QGIS export stay Czech – users see them in QGIS.
import { CONFIG } from "./config.js";
import { band } from "./compute.js";
import { projection } from "./geo.js";

const SUMMARY = CONFIG.summary_key;
const SUMMARY_NAME = "Všechny typy";
const SUMMARY_CAPTION = "nejdelší z cest k nejbližším kontejnerům jednotlivých typů";
const TYPE_CAPTION = "vzdálenost po pěších cestách k nejbližšímu kontejneru";

const layerName = (k, types) => (k === SUMMARY ? SUMMARY_NAME : (types.find((t) => t.key === k) || { name: k }).name);

export function bandLabel(i, limits) {
  const c = (x) => (Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10).replace(".", ","));
  if (i < 0) return "nedosažitelné";
  const s = [0, ...limits];
  return i < limits.length ? `${c(s[i])}–${c(s[i + 1])} m` : `nad ${c(s[s.length - 1])} m`;
}

const toJson = (d) => Array.from(d, (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null));

// ------------------------------------------------------------------ GeoJSON for QGIS
/** One file with two kinds of features: network segments (lines) with d_<type>/pasmo_<type> and containers (points). QGIS offers them as two layers. */
export function geojsonForQgis({ net, fc, types, results, summary, settings, snaps }) {
  const columns = Object.entries(results);
  if (summary) columns.push([SUMMARY, summary]);
  const features = [];
  const S = net.segments;
  for (let k = 0; k < S.count; k++) {
    const p = { vrstva: "sit_vzdalenosti", delka_m: Math.round(S.length[k] * 100) / 100 };
    for (const [key, d] of columns) {
      p["d_" + key] = Number.isFinite(d[k]) ? Math.round(d[k] * 10) / 10 : null;
      p["pasmo_" + key] = bandLabel(band(d[k], settings.bands), settings.bands);
    }
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates: S.ll[k] }, properties: p });
  }
  const names = Object.fromEntries(types.map((t) => [t.key, t.name]));
  for (const f of fc.features) {
    const p = f.properties, info = snaps[p.id] || {};
    const status = [];
    if (info.outside) status.push("mimo oblast");
    if (info.long_connection) status.push("daleko od cesty");
    if (info.isolated) status.push("izolovaný kousek cesty");
    features.push({ type: "Feature", geometry: f.geometry, properties: { vrstva: "kontejnery", id: p.id, typ: p.typ,
      typ_nazev: names[p.typ] || p.typ, poznamka: p.poznamka || "", pripojeni_m: info.connection_m ?? null, varovani: status.join(", ") } });
  }
  const gj = { type: "FeatureCollection", name: "dostupnost_kontejneru", features };
  return new Blob([JSON.stringify(gj)], { type: "application/geo+json" });
}

// ------------------------------------------------------------------ HTML
async function text(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("Chybí soubor aplikace " + path);
  return r.text();
}

const jsonForScript = (d) => JSON.stringify(d).replace(/<\//g, "<\\/");
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function html({ net, fc, types, results, summary, settings, title, layer, extent, basemap, attribution, area }) {
  const layers = [...Object.keys(results), ...(summary ? [SUMMARY] : [])];
  if (!layers.includes(layer)) layer = layers[0];
  const data = {
    title, date: "Stav k " + new Date().toLocaleDateString("cs-CZ"), attribution, types, settings, layers, layer,
    summary_key: SUMMARY, segments: net.segments.ll,
    results: Object.fromEntries(Object.entries(results).map(([k, d]) => [k, toJson(d)])),
    summary: summary ? toJson(summary) : null, containers: fc, area, extent,
    basemap: { type: "FeatureCollection", features: (basemap || {}).features || [] },
  };
  const [css, js, render, template] = await Promise.all([
    text("vendor/leaflet/leaflet.css"), text("vendor/leaflet/leaflet.js"), text("js/render.js"), text("export-template.html"),
  ]);
  const h = template
    .replace("__TITLE__", () => escHtml(title))
    .replace("/*__LEAFLET_CSS__*/", () => css)
    .replace("/*__LEAFLET_JS__*/", () => js.replace(/<\/script/gi, "<\\/script"))
    .replace("/*__RENDER_JS__*/", () => render)
    .replace("/*__DATA__*/null", () => jsonForScript(data));
  return new Blob([h], { type: "text/html;charset=utf-8" });
}

// ------------------------------------------------------------------ A4 landscape PNG (300 dpi)
const WIDTH = 3508, HEIGHT = 2480, PT = 300 / 72; // px per typographic point
const CONTINUOUS = [[0, [26, 152, 80]], [0.25, [145, 207, 96]], [0.5, [254, 224, 139]], [0.75, [252, 141, 89]], [1, [215, 48, 39]]];

function continuousColor(d, mx) {
  if (d > mx) return "#a50026";
  const t = Math.max(0, d / mx);
  for (let i = 1; i < CONTINUOUS.length; i++) {
    const [t1, c1] = CONTINUOUS[i], [t0, c0] = CONTINUOUS[i - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((v, k) => Math.round(v + f * (c1[k] - v))).join(",")})`;
    }
  }
  return "rgb(215,48,39)";
}

function colorFor(d, s) {
  if (!Number.isFinite(d)) return s.unreachable_color;
  return s.mode === "continuous" ? continuousColor(d, s.continuous_max_m) : s.band_colors[band(d, s.bands)];
}

const AREA_STYLE = { green: ["#e1eed4", null], forest: ["#c9e0b8", null], water: ["#b8d6f0", "#9cc3e6"], building: ["#ddd4ca", "#b9ada0"] };
const ROAD_STYLE = { major: ["#f7d39b", "#d39a52", 2.4], street: ["#ffffff", "#c3bbb0", 2.0], service: ["#ffffff", "#cdc6bc", 1.2],
  track: ["#a8875c", null, 0.6, [4, 3]], path: ["#937c66", null, 0.5, [1.5, 2]] };

function niceLength(m) {
  const k = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  return k.filter((x) => x <= m).pop() || 10;
}

export async function png({ net, fc, types, d, layer, settings, title, extent, basemap, basemapMode, attribution, area }) {
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(WIDTH, HEIGHT) : Object.assign(document.createElement("canvas"), { width: WIDTH, height: HEIGHT });
  const g = c.getContext("2d");
  const font = (size, bold) => `${bold ? "700 " : ""}${Math.round(size * PT)}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, WIDTH, HEIGHT);

  // map frame
  const MX = 0.025 * WIDTH, MY = (1 - 0.04 - 0.83) * HEIGHT, MW = 0.70 * WIDTH, MH = 0.83 * HEIGHT;
  const b = extent || [area[0][0], area[0][1], area[2][0], area[2][1]];
  const proj = projection((b[1] + b[3]) / 2, (b[0] + b[2]) / 2);
  const [x0, y0] = proj.toXY(b[0], b[1]);
  const [x1, y1] = proj.toXY(b[2], b[3]);
  let w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (w / h > MW / MH) h = w * MH / MW; else w = h * MW / MH;
  const m = MW / w; // px per metre
  const P = (lon, lat) => { const [x, y] = proj.toXY(lon, lat); return [MX + (x - (cx - w / 2)) * m, MY + ((cy + h / 2) - y) * m]; };

  g.save();
  g.beginPath();
  g.rect(MX, MY, MW, MH);
  g.clip();
  g.fillStyle = basemapMode === "none" ? "#ffffff" : "#f4f2ee";
  g.fillRect(MX, MY, MW, MH);
  const feats = basemapMode === "none" ? [] : ((basemap || {}).features || []);
  const path = (coords) => { coords.forEach(([lon, lat], i) => { const [x, y] = P(lon, lat); i ? g.lineTo(x, y) : g.moveTo(x, y); }); };
  const polygons = (geom) => {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    g.beginPath();
    for (const poly of polys) for (const ring of poly) { path(ring); g.closePath(); }
  };
  const lines = (geom) => {
    const ls = geom.type === "LineString" ? [geom.coordinates] : geom.type === "MultiLineString" ? geom.coordinates : [];
    g.beginPath();
    for (const l of ls) path(l);
  };
  // areas
  for (const k of ["green", "forest", "water", "building"]) {
    const [fill, stroke] = AREA_STYLE[k];
    for (const f of feats) if (f.properties.k === k) {
      polygons(f.geometry);
      g.fillStyle = fill; g.fill("evenodd");
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 0.3 * PT; g.stroke(); }
    }
  }
  g.lineCap = "round"; g.lineJoin = "round";
  for (const f of feats) if (f.properties.k === "stream") {
    lines(f.geometry); g.strokeStyle = "#8ab8de"; g.lineWidth = (["river", "canal"].includes(f.properties.t) ? 1.4 : 0.7) * PT; g.stroke();
  }
  for (const t of ["path", "track", "service", "street", "major"]) {
    const [col, casing, wd, dash] = ROAD_STYLE[t];
    const sel = feats.filter((f) => f.properties.k === "road" && (f.properties.t || "service") === t);
    if (casing) for (const f of sel) { lines(f.geometry); g.setLineDash([]); g.strokeStyle = casing; g.lineWidth = (wd + 0.8) * PT; g.stroke(); }
    for (const f of sel) { lines(f.geometry); g.setLineDash(dash ? dash.map((x) => x * PT) : []); g.strokeStyle = col; g.lineWidth = wd * PT; g.stroke(); }
  }
  g.setLineDash([]);
  for (const f of feats) if (f.properties.k === "railway") { lines(f.geometry); g.strokeStyle = "#7b7b7b"; g.lineWidth = 1 * PT; g.stroke(); }

  // walking network coloured by distance (unreachable first)
  const S = net.segments;
  const order = Array.from({ length: S.count }, (_, i) => i).sort((a, b2) => (Number.isFinite(d[a]) ? 1 : 0) - (Number.isFinite(d[b2]) ? 1 : 0));
  for (const [col, wd] of [["#ffffff", 3.2], [null, 2.0]]) {
    g.lineWidth = wd * PT;
    for (const k of order) {
      g.beginPath();
      path(S.ll[k]);
      g.strokeStyle = col || colorFor(d[k], settings);
      g.stroke();
    }
  }
  // basemap labels
  g.textAlign = "center"; g.textBaseline = "middle";
  for (const f of feats) {
    const p = f.properties;
    if (p.k !== "label" && p.k !== "place") continue;
    const [x, y] = P(...f.geometry.coordinates);
    g.save();
    g.translate(x, y);
    if (p.k === "label") { g.rotate(-(p.a || 0) * Math.PI / 180); g.translate(0, -2.6 * PT); }
    g.font = p.k === "place" ? font(11, true) : font(5.5);
    g.lineWidth = 2 * PT; g.strokeStyle = "#ffffff"; g.strokeText(p.n || "", 0, 0);
    g.fillStyle = p.k === "place" ? "#2b2f35" : "#4b5057"; g.fillText(p.n || "", 0, 0);
    g.restore();
  }
  // containers
  const typesByKey = Object.fromEntries(types.map((t) => [t.key, t]));
  for (const f of fc.features) {
    const p = f.properties;
    if (layer !== SUMMARY && p.typ !== layer) continue;
    const t = typesByKey[p.typ] || { color: "#555555", abbr: "?" };
    const [x, y] = P(...f.geometry.coordinates);
    g.beginPath(); g.arc(x, y, 5 * PT, 0, 2 * Math.PI);
    g.fillStyle = t.color; g.fill(); g.lineWidth = 0.8 * PT; g.strokeStyle = "#222"; g.stroke();
    g.font = font(4.6, true); g.fillStyle = isLight(t.color) ? "#222" : "#fff"; g.fillText(t.abbr, x, y);
  }
  // scale bar
  const len = niceLength(w / 5);
  const sx = MX + MW * 0.03, sy = MY + MH * 0.965;
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.fillRect(sx - MW * 0.01, sy - MH * 0.042, len * m + MW * 0.02, MH * 0.06);
  g.strokeStyle = "#222"; g.lineWidth = 2.2 * PT; g.lineCap = "butt";
  g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + len * m, sy); g.stroke();
  g.lineWidth = 1.2 * PT;
  for (const xx of [sx, sx + len * m]) { g.beginPath(); g.moveTo(xx, sy - MH * 0.006); g.lineTo(xx, sy + MH * 0.006); g.stroke(); }
  g.font = font(8); g.fillStyle = "#222"; g.textBaseline = "bottom";
  g.fillText(len >= 1000 ? `${len / 1000} km` : `${len} m`, sx + len * m / 2, sy - MH * 0.012);
  // north arrow
  const nx = MX + MW * 0.965, ny = MY + MH * 0.045;
  g.beginPath(); g.moveTo(nx, ny); g.lineTo(nx - 3 * PT, ny + 8 * PT); g.lineTo(nx + 3 * PT, ny + 8 * PT); g.closePath(); g.fillStyle = "#222"; g.fill();
  g.font = font(10, true); g.textBaseline = "top"; g.fillText("S", nx, ny + 10 * PT);
  // attribution
  g.font = font(6.5); g.textAlign = "right"; g.textBaseline = "bottom";
  const aw = g.measureText(attribution).width;
  g.fillStyle = "rgba(255,255,255,0.8)"; g.fillRect(MX + MW - aw - 12, MY + MH - 6.5 * PT - 10, aw + 12, 6.5 * PT + 10);
  g.fillStyle = "#222"; g.fillText(attribution, MX + MW - 6, MY + MH - 4);
  g.restore();
  g.strokeStyle = "#444"; g.lineWidth = 0.8 * PT; g.strokeRect(MX, MY, MW, MH);

  // title and date
  const name = layerName(layer, types);
  g.textAlign = "left"; g.textBaseline = "middle"; g.fillStyle = "#111";
  g.font = font(17, true); g.fillText(title, MX, HEIGHT * 0.045);
  g.font = font(11); g.fillStyle = "#333"; g.fillText(`${name} · stav k ${new Date().toLocaleDateString("cs-CZ")}`, MX, HEIGHT * 0.095);

  // legend
  const LX = 0.745 * WIDTH, LW = 0.23 * WIDTH;
  let y = MY;
  const row = (txt, size, bold, col = "#222") => { g.font = font(size, bold); g.fillStyle = col; g.textAlign = "left"; g.textBaseline = "top"; g.fillText(txt, LX, y); y += size * PT * 1.45; };
  row("Legenda", 12, true);
  y += 10;
  row(name + ":", 8.5, false);
  for (const r of wrap(g, layer === SUMMARY ? SUMMARY_CAPTION : TYPE_CAPTION, LW, font(8.5))) row(r, 8.5, false);
  y += 20;
  const items = settings.mode === "continuous" ? [] : settings.band_colors.map((b2, i) => [b2, bandLabel(i, settings.bands)]);
  if (settings.mode === "continuous") {
    const mx = settings.continuous_max_m;
    for (let i = 0; i < 100; i++) { g.fillStyle = continuousColor((i / 100) * mx, mx); g.fillRect(LX + i * LW * 0.008, y, LW * 0.008 + 1, 30); }
    y += 40;
    g.font = font(8); g.fillStyle = "#222"; g.fillText("0 m", LX, y); g.textAlign = "right"; g.fillText(`${mx} m+`, LX + LW * 0.8, y); g.textAlign = "left";
    y += 50;
  }
  items.push([settings.unreachable_color, "nedosažitelné"]);
  for (const [col, txt] of items) {
    g.strokeStyle = col; g.lineWidth = 4 * PT; g.lineCap = "round";
    g.beginPath(); g.moveTo(LX + 10, y + 20); g.lineTo(LX + LW * 0.12, y + 20); g.stroke();
    g.font = font(9.5); g.fillStyle = "#222"; g.textBaseline = "middle"; g.fillText(txt, LX + LW * 0.16, y + 20);
    y += 9.5 * PT * 1.9;
  }
  y += 20;
  row("Délka sítě v pásmech", 9.5, true);
  const total = S.length.reduce((a, x) => a + x, 0);
  for (const i of [...settings.bands.map((_, i) => i), settings.bands.length, -1]) {
    let s = 0;
    for (let k = 0; k < S.count; k++) if (band(d[k], settings.bands) === i) s += S.length[k];
    g.font = font(8.5); g.fillStyle = "#222"; g.textBaseline = "top"; g.textAlign = "left";
    g.fillText(bandLabel(i, settings.bands), LX, y);
    g.textAlign = "right";
    g.fillText(`${(s / 1000).toFixed(2).replace(".", ",")} km (${total ? Math.round(s / total * 100) : 0} %)`, LX + LW, y);
    y += 8.5 * PT * 1.6;
  }
  g.textAlign = "left";
  y += 20;
  row("Kontejnery", 9.5, true);
  const counts = {};
  for (const f of fc.features) counts[f.properties.typ] = (counts[f.properties.typ] || 0) + 1;
  for (const t of layer === SUMMARY ? types : types.filter((t2) => t2.key === layer)) {
    g.beginPath(); g.arc(LX + 25, y + 18, 4.5 * PT, 0, 2 * Math.PI); g.fillStyle = t.color; g.fill(); g.lineWidth = 0.8 * PT; g.strokeStyle = "#222"; g.stroke();
    g.font = font(9); g.fillStyle = "#222"; g.textBaseline = "middle"; g.fillText(`${t.name} (${counts[t.key] || 0}×)`, LX + LW * 0.16, y + 18);
    y += 9 * PT * 1.8;
  }
  g.font = font(7); g.fillStyle = "#444"; g.textBaseline = "bottom";
  const sources = [`Data: ${attribution}`, `Podklad: ${basemapMode === "none" ? "žádný" : "vektorová data OSM"}`,
    "Výpočet: nejkratší cesta po síti pěších cest", "(výsledek závisí na úplnosti cest v OSM)"];
  sources.forEach((r, i) => g.fillText(r, LX, MY + MH - (sources.length - 1 - i) * 7 * PT * 1.35));

  if (c.convertToBlob) return c.convertToBlob({ type: "image/png" });
  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}

function isLight(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return false;
  return 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16) > 160;
}

function wrap(g, text, maxWidth, fnt) {
  g.font = fnt;
  const words = text.split(" ");
  const rows = [];
  let r = "";
  for (const w of words) {
    const attempt = r ? r + " " + w : w;
    if (g.measureText(attempt).width > maxWidth && r) { rows.push(r); r = w; } else r = attempt;
  }
  if (r) rows.push(r);
  return rows;
}

// ------------------------------------------------------------------ ZIP (stored, no compression)
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** files: [{name, blob}] */
export async function zip(files) {
  const enc = new TextEncoder();
  const parts = [], directory = [];
  let offset = 0;
  for (const f of files) {
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    parts.push(lh.buffer, name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    directory.push(cd.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const dirSize = directory.reduce((a, x) => a + x.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end.buffer], { type: "application/zip" });
}
