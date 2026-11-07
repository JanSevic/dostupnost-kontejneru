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

/** Hue in degrees of "#rrggbb". */
function hue(h) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const x = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (x * 60 + 360) % 360;
}

test("continuous scale keeps the hue of each band and turns red only at the last limit", () => {
  const [green, orange, red] = CONFIG.band_colors;
  assert.equal(R.color(0, S), green);
  assert.equal(R.color(100, S), "#f0c828");
  assert.equal(R.color(125, S), orange);
  assert.equal(R.color(200, S), red);
  assert.equal(R.color(400, S), "#7f0000");
  assert.equal(R.color(5000, S), "#7f0000");
  assert.equal(R.color(Infinity, S), S.unreachable_color);
  for (let d = 0; d <= 85; d += 5) assert.ok(hue(R.color(d, S)) > 90 && hue(R.color(d, S)) < 160, `green at ${d} m: ${R.color(d, S)}`);
  for (let d = 125; d <= 185; d += 5) {
    const h = hue(R.color(d, S));
    assert.ok(h >= 20 && h <= 35, `orange at ${d} m: ${R.color(d, S)} (${h.toFixed(0)}°)`);
  }
  // orange gets deeper (less green light) towards the last limit, so approaching problems are visible
  const g = (d) => parseInt(R.color(d, S).slice(3, 5), 16);
  assert.ok(g(125) > g(160) && g(160) > g(185));
  for (const d of [200, 210, 250, 300, 399]) {
    const [r, gg, b] = [1, 3, 5].map((i) => parseInt(R.color(d, S).slice(i, i + 2), 16));
    assert.ok(r > 120 && gg < 50 && b < 35, `red at ${d} m: ${R.color(d, S)}`);
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
