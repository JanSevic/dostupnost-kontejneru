// Walking network for the computation: nodes in metres, edges, adjacency and ~10 m segments.
import { projectionForBbox } from "./geo.js";

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * @param {{nodes: number[][], edges: number[][]}} data  nodes [lon, lat], edges [i, j]
 * @param {number[]} bbox  [west, south, east, north] – extent of the area
 */
export function buildNetwork(data, bbox, segmentLength = 10) {
  const proj = projectionForBbox(bbox);
  const n = data.nodes.length;
  const xy = new Float64Array(2 * n);
  data.nodes.forEach(([lon, lat], i) => {
    const [x, y] = proj.toXY(lon, lat);
    xy[2 * i] = x;
    xy[2 * i + 1] = y;
  });
  const E = data.edges.length;
  const eu = new Int32Array(E), ev = new Int32Array(E), L = new Float64Array(E);
  const degree = new Int32Array(n);
  data.edges.forEach(([a, b], e) => {
    eu[e] = a;
    ev[e] = b;
    L[e] = Math.hypot(xy[2 * b] - xy[2 * a], xy[2 * b + 1] - xy[2 * a + 1]);
    degree[a]++;
    degree[b]++;
  });
  // adjacency in CSR form
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + degree[i];
  const neighbour = new Int32Array(2 * E), neighbourL = new Float64Array(2 * E);
  const pos = start.slice(0, n);
  for (let e = 0; e < E; e++) {
    neighbour[pos[eu[e]]] = ev[e]; neighbourL[pos[eu[e]]++] = L[e];
    neighbour[pos[ev[e]]] = eu[e]; neighbourL[pos[ev[e]]++] = L[e];
  }
  // connected components (union–find)
  const parent = new Int32Array(n).map((_, i) => i);
  const root = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let e = 0; e < E; e++) { const ra = root(eu[e]), rb = root(ev[e]); if (ra !== rb) parent[ra] = rb; }
  const ids = new Map();
  const component = new Int32Array(E);
  for (let e = 0; e < E; e++) {
    const k = root(eu[e]);
    if (!ids.has(k)) ids.set(k, ids.size);
    component[e] = ids.get(k);
  }
  const componentLength = new Float64Array(ids.size);
  for (let e = 0; e < E; e++) componentLength[component[e]] += L[e];
  // segments
  let M = 0;
  const perEdge = new Int32Array(E);
  for (let e = 0; e < E; e++) { perEdge[e] = L[e] < 1e-6 ? 0 : Math.max(1, Math.round(L[e] / segmentLength)); M += perEdge[e]; }
  const sEdge = new Int32Array(M), sX = new Float64Array(M), sLength = new Float64Array(M);
  const sMid = new Float64Array(2 * M);
  const sLL = new Array(M);
  let k = 0;
  for (let e = 0; e < E; e++) {
    const ax = xy[2 * eu[e]], ay = xy[2 * eu[e] + 1], bx = xy[2 * ev[e]], by = xy[2 * ev[e] + 1];
    const p = perEdge[e];
    for (let i = 0; i < p; i++) {
      const f0 = i / p, f1 = (i + 1) / p, fm = (i + 0.5) / p;
      sEdge[k] = e;
      sX[k] = fm * L[e];
      sLength[k] = L[e] / p;
      sMid[2 * k] = ax + fm * (bx - ax);
      sMid[2 * k + 1] = ay + fm * (by - ay);
      const a = proj.toLL(ax + f0 * (bx - ax), ay + f0 * (by - ay));
      const b = proj.toLL(ax + f1 * (bx - ax), ay + f1 * (by - ay));
      sLL[k] = [[r6(a[0]), r6(a[1])], [r6(b[0]), r6(b[1])]];
      k++;
    }
  }
  let length = 0;
  for (let e = 0; e < E; e++) length += L[e];
  return {
    proj, bbox, xy, eu, ev, L, start, neighbour, neighbourL, component, componentLength,
    segments: { edge: sEdge, x: sX, length: sLength, mid: sMid, ll: sLL, count: M },
    lengthKm: length / 1000,
  };
}

export function bboxPolygon(bbox) {
  const [w, s, e, n] = bbox;
  return [[w, s], [e, s], [e, n], [w, n], [w, s]];
}
