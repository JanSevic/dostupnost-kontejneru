/* Dostupnost kontejnerů – read-only viewer of published states (for council members). */
import { CONFIG } from "./config.js";
import { validateState, computeState, stateLayers, compareState, parseLink, buildLink, SUMMARY_KEY } from "./state.js";
import * as db from "./storage.js";

(function () {
  "use strict";
  const R = window.Render;
  const $ = (id) => document.getElementById(id);
  const PREVIEW = ":preview";
  const TRANSPARENT = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  const S = {
    entries: [], // [{id, file, name, …}] in display order
    loaded: new Map(), // id -> {o, result}
    current: null, // id
    layer: null,
    settings: null,
    areaKey: null,
    lines: [],
    networkGroup: null,
    outline: null,
    markers: null,
    vectorLayer: null,
    tileLayer: null,
    basemapMode: "tiles",
    compareShown: false,
  };
  let map, renderer, legendDiv;

  // ------------------------------------------------------------------ helpers

  function stored(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem("dk_viewer_" + key));
      localStorage.setItem("dk_viewer_" + key, JSON.stringify(value));
    } catch (e) { /* never mind */ }
    return null;
  }

  let toastTimer = null;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 3500);
  }

  function busy(text) {
    $("busy").hidden = !text;
    if (text) $("busy-text").textContent = text;
  }

  function message(text) {
    $("message").hidden = !text;
    $("message").textContent = text || "";
  }

  const pause = () => new Promise((r) => setTimeout(r, 0)); // lets the browser paint "busy" before a long computation

  const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" }) : "");
  const percent = (x) => Math.round(x * 100) + " %";

  function typesOf(o) {
    return Object.fromEntries(o.types.map((t) => [t.key, t]));
  }

  function layerName(o, k) {
    if (k === SUMMARY_KEY) return "Všechny typy";
    const t = typesOf(o)[k];
    return t ? t.name : k;
  }

  function settingsFor(o) {
    const bands = o.display.bands.length === CONFIG.band_colors.length - 1 ? o.display.bands : CONFIG.bands_m;
    return { mode: "bands", bands, band_colors: CONFIG.band_colors, unreachable_color: CONFIG.unreachable_color,
      continuous_max_m: CONFIG.continuous_max_m };
  }

  // ------------------------------------------------------------------ start

  async function start() {
    initMap();
    initControls();
    const link = parseLink(location.hash);
    busy("Načítám seznam stavů…");
    try {
      let preview = null;
      if (link.preview) {
        try {
          const rec = await db.get("settings", "preview");
          preview = rec ? rec.value : null;
        } catch (e) { /* storage not available */ }
        if (preview) {
          S.entries.push({ id: PREVIEW, name: preview.name, preview: true });
          S.loaded.set(PREVIEW, { o: validateState(preview), result: null });
          $("preview-banner").hidden = false;
        } else {
          message("Náhled není k dispozici – otevři ho znovu z režimu úprav (tlačítko „Náhled pro zastupitele“).");
        }
      }
      const published = await loadList();
      S.entries.push(...published.map((s) => ({ ...s, id: s.file.replace(/\.json$/i, "") })));
      if (!S.entries.length) {
        if (!$("message").textContent) message("Zatím nejsou zveřejněné žádné stavy.");
        $("sec-state").hidden = $("sec-layer").hidden = $("sec-stats").hidden = $("sec-compare").hidden = true;
        return;
      }
      fillSelect();
      const wanted = link.preview && preview ? PREVIEW : S.entries.some((e) => e.id === link.state) ? link.state : S.entries[0].id;
      if (link.state && wanted !== link.state) toast("Stav „" + link.state + "“ nebyl nalezen – zobrazuji první ze seznamu.");
      await showState(wanted, link.layer);
    } finally {
      busy(null);
    }
    window.addEventListener("hashchange", onHashChange);
  }

  async function loadList() {
    let r;
    try {
      r = await fetch("presets/index.json", { cache: "no-cache" });
    } catch (e) {
      if (!S.entries.length) message("Seznam stavů se nepodařilo načíst. Jsi připojený k internetu?");
      return [];
    }
    if (r.status === 404) return [];
    if (!r.ok) {
      message("Seznam stavů se nepodařilo načíst (HTTP " + r.status + ").");
      return [];
    }
    try {
      return (await r.json()).states || [];
    } catch (e) {
      message("Seznam stavů je poškozený.");
      return [];
    }
  }

  function fillSelect() {
    const sel = $("state-select");
    sel.innerHTML = "";
    S.entries.forEach((e) => sel.append(new Option(e.preview ? e.name + " (náhled)" : e.name, e.id)));
    $("sec-compare").hidden = S.entries.length < 2;
  }

  async function onHashChange() {
    const link = parseLink(location.hash);
    const id = link.preview ? PREVIEW : link.state;
    if (id && id !== S.current && S.entries.some((e) => e.id === id)) await showState(id, link.layer);
    else if (link.layer && link.layer !== S.layer) selectLayer(link.layer);
  }

  // ------------------------------------------------------------------ map

  function initMap() {
    map = L.map("map", { preferCanvas: true, zoomSnap: 0.5, maxZoom: 19, minZoom: 3 });
    const dv = CONFIG.default_view;
    map.setView([dv.lat, dv.lon], dv.zoom);
    map.createPane("basemap").style.zIndex = 150;
    map.getPane("basemap").style.pointerEvents = "none";
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    map.attributionControl.addAttribution('&copy; přispěvatelé <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>');
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
    renderer = L.canvas({ padding: 0.3, tolerance: 6 });
    S.markers = L.layerGroup().addTo(map);
    const leg = L.control({ position: "bottomright" });
    leg.onAdd = () => {
      legendDiv = L.DomUtil.create("div", "legend");
      legendDiv.hidden = true;
      L.DomEvent.disableClickPropagation(legendDiv);
      return legendDiv;
    };
    leg.addTo(map);
    const attr = CONFIG.tiles.attribution && CONFIG.tiles.attribution.indexOf("OpenStreetMap") < 0 ? R.escapeHtml(CONFIG.tiles.attribution) : null;
    S.tileLayer = L.tileLayer(CONFIG.tiles.url, { maxZoom: CONFIG.tiles.max_zoom || 19, errorTileUrl: TRANSPARENT, attribution: attr });
  }

  function initControls() {
    $("state-select").onchange = (e) => showState(e.target.value, S.layer);
    $("btn-copy-link").onclick = copyLink;
    $("btn-compare").onclick = compareAll;
    S.basemapMode = ["tiles", "vector", "none"].indexOf(stored("basemap")) >= 0 ? stored("basemap") : "tiles";
    document.querySelectorAll('input[name="basemap"]').forEach((r) => {
      r.checked = r.value === S.basemapMode;
      r.onchange = () => {
        S.basemapMode = r.value;
        stored("basemap", r.value);
        setBasemap();
      };
    });
  }

  function setBasemap() {
    const want = (layer, yes) => {
      if (!layer) return;
      if (yes && !map.hasLayer(layer)) layer.addTo(map);
      if (!yes && map.hasLayer(layer)) map.removeLayer(layer);
    };
    want(S.tileLayer, S.basemapMode === "tiles");
    want(S.vectorLayer, S.basemapMode === "vector");
  }

  // ------------------------------------------------------------------ states

  /** Loads (once) and computes (once) a state. */
  async function ensureComputed(id) {
    let rec = S.loaded.get(id);
    if (!rec) {
      const e = S.entries.find((x) => x.id === id);
      let r;
      try {
        r = await fetch("presets/" + encodeURIComponent(e.file), { cache: "no-cache" });
      } catch (err) {
        throw new Error("Stav „" + e.name + "“ se nepodařilo stáhnout. Jsi připojený k internetu?");
      }
      if (!r.ok) throw new Error("Stav „" + e.name + "“ se nepodařilo načíst (HTTP " + r.status + ").");
      let o;
      try {
        o = await r.json();
      } catch (err) {
        throw new Error("Soubor stavu „" + e.name + "“ je poškozený.");
      }
      rec = { o: validateState(o), result: null };
      S.loaded.set(id, rec);
    }
    if (!rec.result) {
      await pause();
      rec.result = computeState(rec.o, CONFIG.segment_length_m);
    }
    return rec;
  }

  async function showState(id, preferredLayer) {
    busy("Počítám vzdálenosti…");
    try {
      const { o, result } = await ensureComputed(id);
      message(null);
      S.current = id;
      $("state-select").value = id;
      S.settings = settingsFor(o);
      const layers = stateLayers(o, result);
      S.layer = [preferredLayer, o.display.layer].find((k) => layers.indexOf(k) >= 0) || layers[layers.length - 1];
      drawArea(o, result);
      drawContainers(o);
      showDescription(o);
      showLayers(o, result);
      redraw();
      showHowToRead();
      if (S.compareShown) showComparison();
    } catch (e) {
      message(e.message);
    } finally {
      busy(null);
    }
  }

  function selectLayer(k) {
    const rec = S.loaded.get(S.current);
    if (!rec || !rec.result || stateLayers(rec.o, rec.result).indexOf(k) < 0) return;
    S.layer = k;
    document.querySelectorAll('input[name="layer"]').forEach((r) => { r.checked = r.value === k; });
    redraw();
    if (S.compareShown) showComparison();
  }

  function drawArea(o, result) {
    const a = o.area;
    const key = [a.downloaded, a.bbox.join(","), a.network.nodes.length, a.network.edges.length].join("|");
    $("area-title").textContent = a.name ? "Oblast: " + a.name : "";
    if (key === S.areaKey) return;
    const first = S.areaKey === null;
    S.areaKey = key;
    if (S.networkGroup) map.removeLayer(S.networkGroup);
    S.lines = result.net.segments.ll.map((c, i) => L.polyline(c.map((p) => [p[1], p[0]]), { renderer, idx: i, weight: 4, opacity: 0.95 }));
    S.networkGroup = L.featureGroup(S.lines).addTo(map);
    S.networkGroup.bindTooltip((l) => {
      const d = currentValues();
      return d ? R.escapeHtml(layerName(o, S.layer)) + ": " + R.formatM(d[l.options.idx]) : "pěší síť";
    }, { sticky: true, direction: "top", offset: [0, -8] });
    if (S.outline) map.removeLayer(S.outline);
    S.outline = L.polygon([[a.bbox[1], a.bbox[0]], [a.bbox[1], a.bbox[2]], [a.bbox[3], a.bbox[2]], [a.bbox[3], a.bbox[0]]], {
      color: "#334155", weight: 1.2, dashArray: "5 5", fill: false, interactive: false,
    }).addTo(map);
    if (S.vectorLayer) {
      S.vectorLayer.dispose();
      map.removeLayer(S.vectorLayer);
    }
    S.vectorLayer = R.vectorBasemap(L, a.basemap || { type: "FeatureCollection", features: [] }, { map, pane: "basemap" });
    setBasemap();
    const e = a.extent || a.bbox;
    if (first || !map.getBounds().intersects(S.outline.getBounds())) map.fitBounds([[e[1], e[0]], [e[3], e[2]]]);
  }

  function drawContainers(o) {
    S.markers.clearLayers();
    const types = typesOf(o);
    o.containers.features.forEach((f) => {
      const p = f.properties;
      const t = types[p.typ] || { color: "#555", abbr: "?", name: p.typ };
      const m = L.marker([f.geometry.coordinates[1], f.geometry.coordinates[0]], { icon: R.containerIcon(L, t), keyboard: false });
      m._type = p.typ;
      m._typeInfo = t;
      m.bindTooltip(R.escapeHtml(t.name) + " č. " + p.id + (p.poznamka ? "<br>" + R.escapeHtml(p.poznamka) : ""),
        { direction: "right", offset: [6, 0] });
      m.addTo(S.markers);
    });
  }

  function currentValues() {
    const rec = S.loaded.get(S.current);
    if (!rec || !rec.result || !S.layer) return null;
    return S.layer === SUMMARY_KEY ? rec.result.summary : rec.result.results[S.layer];
  }

  function redraw() {
    const rec = S.loaded.get(S.current);
    const d = currentValues();
    if (!rec || !d) return;
    for (let i = 0; i < S.lines.length; i++) S.lines[i].setStyle({ color: R.color(d[i], S.settings) });
    S.markers.eachLayer((m) => {
      const dim = S.layer !== SUMMARY_KEY && m._type !== S.layer;
      m.setIcon(R.containerIcon(L, m._typeInfo, dim ? "dimmed" : ""));
      m.setZIndexOffset(dim ? 0 : 1000);
    });
    const caption = S.layer === SUMMARY_KEY
      ? "nejdelší z cest k nejbližším kontejnerům typů: " + rec.result.summaryTypes.map((k) => layerName(rec.o, k)).join(", ")
      : "vzdálenost po pěších cestách k nejbližšímu kontejneru";
    legendDiv.innerHTML = R.legendHtml(S.settings, layerName(rec.o, S.layer), caption);
    legendDiv.hidden = false;
    showStats(d, rec.result.net.segments.length);
    history.replaceState(null, "", buildLink(S.current === PREVIEW ? { preview: true, layer: S.layer } : { state: S.current, layer: S.layer }));
  }

  function showDescription(o) {
    $("state-description").textContent = o.description || "";
    $("state-description").hidden = !o.description;
    const counts = {};
    o.containers.features.forEach((f) => { counts[f.properties.typ] = (counts[f.properties.typ] || 0) + 1; });
    const parts = o.types.filter((t) => counts[t.key]).map((t) => t.name + " " + counts[t.key]);
    $("state-meta").textContent = "Kontejnery: " + (parts.join(", ") || "žádné") + " · uloženo " + formatDate(o.saved) +
      (o.area.downloaded ? " · cesty z OSM k " + formatDate(o.area.downloaded) : "");
  }

  function showLayers(o, result) {
    const box = $("layers");
    box.innerHTML = "";
    const types = typesOf(o);
    stateLayers(o, result).forEach((k) => {
      const lab = document.createElement("label");
      const r = document.createElement("input");
      r.type = "radio";
      r.name = "layer";
      r.value = k;
      r.checked = k === S.layer;
      r.onchange = () => selectLayer(k);
      lab.append(r);
      if (k !== SUMMARY_KEY) {
        const dot = document.createElement("span");
        dot.className = "dot small-dot";
        dot.style.background = types[k].color;
        lab.append(dot);
      }
      lab.append(document.createTextNode(" " + layerName(o, k)));
      box.append(lab);
    });
  }

  function showStats(d, lengths) {
    const rows = R.statistics(d, lengths, S.settings);
    let h = "<table>";
    rows.forEach((r) => {
      h += '<tr><td><span class="line" style="background:' + r.color + '"></span>' + r.label + '</td><td class="num">' +
        r.km.toFixed(2).replace(".", ",") + ' km</td><td class="num">' + percent(r.share) + "</td></tr>";
    });
    $("stats").innerHTML = h + "</table>";
  }

  function showHowToRead() {
    const s = S.settings, ul = $("how-bands");
    const names = ["zelená", "oranžová", "červená"];
    ul.innerHTML = "";
    for (let i = 0; i <= s.bands.length; i++) {
      const li = document.createElement("li");
      li.innerHTML = '<span class="line" style="background:' + s.band_colors[i] + '"></span>' + (names[i] || "") + " – " + R.bandLabel(i, s.bands);
      ul.append(li);
    }
    const li = document.createElement("li");
    li.innerHTML = '<span class="line" style="background:' + s.unreachable_color + '"></span>šedá – odsud se ke kontejneru po zmapovaných cestách nedá dojít';
    ul.append(li);
  }

  // ------------------------------------------------------------------ link

  async function copyLink() {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast(S.current === PREVIEW ? "Odkaz zkopírován – náhled ale funguje jen v tomto prohlížeči." : "Odkaz zkopírován.");
    } catch (e) {
      prompt("Zkopíruj odkaz:", url);
    }
  }

  // ------------------------------------------------------------------ comparison

  async function compareAll() {
    try {
      for (let i = 0; i < S.entries.length; i++) {
        busy("Počítám stav " + (i + 1) + " z " + S.entries.length + "…");
        await ensureComputed(S.entries[i].id);
      }
      S.compareShown = true;
      showComparison();
      $("btn-compare").hidden = true;
    } catch (e) {
      message(e.message);
    } finally {
      busy(null);
    }
  }

  function showComparison() {
    const limits = S.settings.bands;
    const cols = S.entries.filter((e) => S.loaded.get(e.id) && S.loaded.get(e.id).result);
    const data = cols.map((e) => {
      const rec = S.loaded.get(e.id);
      return { e, o: rec.o, shares: compareState(rec.o, rec.result, limits) };
    });
    // rows: layers in the order they first appear, summary last
    const rows = [], names = {};
    for (const c of data) {
      for (const k of Object.keys(c.shares)) {
        if (k !== SUMMARY_KEY && rows.indexOf(k) < 0) { rows.push(k); names[k] = layerName(c.o, k); }
      }
    }
    if (data.some((c) => c.shares[SUMMARY_KEY])) { rows.push(SUMMARY_KEY); names[SUMMARY_KEY] = "Všechny typy"; }
    const lim = limits.map((h) => "do " + R.formatNumber(h) + " m").join(" · ");
    let h = '<p class="muted small">V buňce: podíl sítě ' + R.escapeHtml(lim) + ".</p><div class=\"compare-scroll\"><table><thead><tr><th></th>";
    data.forEach((c) => {
      h += '<th class="' + (c.e.id === S.current ? "current" : "") + '"><button class="link" data-state="' + R.escapeHtml(c.e.id) + '">' +
        R.escapeHtml(c.e.preview ? c.e.name + " (náhled)" : c.e.name) + "</button></th>";
    });
    h += "</tr></thead><tbody>";
    rows.forEach((k) => {
      h += '<tr class="' + (k === S.layer ? "current" : "") + '"><th>' + R.escapeHtml(names[k]) + "</th>";
      data.forEach((c) => {
        const v = c.shares[k];
        h += '<td class="num' + (c.e.id === S.current ? " current" : "") + '">' + (v ? v.map(percent).join(" · ") : "–") + "</td>";
      });
      h += "</tr>";
    });
    h += "</tbody></table></div>";
    const box = $("compare");
    box.innerHTML = h;
    box.querySelectorAll("button[data-state]").forEach((b) => { b.onclick = () => showState(b.dataset.state, S.layer); });
  }

  start();
})();
