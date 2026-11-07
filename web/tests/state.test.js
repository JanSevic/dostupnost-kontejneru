import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromXml, walkingNetwork, vectorBasemap } from "../js/osm.js";
import { buildNetwork } from "../js/network.js";
import { computeType } from "../js/compute.js";
import {
  FORMAT, VERSION, SUMMARY_KEY, createState, validateState, stateSummary, sortStateList, computeState, shareWithin,
  stateFileName, stateLayers, compareState, parseLink, buildLink,
} from "../js/state.js";
import { buildList, writeList, LIST_FORMAT } from "../tools/presets-index.mjs";

const data = fromXml(readFileSync(new URL("./data/village_test.osm", import.meta.url), "utf8"));
const ref = JSON.parse(readFileSync(new URL("./data/parity.json", import.meta.url), "utf8"));
const wn = walkingNetwork(data);

const TYPES = [
  { key: "plast", name: "Plast", color: "#f2c200", abbr: "Pl" },
  { key: "papir", name: "Papír", color: "#1f63c6", abbr: "Pa" },
  { key: "sklo", name: "Sklo", color: "#1b8a3a", abbr: "Sk" },
];

function containers() {
  const f = (id, typ, lon, lat, poznamka = "") => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { id, typ, poznamka } });
  return {
    type: "FeatureCollection",
    features: [
      ...ref.containers.map((k) => f(k.id, "plast", k.lon, k.lat, k.id === 1 ? "u obchodu, 2 nádoby" : "")),
      f(10, "papir", ref.containers[0].lon, ref.containers[0].lat),
    ],
  };
}

function state(overrides = {}) {
  return createState({
    name: "Současný stav", description: "Rozmístění k 1. 11. 2026", order: 1,
    meta: { name: "Vesnice Test", extent: ref.bbox, bbox: ref.bbox, downloaded: "2026-11-01T10:00:00", source: "soubor .osm",
      attribution: "© přispěvatelé OpenStreetMap (data ODbL)", area_km2: 1.75 },
    network: wn, basemap: vectorBasemap(data, ref.bbox), types: TYPES, containers: containers(),
    display: { bands: [100, 200], layer: "plast" },
    ...overrides,
  });
}

const copy = (o) => JSON.parse(JSON.stringify(o));

test("a state survives saving and loading without loss", () => {
  const o = state();
  assert.equal(o.format, FORMAT);
  assert.equal(o.version, VERSION);
  const n = validateState(copy(o));
  assert.deepEqual(n, o);
  assert.equal(n.name, "Současný stav");
  assert.equal(n.description, "Rozmístění k 1. 11. 2026");
  assert.deepEqual(n.containers, containers());
  assert.deepEqual(n.types, TYPES);
  assert.deepEqual(n.display, { bands: [100, 200], layer: "plast" });
  assert.deepEqual(n.area.network.edges, wn.edges);
  n.area.network.nodes.forEach(([x, y], i) => {
    assert.ok(Math.abs(x - wn.nodes[i][0]) <= 6e-7 && Math.abs(y - wn.nodes[i][1]) <= 6e-7, `node ${i}`);
  });
  assert.ok(n.area.basemap.features.length > 0);
  // rounding the coordinates changes the result by a few centimetres at most
  const original = computeType(buildNetwork(wn, ref.bbox), "Plast", ref.containers).d;
  const r = computeState(n);
  assert.equal(r.results.plast.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.equal(Number.isFinite(r.results.plast[i]), Number.isFinite(original[i]));
    if (Number.isFinite(original[i])) assert.ok(Math.abs(r.results.plast[i] - original[i]) < 0.2, `segment ${i}`);
  }
});

test("createState requires a name and trims text", () => {
  assert.throws(() => state({ name: "  " }), /název/);
  const o = state({ name: "  Návrh 1 ", description: " x ", order: "2" });
  assert.equal(o.name, "Návrh 1");
  assert.equal(o.description, "x");
  assert.equal(o.order, 2);
  assert.equal(state({ order: "" }).order, null);
  assert.equal(state({ display: { bands: ["150", "300"] } }).display.layer, SUMMARY_KEY);
});

test("validateState rejects invalid files", () => {
  const bad = [
    [null, /není uložený stav/],
    [[], /není uložený stav/],
    [{ type: "FeatureCollection", features: [] }, /není uložený stav/],
    [{ ...copy(state()), format: "other" }, /není uložený stav/],
    [{ ...copy(state()), version: VERSION + 1 }, /novější verzí/],
    [{ ...copy(state()), version: "x" }, /novější verzí/],
  ];
  const changed = (fn) => { const o = copy(state()); fn(o); return o; };
  bad.push(
    [changed((o) => { delete o.area.network; }), /pěší síť/],
    [changed((o) => { o.area.network.edges = []; }), /pěší síť/],
    [changed((o) => { o.area.bbox = [1, 2, 3]; }), /rozsah/],
    [changed((o) => { o.containers = {}; }), /kontejnery/],
    [changed((o) => { o.types = []; }), /typy/],
    [changed((o) => { delete o.display; }), /pásma/],
    [changed((o) => { o.display.bands = [200, 100]; }), /pásma/],
    [changed((o) => { o.display.bands = [0, 100]; }), /pásma/],
    [changed((o) => { o.display.bands = ["100", 200]; }), /pásma/],
  );
  for (const [o, err] of bad) assert.throws(() => validateState(o), err, JSON.stringify(o).slice(0, 80));
  assert.doesNotThrow(() => validateState({ ...copy(state()), version: 0 }));
});

test("computeState matches the parity data from the Python version", () => {
  const o = validateState(copy(state()));
  const r = computeState(o);
  assert.deepEqual(Object.keys(r.results).sort(), ["papir", "plast"]);
  assert.deepEqual(r.summaryTypes, ["plast", "papir"]);
  assert.ok(Math.abs(r.net.lengthKm - ref.length_km) <= ref.length_km * 0.002);
  // node distances against Python (OSM node id by position)
  const idByPosition = new Map();
  for (const [id, ll] of data.nodes) idByPosition.set(ll.join(","), id);
  let compared = 0;
  wn.nodes.forEach((ll, i) => {
    const expected = ref.nodes[idByPosition.get(ll.join(","))];
    if (expected === undefined) return;
    assert.ok(Math.abs(r.nodes.plast[i] - expected) <= 0.5 + expected * 0.002, `node ${i}: ${r.nodes.plast[i]} vs ${expected}`);
    compared++;
  });
  assert.ok(compared >= 10, "compared " + compared);
  // summary = maximum over types
  for (let i = 0; i < r.summary.length; i++) {
    assert.equal(r.summary[i], Math.max(r.results.plast[i], r.results.papir[i]));
  }
  assert.deepEqual(stateLayers(o, r), ["plast", "papir", SUMMARY_KEY]);
});

test("comparing states and share of network within a limit", () => {
  assert.equal(shareWithin([10, 150, Infinity], [1, 1, 2], 100), 0.25);
  assert.equal(shareWithin([10, 150, Infinity], [1, 1, 2], 200), 0.5);
  assert.equal(shareWithin([], [], 100), 0);
  const o = validateState(copy(state()));
  const r = computeState(o);
  const c = compareState(o, r, [100, 200]);
  assert.deepEqual(Object.keys(c), ["plast", "papir", SUMMARY_KEY]);
  for (const k of Object.keys(c)) {
    assert.equal(c[k].length, 2);
    assert.ok(c[k][0] >= 0 && c[k][0] <= c[k][1] && c[k][1] <= 1);
  }
  // the summary is the worst of the types; paper has a single container
  assert.ok(c[SUMMARY_KEY][1] <= c.plast[1] && c[SUMMARY_KEY][1] <= c.papir[1]);
  assert.ok(c.papir[1] < c.plast[1]);
});

test("file name, list entry and list order", () => {
  assert.equal(stateFileName("Současný stav", 1), "01-soucasny-stav.json");
  assert.equal(stateFileName("Návrh 1", 2), "02-navrh-1.json");
  assert.equal(stateFileName("Žluťoučký kůň!", null), "zlutoucky-kun.json");
  assert.equal(stateFileName("???", 0), "stav.json");
  const e = stateSummary(state(), "01-soucasny-stav.json");
  assert.equal(e.containers, 5);
  assert.deepEqual(e.counts, { plast: 4, papir: 1 });
  assert.equal(e.area, "Vesnice Test");
  const sorted = sortStateList([
    { file: "b.json", order: null }, { file: "c.json", order: 2 }, { file: "a.json", order: null }, { file: "d.json", order: 1 },
  ]);
  assert.deepEqual(sorted.map((x) => x.file), ["d.json", "c.json", "a.json", "b.json"]);
});

test("link to a state and layer", () => {
  assert.deepEqual(parseLink("#stav=02-navrh-1&vrstva=plast"), { state: "02-navrh-1", layer: "plast", preview: false });
  assert.deepEqual(parseLink("stav=02-navrh-1.json"), { state: "02-navrh-1", layer: null, preview: false });
  assert.deepEqual(parseLink(""), { state: null, layer: null, preview: false });
  assert.deepEqual(parseLink("#nahled"), { state: null, layer: null, preview: true });
  assert.deepEqual(parseLink("#nahled&vrstva=vse"), { state: null, layer: "vse", preview: true });
  assert.equal(buildLink({ state: "02-navrh-1.json", layer: "plast" }), "#stav=02-navrh-1&vrstva=plast");
  assert.equal(buildLink({ preview: true, layer: "vse" }), "#nahled&vrstva=vse");
  const name = "03-návrh s mezerou";
  assert.deepEqual(parseLink(buildLink({ state: name, layer: "vse" })), { state: name, layer: "vse", preview: false });
});

test("presets/index.json generator", async () => {
  const folder = await mkdtemp(join(tmpdir(), "presets-"));
  try {
    assert.deepEqual((await buildList(join(folder, "missing"))).states, []);
    const a = state({ name: "Návrh 1", order: 2 }), b = state();
    await writeFile(join(folder, stateFileName(a.name, a.order)), JSON.stringify(a));
    await writeFile(join(folder, stateFileName(b.name, b.order)), JSON.stringify(b));
    await writeFile(join(folder, "index.json"), "{\"old\": true}");
    await writeFile(join(folder, "notes.txt"), "nothing");
    const l = await writeList(folder);
    assert.equal(l.format, LIST_FORMAT);
    assert.deepEqual(l.states.map((x) => x.file), ["01-soucasny-stav.json", "02-navrh-1.json"]);
    assert.deepEqual(JSON.parse(await readFile(join(folder, "index.json"), "utf8")), l);
    await writeFile(join(folder, "broken.json"), "{not-json");
    await writeFile(join(folder, "foreign.json"), JSON.stringify({ type: "FeatureCollection", features: [] }));
    await assert.rejects(buildList(folder), (e) => /broken\.json: není platný JSON/.test(e.message) && /foreign\.json: Soubor není/.test(e.message));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
