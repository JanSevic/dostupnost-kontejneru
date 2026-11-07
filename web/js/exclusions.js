// Parts of the walking network excluded from evaluation (e.g. forest paths). Excluded segments are not
// shown or counted in statistics, but people can still walk along them, so routing is unchanged.
//   {polygons: [[[lon, lat], ...], ...], edges: ["lon,lat|lon,lat", ...]}
// Edges are identified by the coordinates of their end nodes, so the exclusion survives a data update
// as long as the way itself does not change.
const r6 = (x) => Math.round(x * 1e6) / 1e6;

export function emptyExclusions() {
  return { polygons: [], edges: [] };
}

export function edgeKey(nodes, a, b) {
  const ka = r6(nodes[a][0]) + "," + r6(nodes[a][1]);
  const kb = r6(nodes[b][0]) + "," + r6(nodes[b][1]);
  return ka < kb ? ka + "|" + kb : kb + "|" + ka;
}

/** Cleans exclusions loaded from storage or a file. */
export function normaliseExclusions(raw) {
  const out = emptyExclusions();
  if (!raw || typeof raw !== "object") return out;
  for (const p of Array.isArray(raw.polygons) ? raw.polygons : []) {
    if (!Array.isArray(p)) continue;
    const ring = p.filter((c) => Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1]))
      .map((c) => [r6(+c[0]), r6(+c[1])]);
    if (ring.length >= 3) out.polygons.push(ring);
  }
  const seen = new Set();
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (typeof e === "string" && /^-?[\d.]+,-?[\d.]+\|-?[\d.]+,-?[\d.]+$/.test(e) && !seen.has(e)) {
      seen.add(e);
      out.edges.push(e);
    }
  }
  return out;
}

/** Ray casting; ring = [[lon, lat], ...] (closed or not). */
export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 1 for every segment excluded from evaluation.
 * @param data  network data {nodes, edges} the network was built from
 * @param net   result of buildNetwork(data, …)
 */
export function exclusionMask(data, net, exclusions) {
  const S = net.segments;
  const mask = new Uint8Array(S.count);
  const ex = exclusions || emptyExclusions();
  const keys = new Set(ex.edges || []);
  let edgeOff = null;
  if (keys.size) {
    edgeOff = new Uint8Array(data.edges.length);
    data.edges.forEach(([a, b], e) => { if (keys.has(edgeKey(data.nodes, a, b))) edgeOff[e] = 1; });
  }
  const polygons = (ex.polygons || []).map((ring) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    return { ring, w, s, e, n };
  });
  for (let k = 0; k < S.count; k++) {
    if (edgeOff && edgeOff[S.edge[k]]) { mask[k] = 1; continue; }
    if (!polygons.length) continue;
    const [lon, lat] = net.proj.toLL(S.mid[2 * k], S.mid[2 * k + 1]);
    for (const p of polygons) {
      if (lon >= p.w && lon <= p.e && lat >= p.s && lat <= p.n && pointInRing(lon, lat, p.ring)) { mask[k] = 1; break; }
    }
  }
  return mask;
}

/** Segment lengths for statistics: 0 for excluded segments. */
export function evaluatedLengths(lengths, mask) {
  const out = Float64Array.from(lengths);
  for (let k = 0; k < out.length; k++) if (mask[k]) out[k] = 0;
  return out;
}

export const maskToList = (mask) => {
  const out = [];
  for (let k = 0; k < mask.length; k++) if (mask[k]) out.push(k);
  return out;
};
