// Walking distance to the nearest container along the network.
//  1. a container snaps perpendicularly to the nearest edge (u, v) of length L: position t from u, connection length s,
//  2. multi-source Dijkstra: u starts at s + t, v at s + L − t,
//  3. a segment at position x from u: d(x) = min(d(u) + x, d(v) + L − x); on an edge with a container also s + |x − t|.
import { projectOntoSegment } from "./geo.js";

export const SMALL_COMPONENT_M = 500;

/** points: [{id, lon, lat}] -> [{id, edge, t, s, outside, isolated}] */
export function snapContainers(net, points) {
  const [w, s, e, n] = net.bbox;
  const E = net.eu.length;
  return points.map((p) => {
    if (!(p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n) || E === 0) {
      return { id: p.id, edge: null, t: 0, s: 0, outside: true, isolated: false };
    }
    const [px, py] = net.proj.toXY(p.lon, p.lat);
    let best = null;
    for (let k = 0; k < E; k++) {
      const a = net.eu[k], b = net.ev[k];
      const q = projectOntoSegment(px, py, net.xy[2 * a], net.xy[2 * a + 1], net.xy[2 * b], net.xy[2 * b + 1]);
      if (!best || q.d < best.d) best = { e: k, d: q.d, t: q.t * net.L[k] };
    }
    return { id: p.id, edge: best.e, t: best.t, s: best.d, outside: false, isolated: false };
  });
}

/** Binary heap of (distance, node). */
class Heap {
  constructor() { this.d = []; this.u = []; }
  get size() { return this.d.length; }
  push(d, u) {
    const D = this.d, U = this.u;
    let i = D.length;
    D.push(d); U.push(u);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (D[p] <= d) break;
      D[i] = D[p]; U[i] = U[p]; i = p;
    }
    D[i] = d; U[i] = u;
  }
  pop() {
    const D = this.d, U = this.u;
    const d0 = D[0], u0 = U[0];
    const d = D.pop(), u = U.pop();
    const n = D.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && D[c + 1] < D[c]) c++;
        if (D[c] >= d) break;
        D[i] = D[c]; U[i] = U[c]; i = c;
      }
      D[i] = d; U[i] = u;
    }
    return [d0, u0];
  }
}

export function dijkstra(net, initial) {
  const n = net.xy.length / 2;
  const d = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const h = new Heap();
  for (const [u, val] of initial) if (val < d[u]) { d[u] = val; h.push(val, u); }
  while (h.size) {
    const [du, u] = h.pop();
    if (done[u]) continue;
    done[u] = 1;
    for (let k = net.start[u]; k < net.start[u + 1]; k++) {
      const v = net.neighbour[k], nd = du + net.neighbourL[k];
      if (nd < d[v]) { d[v] = nd; h.push(nd, v); }
    }
  }
  return d;
}

export function distances(net, snaps) {
  const valid = snaps.filter((p) => p.edge !== null);
  const init = new Map();
  for (const p of valid) {
    const e = p.edge, u = net.eu[e], v = net.ev[e], L = net.L[e];
    for (const [node, h] of [[u, p.s + p.t], [v, p.s + L - p.t]]) {
      if (h < (init.has(node) ? init.get(node) : Infinity)) init.set(node, h);
    }
  }
  const dNodes = dijkstra(net, init);
  const S = net.segments;
  const dSeg = new Float64Array(S.count);
  const onEdge = new Map();
  for (const p of valid) {
    if (!onEdge.has(p.edge)) onEdge.set(p.edge, []);
    onEdge.get(p.edge).push(p);
  }
  for (let k = 0; k < S.count; k++) {
    const e = S.edge[k], x = S.x[k], L = net.L[e];
    let d = Math.min(dNodes[net.eu[e]] + x, dNodes[net.ev[e]] + (L - x));
    const here = onEdge.get(e);
    if (here) for (const p of here) d = Math.min(d, p.s + Math.abs(x - p.t));
    dSeg[k] = d;
  }
  return { dNodes, dSeg };
}

/** Computation for one waste type. points: [{id, lon, lat}] */
export function computeType(net, typeName, points, warnConnectionM = 30) {
  const snaps = snapContainers(net, points);
  const warnings = [];
  const outside = snaps.filter((p) => p.outside);
  if (outside.length) {
    warnings.push(`${typeName}: ${outside.length} kontejner(ů) leží mimo oblast a nebyl(y) započítán(y) (č. ${outside.map((p) => p.id).join(", ")}).`);
  }
  let total = 0;
  for (const x of net.componentLength) total += x;
  for (const p of snaps) {
    if (p.edge === null) continue;
    if (p.s > warnConnectionM) warnings.push(`${typeName}: kontejner č. ${p.id} je od nejbližší cesty ${Math.round(p.s)} m (víc než ${warnConnectionM} m).`);
    const cl = net.componentLength[net.component[p.edge]];
    if (cl < Math.min(SMALL_COMPONENT_M, 0.05 * total)) {
      p.isolated = true;
      warnings.push(`${typeName}: kontejner č. ${p.id} je připojený k izolovanému kousku cesty (${Math.round(cl)} m), ` +
        "který nenavazuje na zbytek sítě. Posuň ho blíž k hlavní cestě nebo doplň spojení v OSM.");
    }
  }
  const { dNodes, dSeg } = distances(net, snaps);
  return { d: dSeg, dNodes, snaps, warnings };
}

/** "All types" layer: maximum over types for each segment. */
export function summary(arrays, count) {
  const out = new Float64Array(count).fill(arrays.length ? -Infinity : Infinity);
  for (const d of arrays) for (let i = 0; i < count; i++) if (d[i] > out[i]) out[i] = d[i];
  return out;
}

/** Network distance must never be smaller than the straight-line distance to the nearest container. */
export function checkStraightLine(net, d, points, tolerance = 1e-6) {
  const xy = points.map((p) => net.proj.toXY(p.lon, p.lat));
  let violated = 0, checked = 0, minMargin = Infinity;
  const M = net.segments.mid;
  for (let k = 0; k < d.length; k++) {
    if (!Number.isFinite(d[k])) continue;
    checked++;
    let straight = Infinity;
    for (const [x, y] of xy) straight = Math.min(straight, Math.hypot(M[2 * k] - x, M[2 * k + 1] - y));
    const r = d[k] - straight;
    if (r < minMargin) minMargin = r;
    if (r < -tolerance) violated++;
  }
  return { ok: violated === 0, violated, checked, min_margin_m: minMargin };
}

/** Band index: 0 = nearest; -1 = unreachable. */
export function band(d, limits) {
  if (d === null || d === undefined || !Number.isFinite(d)) return -1;
  for (let i = 0; i < limits.length; i++) if (d <= limits[i]) return i;
  return limits.length;
}
