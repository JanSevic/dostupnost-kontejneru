import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { continuousColor, continuousStops } from "../js/exports.js";
import { CONFIG } from "../js/config.js";

// render.js is a classic browser script (window.Render); run it in a sandbox
const sandbox = {};
vm.runInNewContext(readFileSync(new URL("../js/render.js", import.meta.url), "utf8"), sandbox);
const R = sandbox.Render;

const S = { mode: "continuous", bands: [100, 200], band_colors: CONFIG.band_colors, unreachable_color: CONFIG.unreachable_color };

test("continuous scale follows the bands: green → yellow at the first limit → band red at the last", () => {
  const [green, orange, red] = CONFIG.band_colors;
  assert.equal(R.color(0, S), green);
  assert.equal(R.color(100, S), "#f0c828");
  assert.equal(R.color(150, S), orange);
  assert.equal(R.color(200, S), red);
  assert.equal(R.color(400, S), "#7f0000");
  assert.equal(R.color(5000, S), "#7f0000");
  assert.equal(R.color(Infinity, S), S.unreachable_color);
  // above the last limit it only gets darker red: red channel dominant, green and blue low
  for (const d of [210, 250, 300, 399]) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(R.color(d, S).slice(i, i + 2), 16));
    assert.ok(r > 120 && g < 50 && b < 35, `${d} m: ${R.color(d, S)}`);
  }
  // other band limits move the scale with them
  const wide = { ...S, bands: [300, 600] };
  assert.equal(R.color(600, wide), red);
  assert.equal(R.color(300, wide), "#f0c828");
});

test("map (render.js) and PNG export (exports.js) use the same scale", () => {
  for (const bands of [[100, 200], [50, 300], [150, 160]]) {
    const s = { ...S, bands };
    assert.deepEqual(JSON.parse(JSON.stringify(R.continuousStops(s))), continuousStops(s));
    for (let d = 0; d <= 2.5 * bands[1]; d += 7) assert.equal(continuousColor(d, s), R.color(d, s), `${bands} ${d}`);
  }
});

test("continuous legend has ticks at the band limits", () => {
  const h = R.legendHtml(S, "Plast", "");
  for (const t of [">0<", ">100<", ">200<", ">400+ m<"]) assert.ok(h.includes(t), t);
  assert.ok(h.includes("#d7301f 50%") && h.includes("#7f0000 100%"));
});
