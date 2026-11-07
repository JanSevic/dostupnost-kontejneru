import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectionForBbox, expandBbox, areaKm2 } from "../js/geo.js";
import { buildNetwork } from "../js/network.js";
import { computeType, checkStraightLine, summary, band, dijkstra } from "../js/compute.js";
import { isWalkable, fromXml, fromJson, walkingNetwork, vectorBasemap, dataBbox, rings, overpassQuery } from "../js/osm.js";

const BBOX = [14.39, 50.26, 14.43, 50.28];
const P = projectionForBbox(BBOX);

/** network from points in metres: nodes {name: [x, y]}, edges [[a, b]] */
function net(nodes, edges, segLength = 10) {
  const names = Object.keys(nodes);
  const idx = Object.fromEntries(names.map((n, i) => [n, i]));
  return buildNetwork({ nodes: names.map((n) => P.toLL(...nodes[n])), edges: edges.map(([a, b]) => [idx[a], idx[b]]) }, BBOX, segLength);
}
const point = (x, y, id = 1) => { const [lon, lat] = P.toLL(x, y); return { id, lon, lat }; };
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("line A–B–C: nodes and segments follow the formula", () => {
  const s = net({ A: [0, 0], B: [100, 0], C: [250, 0] }, [["A", "B"], ["B", "C"]]);
  const r = computeType(s, "Plast", [point(30, 5)]);
  close(r.snaps[0].t, 30, 1e-6);
  close(r.snaps[0].s, 5, 1e-6);
  close(r.dNodes[0], 35); close(r.dNodes[1], 75); close(r.dNodes[2], 225);
  const S = s.segments;
  assert.equal(S.count, 25);
  for (let k = 0; k < S.count; k++) {
    const x = S.x[k];
    if (S.edge[k] === 0) close(r.d[k], 5 + Math.abs(x - 30));
    else close(r.d[k], 75 + x);
  }
});

test("inside an edge min(d(u)+x, d(v)+L−x)", () => {
  const s = net({ A: [0, 0], B: [200, 0], P: [-50, 0], Q: [260, 0] }, [["P", "A"], ["A", "B"], ["B", "Q"]]);
  const r = computeType(s, "Papír", [point(-50, 0, 1), point(260, 0, 2)]);
  for (let k = 0; k < s.segments.count; k++) if (s.segments.edge[k] === 1) {
    const x = s.segments.x[k];
    close(r.d[k], Math.min(50 + x, 60 + 200 - x));
  }
});

test("unreachable component is Infinity, a container outside the area is not counted", () => {
  const s = net({ A: [0, 0], B: [100, 0], C: [0, 300], D: [100, 300] }, [["A", "B"], ["C", "D"]]);
  const far = { id: 9, lon: 15.5, lat: 50.27 };
  const r = computeType(s, "Plast", [point(50, 1), far]);
  assert.ok(r.snaps[1].outside);
  assert.ok(r.warnings.some((v) => v.includes("mimo oblast")));
  for (let k = 0; k < s.segments.count; k++) assert.equal(Number.isFinite(r.d[k]), s.segments.edge[k] === 0);
});

test("warnings: far from a road and isolated piece of road", () => {
  const s = net({ A: [0, 0], B: [1000, 0], C: [500, 100], D: [530, 100] }, [["A", "B"], ["C", "D"]]);
  const r = computeType(s, "Plast", [point(500, 40, 7), point(515, 103, 8)]);
  assert.ok(r.warnings.some((v) => v.includes("č. 7") && v.includes("40 m")));
  assert.ok(r.snaps[1].isolated);
});

function randomNetwork(seed) {
  let x = seed * 9301 + 49297;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const nodes = {}, edges = [];
  const n = 6;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) nodes[`${i},${j}`] = [i * 80 + rnd() * 30 - 15, j * 80 + rnd() * 30 - 15];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (const [di, dj] of [[1, 0], [0, 1]]) {
    if (i + di < n && j + dj < n && rnd() > 0.15) edges.push([`${i},${j}`, `${i + di},${j + dj}`]);
  }
  const points = [0, 1, 2, 3, 4].map((k) => point(rnd() * 440 - 20, rnd() * 440 - 20, k + 1));
  return { s: net(nodes, edges), points };
}

/** Reference computation: network densified at segment midpoints and container projections + plain Dijkstra. */
function bruteForce(s, snaps) {
  const onEdge = new Map(); // edge -> [[x, nodeId]]
  let next = s.xy.length / 2;
  const newNode = () => next++;
  for (let e = 0; e < s.L.length; e++) onEdge.set(e, [[0, s.eu[e]], [s.L[e], s.ev[e]]]);
  const mids = new Int32Array(s.segments.count);
  for (let k = 0; k < s.segments.count; k++) { const id = newNode(); mids[k] = id; onEdge.get(s.segments.edge[k]).push([s.segments.x[k], id]); }
  const sources = [];
  for (const p of snaps) if (p.edge !== null) { const id = newNode(); onEdge.get(p.edge).push([p.t, id]); sources.push([id, p.s]); }
  const adj = new Map();
  const link = (a, b, w) => { for (const [u, v] of [[a, b], [b, a]]) { if (!adj.has(u)) adj.set(u, []); adj.get(u).push([v, w]); } };
  for (const [, list] of onEdge) {
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < list.length; i++) link(list[i - 1][1], list[i][1], list[i][0] - list[i - 1][0]);
  }
  const d = new Map();
  for (const [u, w] of sources) d.set(u, Math.min(w, d.get(u) ?? Infinity));
  // simple (slow) Dijkstra for a small network
  const done = new Set();
  for (;;) {
    let best = null;
    for (const [u, w] of d) if (!done.has(u) && (best === null || w < best[1])) best = [u, w];
    if (!best) break;
    done.add(best[0]);
    for (const [v, w] of adj.get(best[0]) || []) if (best[1] + w < (d.get(v) ?? Infinity)) d.set(v, best[1] + w);
  }
  return Array.from(mids, (id) => d.get(id) ?? Infinity);
}

for (const seed of [1, 2, 3, 4, 5]) {
  test(`matches brute force and network ≥ straight-line check (seed ${seed})`, () => {
    const { s, points } = randomNetwork(seed);
    const r = computeType(s, "Plast", points);
    const ref = bruteForce(s, r.snaps);
    for (let k = 0; k < ref.length; k++) {
      assert.equal(Number.isFinite(r.d[k]), Number.isFinite(ref[k]));
      if (Number.isFinite(ref[k])) close(r.d[k], ref[k], 1e-6);
    }
    const chk = checkStraightLine(s, r.d, points.filter((_, i) => !r.snaps[i].outside));
    assert.ok(chk.ok, JSON.stringify(chk));
  });
}

test("summary, bands, Dijkstra without sources", () => {
  assert.deepEqual(Array.from(summary([[1, 5, Infinity], [3, 2, 1]], 3)), [3, 5, Infinity]);
  assert.ok(Array.from(summary([], 2)).every((x) => x === Infinity));
  assert.equal(band(100, [100, 200]), 0);
  assert.equal(band(100.1, [100, 200]), 1);
  assert.equal(band(250, [100, 200]), 2);
  assert.equal(band(Infinity, [100, 200]), -1);
  const s = net({ A: [0, 0], B: [10, 0] }, [["A", "B"]]);
  assert.ok(Array.from(dijkstra(s, new Map())).every((x) => x === Infinity));
});

test("walkable-way filter", () => {
  const p = (t) => isWalkable(t);
  assert.ok(p({ highway: "residential" }));
  assert.ok(p({ highway: "cycleway" }));
  assert.ok(!p({ highway: "cycleway", foot: "no" }));
  assert.ok(!p({ highway: "footway", access: "private" }));
  assert.ok(p({ highway: "pedestrian", access: "no", foot: "yes" }));
  assert.ok(!p({ highway: "service", service: "private" }));
  assert.ok(!p({ highway: "motorway" }));
  assert.ok(!p({ highway: "pedestrian", area: "yes" }));
  assert.ok(!p({}));
});

test("bbox with margin and area", () => {
  const b = expandBbox([14.39, 50.27, 14.40, 50.28], 300);
  close((50.27 - b[1]) * 111320, 300, 1e-6);
  close(areaKm2(b), 1.31 * 1.71, 0.08);
});

test("matches the desktop (Python) version on the made-up village Test", () => {
  const xml = readFileSync(new URL("./data/village_test.osm", import.meta.url), "utf8");
  const ref = JSON.parse(readFileSync(new URL("./data/parity.json", import.meta.url), "utf8"));
  const data = fromXml(xml);
  const wn = walkingNetwork(data);
  const s = buildNetwork(wn, ref.bbox);
  close(s.lengthKm, ref.length_km, ref.length_km * 0.002);
  const r = computeType(s, "Plast", ref.containers);
  // OSM node id -> index in the JS network
  const idByPosition = new Map();
  for (const [id, ll] of data.nodes) idByPosition.set(ll.join(","), id);
  let compared = 0;
  wn.nodes.forEach((ll, i) => {
    const id = idByPosition.get(ll.join(","));
    if (ref.nodes[id] !== undefined) {
      const expected = ref.nodes[id];
      assert.ok(Math.abs(r.dNodes[i] - expected) <= 0.5 + expected * 0.002, `node ${id}: ${r.dNodes[i]} vs ${expected}`);
      compared++;
    }
  });
  assert.ok(compared >= 10, "compared " + compared);
  assert.ok(checkStraightLine(s, r.d, ref.containers).ok);
});

test("vector basemap from .osm", () => {
  const data = fromXml(readFileSync(new URL("./data/village_test.osm", import.meta.url), "utf8"));
  const fc = vectorBasemap(data, dataBbox(data));
  for (const k of ["building", "water", "stream", "forest", "green", "railway", "road", "label", "place"]) assert.ok(fc.summary[k] > 0, k);
  const place = fc.features.find((f) => f.properties.k === "place");
  assert.equal(place.properties.n, "Test");
});

test("Overpass response (out geom) including a multipolygon", () => {
  const json = { elements: [
    { type: "node", id: 1, lat: 50.27, lon: 14.40, tags: { place: "village", name: "Test" } },
    { type: "way", id: 10, nodes: [2, 3, 4], tags: { highway: "residential" },
      geometry: [{ lat: 50.27, lon: 14.40 }, { lat: 50.271, lon: 14.40 }, { lat: 50.272, lon: 14.401 }] },
    { type: "way", id: 11, nodes: [4, 5], tags: { highway: "footway" }, geometry: [{ lat: 50.272, lon: 14.401 }, { lat: 50.272, lon: 14.403 }] },
    { type: "relation", id: 20, tags: { type: "multipolygon", landuse: "forest" }, members: [
      { type: "way", role: "outer", geometry: [{ lat: 50.26, lon: 14.40 }, { lat: 50.26, lon: 14.41 }] },
      { type: "way", role: "outer", geometry: [{ lat: 50.25, lon: 14.40 }, { lat: 50.26, lon: 14.40 }] },
      { type: "way", role: "outer", geometry: [{ lat: 50.26, lon: 14.41 }, { lat: 50.25, lon: 14.40 }] },
    ] },
  ] };
  const data = fromJson(json);
  const wn = walkingNetwork(data);
  assert.equal(wn.edges.length, 3);
  assert.equal(wn.nodes.length, 4); // node 4 is shared
  const fc = vectorBasemap(data, [14.39, 50.24, 14.42, 50.28]);
  assert.equal(fc.summary.forest, 1);
  assert.equal(rings([{ geom: [[0, 0], [1, 0]] }, { geom: [[1, 1], [1, 0]] }, { geom: [[1, 1], [0, 0]] }]).length, 1);
  assert.ok(overpassQuery([14.39, 50.26, 14.43, 50.28]).includes('way["highway"](50.260000,14.390000,50.280000,14.430000)'));
});
