import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fromXml, walkingNetwork, vectorBasemap } from "../js/osm.js";
import { buildNetwork } from "../js/network.js";
import { normaliseCollection, sourcesByType, summaryKeys, describeCollection, layerLabel } from "../js/collection.js";
import { normaliseExclusions, exclusionMask, edgeKey, evaluatedLengths, pointInRing, maskToList } from "../js/exclusions.js";
import { createState, validateState, computeState, compareState, SUMMARY_KEY } from "../js/state.js";
import { normaliseContainers } from "../js/backend.js";

const data = fromXml(readFileSync(new URL("./data/village_test.osm", import.meta.url), "utf8"));
const ref = JSON.parse(readFileSync(new URL("./data/parity.json", import.meta.url), "utf8"));
const wn = walkingNetwork(data);
const TYPES = [
  { key: "plast", name: "Plast", color: "#f2c200", abbr: "Pl" },
  { key: "papir", name: "Papír", color: "#1f63c6", abbr: "Pa" },
  { key: "kovy", name: "Kovy", color: "#7d8590", abbr: "Ko" },
];
const c = ref.containers;
const f = (id, typ, k) => ({ type: "Feature", geometry: { type: "Point", coordinates: [k.lon, k.lat] }, properties: { id, typ, poznamka: "" } });

function state({ sber, exclusions } = {}) {
  const containers = { type: "FeatureCollection", features: [f(1, "plast", c[0]), f(2, "plast", c[1]), f(3, "papir", c[2])] };
  if (sber) containers.sber = sber;
  return createState({
    name: "Test", meta: { name: "Vesnice Test", extent: ref.bbox, bbox: ref.bbox, downloaded: "2026-11-01T10:00:00" },
    network: wn, basemap: vectorBasemap(data, ref.bbox), exclusions, types: TYPES, containers,
    display: { bands: [100, 200], layer: "vse", mode: "continuous" },
  });
}
const copy = (o) => JSON.parse(JSON.stringify(o));

test("collection settings are cleaned", () => {
  assert.deepEqual(normaliseCollection(null), {});
  assert.deepEqual(normaliseCollection({
    papir: { od_domu: true }, kovy: { spolu_s: ["plast", "plast", "kovy", "Bad!"] }, sklo: { od_domu: "yes" }, "X y": { od_domu: true },
  }), { papir: { od_domu: true }, kovy: { spolu_s: ["plast"] } });
});

test("sources: own containers plus shared ones; door-to-door types leave the summary", () => {
  const fc = { type: "FeatureCollection", features: [f(1, "plast", c[0]), f(2, "papir", c[1])] };
  const col = normaliseCollection({ kovy: { spolu_s: ["plast"] }, papir: { od_domu: true } });
  const src = sourcesByType(fc, TYPES, col);
  assert.deepEqual(Object.keys(src), ["plast", "papir", "kovy"]);
  assert.deepEqual(src.kovy.map((p) => p.id), [1]);
  assert.deepEqual(summaryKeys(["plast", "papir", "kovy"], col), ["plast", "kovy"]);
  assert.equal(layerLabel(TYPES[1], col), "Papír – záložní místa");
  assert.deepEqual(describeCollection(col, TYPES), [
    "Svoz od domu: Papír (kontejnery jsou jen záložní místa).", "Kovy se sbírá také do kontejnerů: Plast."]);
});

test("computeState: shared type gets the result of its host type, door-to-door type is not in the summary", () => {
  const o = validateState(copy(state({ sber: { kovy: { spolu_s: ["plast"] }, papir: { od_domu: true } } })));
  const r = computeState(o);
  assert.deepEqual(Object.keys(r.results), ["plast", "papir", "kovy"]);
  assert.deepEqual(Array.from(r.results.kovy), Array.from(r.results.plast));
  assert.deepEqual(r.summaryTypes, ["plast", "kovy"]);
  for (let i = 0; i < r.summary.length; i++) assert.equal(r.summary[i], Math.max(r.results.plast[i], r.results.kovy[i]));
  assert.equal(o.display.mode, "continuous");
  // without settings: kovy has no containers, papír counts in the summary
  const plain = computeState(validateState(copy(state())));
  assert.deepEqual(Object.keys(plain.results), ["plast", "papir"]);
  assert.deepEqual(plain.summaryTypes, ["plast", "papir"]);
});

test("container files keep the collection settings", () => {
  const fc = { type: "FeatureCollection", sber: { kovy: { spolu_s: ["plast"] }, nic: {} },
    features: [f(1, "plast", c[0])] };
  assert.deepEqual(normaliseContainers(fc, TYPES).fc.sber, { kovy: { spolu_s: ["plast"] } });
  assert.equal("sber" in normaliseContainers({ type: "FeatureCollection", features: [] }, TYPES).fc, false);
});

test("exclusions: polygon and single edges", () => {
  assert.ok(pointInRing(0.5, 0.5, [[0, 0], [1, 0], [1, 1], [0, 1]]));
  assert.ok(!pointInRing(1.5, 0.5, [[0, 0], [1, 0], [1, 1], [0, 1]]));
  assert.deepEqual(normaliseExclusions({ polygons: [[[1, 2], [3, 4]], [[1, 2], [3, 4], [5, "x"], [6, 7]]], edges: ["a", "1,2|3,4", "1,2|3,4"] }),
    { polygons: [[[1, 2], [3, 4], [6, 7]]], edges: ["1,2|3,4"] });
  const net = buildNetwork(wn, ref.bbox);
  assert.equal(exclusionMask(wn, net, null).some(Boolean), false);
  // polygon over the western half of the area
  const [w, s, e, n] = ref.bbox, mid = (w + e) / 2;
  const half = exclusionMask(wn, net, { polygons: [[[w - 1, s - 1], [mid, s - 1], [mid, n + 1], [w - 1, n + 1]]], edges: [] });
  let lonOk = true;
  for (let k = 0; k < net.segments.count; k++) {
    const [lon] = net.proj.toLL(net.segments.mid[2 * k], net.segments.mid[2 * k + 1]);
    if (Boolean(half[k]) !== lon < mid) lonOk = false;
  }
  assert.ok(lonOk && half.some(Boolean) && !half.every(Boolean));
  // one edge
  const key = edgeKey(wn.nodes, ...wn.edges[0]);
  const one = exclusionMask(wn, net, { polygons: [], edges: [key] });
  assert.deepEqual(maskToList(one), maskToList(Uint8Array.from(net.segments.edge, (x) => (x === 0 ? 1 : 0))));
  const lengths = evaluatedLengths(net.segments.length, one);
  assert.ok(lengths.every((x, k) => (one[k] ? x === 0 : x === net.segments.length[k])));
});

test("exclusions travel in the state and only change the statistics", () => {
  const [w, s, e, n] = ref.bbox, mid = (w + e) / 2;
  const exclusions = { polygons: [[[w - 1, s - 1], [mid, s - 1], [mid, n + 1], [w - 1, n + 1]]], edges: [edgeKey(wn.nodes, ...wn.edges[5])] };
  const o = validateState(copy(state({ exclusions })));
  assert.deepEqual(o.area.exclusions, normaliseExclusions(exclusions));
  const r = computeState(o), plain = computeState(validateState(copy(state())));
  assert.deepEqual(Array.from(r.results.plast), Array.from(plain.results.plast)); // routing unchanged
  assert.ok(r.excluded.some(Boolean));
  assert.ok(r.lengths.reduce((a, x) => a + x, 0) < plain.lengths.reduce((a, x) => a + x, 0));
  const share = compareState(o, r, [100, 200]), sharePlain = compareState(o, plain, [100, 200]);
  assert.notDeepEqual(share.plast, sharePlain.plast);
  assert.ok(sharePlain.plast[1] > 0);
});
