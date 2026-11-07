/* Shared rendering helpers – used by the app and by the exported HTML. */
(function (global) {
  "use strict";

  const CONTINUOUS_SCALE = [
    [0.0, [26, 152, 80]],
    [0.25, [145, 207, 96]],
    [0.5, [254, 224, 139]],
    [0.75, [252, 141, 89]],
    [1.0, [215, 48, 39]],
  ];
  const BEYOND_MAX = "#a50026";

  function hex(rgb) {
    return "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  }

  function continuousColor(d, max) {
    if (d > max) return BEYOND_MAX;
    const t = Math.max(0, d / max);
    for (let i = 1; i < CONTINUOUS_SCALE.length; i++) {
      const [t1, c1] = CONTINUOUS_SCALE[i];
      const [t0, c0] = CONTINUOUS_SCALE[i - 1];
      if (t <= t1) {
        const f = (t - t0) / (t1 - t0);
        return hex(c0.map((v, k) => v + f * (c1[k] - v)));
      }
    }
    return hex(CONTINUOUS_SCALE[CONTINUOUS_SCALE.length - 1][1]);
  }

  /** Band index: 0 = nearest; -1 = unreachable. */
  function band(d, limits) {
    if (d === null || d === undefined || !isFinite(d)) return -1;
    for (let i = 0; i < limits.length; i++) if (d <= limits[i]) return i;
    return limits.length;
  }

  /** s: {mode: "bands"|"continuous", bands: [100, 200], band_colors, unreachable_color, continuous_max_m} */
  function color(d, s) {
    if (d === null || d === undefined || !isFinite(d)) return s.unreachable_color;
    if (s.mode === "continuous") return continuousColor(d, s.continuous_max_m);
    return s.band_colors[band(d, s.bands)];
  }

  function formatNumber(x) {
    return Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10).replace(".", ",");
  }

  function bandLabel(i, limits) {
    if (i < 0) return "nedosažitelné";
    const h = [0].concat(limits);
    if (i < limits.length) return formatNumber(h[i]) + "–" + formatNumber(h[i + 1]) + " m";
    return "nad " + formatNumber(h[h.length - 1]) + " m";
  }

  function formatM(d) {
    if (d === null || d === undefined || !isFinite(d)) return "nedosažitelné";
    if (d >= 1000) return (d / 1000).toFixed(2).replace(".", ",") + " km";
    return Math.round(d) + " m";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /** Network length per band: [{label, color, km, share}] */
  function statistics(d, lengths, s) {
    const count = s.bands.length + 2;
    const sums = new Array(count).fill(0);
    let total = 0;
    for (let i = 0; i < d.length; i++) {
      const b = band(d[i], s.bands);
      sums[b < 0 ? count - 1 : b] += lengths[i];
      total += lengths[i];
    }
    const rows = [];
    for (let i = 0; i < count; i++) {
      const idx = i === count - 1 ? -1 : i;
      rows.push({
        label: bandLabel(idx, s.bands),
        color: idx < 0 ? s.unreachable_color : s.band_colors[idx],
        km: sums[i] / 1000,
        share: total > 0 ? sums[i] / total : 0,
      });
    }
    return rows;
  }

  function legendHtml(s, title, caption) {
    let h = '<div class="legend-title">' + escapeHtml(title) + "</div>";
    if (caption) h += '<div class="legend-caption">' + escapeHtml(caption) + "</div>";
    if (s.mode === "continuous") {
      const steps = [];
      for (let i = 0; i <= 10; i++) steps.push(continuousColor((i / 10) * s.continuous_max_m, s.continuous_max_m));
      h += '<div class="legend-gradient" style="background:linear-gradient(to right,' + steps.join(",") + ')"></div>';
      h += '<div class="legend-axis"><span>0 m</span><span>' + formatNumber(s.continuous_max_m / 2) + " m</span><span>" +
        formatNumber(s.continuous_max_m) + " m+</span></div>";
    } else {
      for (let i = 0; i <= s.bands.length; i++) {
        h += '<div class="legend-row"><span class="legend-line" style="background:' + s.band_colors[i] + '"></span>' +
          bandLabel(i, s.bands) + "</div>";
      }
    }
    h += '<div class="legend-row"><span class="legend-line" style="background:' + s.unreachable_color + '"></span>nedosažitelné</div>';
    return h;
  }

  function isLightColor(hexColor) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexColor || "");
    if (!m) return false;
    const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
    return 0.299 * r + 0.587 * g + 0.114 * b > 160;
  }

  /** type: {color, abbr} */
  function containerIcon(L, type, extraClass) {
    const text = isLightColor(type.color) ? "#222" : "#fff";
    return L.divIcon({
      className: "container-icon" + (extraClass ? " " + extraClass : ""),
      html: '<div style="background:' + type.color + ";color:" + text + '">' + escapeHtml(type.abbr) + "</div>",
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -12],
      tooltipAnchor: [12, 0],
    });
  }

  // ---------------------------------------------------------------- vector basemap
  // [colour, casing colour, width at zoom 16, dash pattern]
  const ROADS = {
    major: ["#f7d39b", "#d39a52", 7],
    street: ["#ffffff", "#c3bbb0", 6],
    service: ["#ffffff", "#cdc6bc", 3.5],
    track: ["#a8875c", null, 1.6, "5 4"],
    path: ["#937c66", null, 1.4, "2 3"],
  };
  const LABEL_MIN_ZOOM = { street: 16, city: 10, town: 11, village: 12, suburb: 13, hamlet: 14, neighbourhood: 15, quarter: 15, isolated_dwelling: 16 };

  function width(z, base) {
    return Math.max(0.6, Math.min(base * Math.pow(2, (z - 16) * 0.75), 20));
  }

  function basemapStyle(f, z) {
    const p = f.properties;
    switch (p.k) {
      case "green": return { stroke: false, fillColor: "#e1eed4", fillOpacity: 1 };
      case "forest": return { stroke: false, fillColor: "#c9e0b8", fillOpacity: 1 };
      case "water": return { color: "#9cc3e6", weight: 0.8, fillColor: "#b8d6f0", fillOpacity: 1 };
      case "building": return { color: "#b9ada0", weight: z >= 17 ? 0.9 : 0.4, fillColor: "#ddd4ca", fillOpacity: 1 };
      case "stream": return { color: "#8ab8de", weight: width(z, p.t === "river" || p.t === "canal" ? 5 : 2), fill: false };
      case "railway": return { color: "#7b7b7b", weight: width(z, 2.4), fill: false };
      case "road": {
        const c = ROADS[p.t] || ROADS.service;
        return { color: c[0], weight: width(z, c[2]), dashArray: c[3] || null, fill: false, lineCap: "round", lineJoin: "round" };
      }
    }
    return { stroke: false, fill: false };
  }

  function casingStyle(f, z) {
    const c = ROADS[f.properties.t] || ROADS.service;
    return { color: c[1], weight: width(z, c[2]) + 2, fill: false, lineCap: "round", lineJoin: "round" };
  }

  /** Vector basemap from OSM data into a Leaflet map. options: {map, pane} */
  function vectorBasemap(L, fc, options) {
    const map = options.map;
    const pane = options.pane;
    const renderer = L.canvas({ pane, padding: 0.4 });
    const base = { pane, renderer, interactive: false };
    const only = (kinds) => (f) => kinds.indexOf(f.properties.k) >= 0;
    const z = () => map.getZoom();
    const areas = L.geoJSON(fc, Object.assign({}, base, { filter: only(["green", "forest", "water", "building", "stream"]), style: (f) => basemapStyle(f, z()) }));
    const casings = L.geoJSON(fc, Object.assign({}, base, { filter: (f) => f.properties.k === "road" && !!(ROADS[f.properties.t] || [])[1], style: (f) => casingStyle(f, z()) }));
    const roads = L.geoJSON(fc, Object.assign({}, base, { filter: only(["road"]), style: (f) => basemapStyle(f, z()) }));
    const railways = L.geoJSON(fc, Object.assign({}, base, { filter: only(["railway"]), style: (f) => basemapStyle(f, z()) }));
    const labels = L.layerGroup();
    (fc.features || []).forEach((f) => {
      const p = f.properties;
      if (p.k !== "label" && p.k !== "place") return;
      const street = p.k === "label";
      const cls = street ? "label-street" : "label-place label-" + (p.t || "");
      // a street label is rotated along the road and shifted slightly above it so the walking network does not cover it
      const transform = "translate(-50%,-50%)" + (street ? " rotate(" + (-(p.a || 0)) + "deg) translateY(-11px)" : "");
      const m = L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
        pane, interactive: false, keyboard: false,
        icon: L.divIcon({ className: "label-wrap", iconSize: [0, 0],
          html: '<span class="' + cls + '" style="transform:' + transform + '">' + escapeHtml(p.n || "") + "</span>" }),
      });
      m._minZoom = LABEL_MIN_ZOOM[street ? "street" : p.t] || 14;
      labels.addLayer(m);
    });
    const group = L.layerGroup([areas, casings, roads, railways, labels]);
    function update() {
      const zz = z();
      areas.setStyle((f) => basemapStyle(f, zz));
      casings.setStyle((f) => casingStyle(f, zz));
      roads.setStyle((f) => basemapStyle(f, zz));
      railways.setStyle((f) => basemapStyle(f, zz));
      labels.eachLayer((m) => m.setOpacity(zz >= m._minZoom ? 1 : 0));
    }
    map.on("zoomend", update);
    group.on("add", update);
    group.dispose = () => map.off("zoomend", update);
    return group;
  }

  global.Render = {
    vectorBasemap,
    color, band, bandLabel, formatM, legendHtml, containerIcon, statistics, escapeHtml, continuousColor, formatNumber, isLightColor,
  };
})(typeof window !== "undefined" ? window : this);
