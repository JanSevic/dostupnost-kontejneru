/* Dostupnost kontejnerů – editor UI logic (web version, everything runs in the browser). */
import { call, areaFromOsm, exportData, initialise, stateForSaving, takeOverState, savePreview } from "./backend.js";
import { stateFileName, validateState, buildLink } from "./state.js";

(function () {
  "use strict";
  const R = window.Render;
  const $ = (id) => document.getElementById(id);

  const S = {
    cfg: null,
    types: [],
    typesByKey: {},
    activeType: null,
    containers: [], // {id, typ, poznamka, lat, lon}
    markers: new Map(),
    netVersion: 0,
    segments: null,
    lengths: null,
    lines: [],
    networkGroup: null,
    areaOutline: null,
    results: {},
    summary: null,
    summaryTypes: [],
    stale: new Set(),
    snaps: {},
    layer: null,
    settings: null,
    popupOpen: false,
    popupOnClick: false,
    revision: {}, // type -> number of placement changes (to recognise outdated responses)
    usedResponse: {}, // layer -> sequence number of the last applied response
    area: null, // metadata of the open area
    taskRunning: false,
    loading: false,
    basemapMode: "auto",
    vectorLayer: null,
    tileLayer: null,
  };
  const TRANSPARENT = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  let changeCounter = 0; // every unsaved change (including a note)
  let requestCounter = 0;
  let map, renderer, markerLayer, legendDiv;
  let SUMMARY = "vse";

  // ------------------------------------------------------------------ helpers

  function stored(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem("dk_" + key));
      localStorage.setItem("dk_" + key, JSON.stringify(value));
    } catch (e) { /* browser without localStorage – never mind */ }
    return null;
  }

  const api = (method, url, body) => call(method, url, body);

  let toastTimer = null;
  function toast(text, options = {}) {
    const el = $("toast");
    el.innerHTML = "";
    el.append(document.createTextNode(text));
    el.classList.toggle("error", !!options.error);
    el.style.pointerEvents = options.action ? "auto" : "none";
    if (options.action) {
      const b = document.createElement("button");
      b.className = "link";
      b.style.color = "#9ccbff";
      b.style.marginLeft = "10px";
      b.textContent = options.action.text;
      b.onclick = () => { el.classList.remove("visible"); options.action.fn(); };
      el.append(b);
    }
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), options.error ? 9000 : options.action || options.long ? 7000 : 3500);
  }

  function busy(text) {
    $("busy").hidden = !text;
    if (text) $("busy-text").textContent = text;
  }

  function clock() {
    return new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function layerName(k) {
    if (k === SUMMARY) return "Všechny typy";
    return S.typesByKey[k] ? S.typesByKey[k].name : k;
  }

  // ------------------------------------------------------------------ start

  async function start() {
    try {
      await initialise();
      S.cfg = await api("GET", "/api/config");
    } catch (e) {
      document.body.innerHTML = "<p style='padding:20px'>Nepodařilo se načíst konfiguraci: " + R.escapeHtml(e.message) + "</p>";
      return;
    }
    SUMMARY = S.cfg.summary_key;
    const savedSettings = stored("settings") || {};
    S.settings = {
      mode: savedSettings.mode === "continuous" ? "continuous" : "bands",
      bands: Array.isArray(savedSettings.bands) && savedSettings.bands.length === S.cfg.bands_m.length ? savedSettings.bands : S.cfg.bands_m.slice(),
      band_colors: S.cfg.band_colors,
      unreachable_color: S.cfg.unreachable_color,
      continuous_max_m: S.cfg.continuous_max_m,
    };
    setTypes(S.cfg.types);
    const savedType = stored("active");
    S.activeType = S.typesByKey[savedType] ? savedType : S.types[0].key;
    $("title").value = stored("title") || ("Pěší dostupnost kontejnerů" + (S.cfg.territory_name ? " – " + S.cfg.territory_name : ""));
    S.basemapMode = ["auto", "vector", "none"].indexOf(stored("basemap")) >= 0 ? stored("basemap") : "auto";
    initMap();
    initControls();
    buildBandInputs();
    redrawTypes();
    refreshLayers();
    await refreshStatus(true);
  }

  function setTypes(types) {
    S.types = types;
    S.typesByKey = Object.fromEntries(types.map((t) => [t.key, t]));
  }

  // ------------------------------------------------------------------ map

  function initMap() {
    const view = stored("view");
    const dv = S.cfg.default_view;
    map = L.map("map", { preferCanvas: true, zoomSnap: 0.5, maxZoom: 19, minZoom: 3 });
    if (view && isFinite(view.lat)) map.setView([view.lat, view.lon], view.zoom);
    else map.setView([dv.lat, dv.lon], dv.zoom);
    // vector basemap below the tiles (shows where tiles are missing)
    map.createPane("basemap").style.zIndex = 150;
    map.getPane("basemap").style.pointerEvents = "none";
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    map.attributionControl.addAttribution('&copy; přispěvatelé <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>');
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
    renderer = L.canvas({ padding: 0.3, tolerance: 5 });
    markerLayer = L.layerGroup().addTo(map);

    const leg = L.control({ position: "bottomright" });
    leg.onAdd = () => {
      legendDiv = L.DomUtil.create("div", "legend");
      legendDiv.hidden = true;
      L.DomEvent.disableClickPropagation(legendDiv);
      return legendDiv;
    };
    leg.addTo(map);

    map.on("popupopen", () => { S.popupOpen = true; });
    map.on("popupclose", () => { S.popupOpen = false; });
    map.on("preclick", () => { S.popupOnClick = S.popupOpen; });
    map.on("click", (e) => {
      if (S.popupOnClick) return; // the click only closed the popup
      if (!$("chk-add").checked) return;
      addContainer(e.latlng);
    });
    map.on("moveend", () => {
      const c = map.getCenter();
      stored("view", { lat: c.lat, lon: c.lng, zoom: map.getZoom() });
    });
    updateCursor();
  }

  function updateCursor() {
    $("map").classList.toggle("adding", $("chk-add").checked);
  }

  // ------------------------------------------------------------------ controls

  function initControls() {
    $("btn-collapse").onclick = () => { document.body.classList.add("collapsed"); map.invalidateSize(); };
    $("btn-expand").onclick = () => { document.body.classList.remove("collapsed"); map.invalidateSize(); };
    $("btn-change-area").onclick = openAreaDialog;
    $("btn-update").onclick = updateArea;
    $("btn-new-extent").onclick = startPrepare;
    $("btn-prepare-default").onclick = prepareDefault;
    $("btn-from-extent").onclick = () => {
      $("dlg-areas").close();
      toast("Nastav mapu na požadované území a klikni na „Nová oblast z výřezu…“ v panelu.");
    };
    $("btn-osm-file").onclick = () => $("file-osm").click();
    $("file-osm").onchange = uploadOsm;
    document.querySelectorAll('input[name="basemap"]').forEach((r) => {
      r.checked = r.value === S.basemapMode;
      r.onchange = () => {
        S.basemapMode = r.value;
        stored("basemap", r.value);
        setBasemap();
      };
    });
    $("chk-show-network").onchange = redrawNetwork;
    $("chk-add").onchange = updateCursor;
    $("chk-only-active").onchange = redrawList;
    $("btn-compute").onclick = () => compute([S.activeType]);
    $("btn-compute-all").onclick = () => compute("all");
    document.querySelectorAll('input[name="mode"]').forEach((r) => {
      r.checked = r.value === S.settings.mode;
      r.onchange = () => {
        S.settings.mode = r.value;
        saveSettings();
        redrawNetwork();
      };
    });
    $("btn-save-variant").onclick = saveVariant;
    $("btn-load-variant").onclick = openVariants;
    $("btn-download-geojson").onclick = () => downloadBlob(
      new Blob([JSON.stringify(toFc(), null, 1)], { type: "application/geo+json" }), "kontejnery.geojson");
    $("btn-upload-geojson").onclick = () => $("file-geojson").click();
    $("file-geojson").onchange = uploadGeojson;
    $("title").onchange = () => stored("title", $("title").value);
    $("btn-export-html").onclick = () => runExport("html");
    $("btn-export-png").onclick = () => runExport("png");
    $("btn-export-qgis").onclick = () => runExport("geojson");
    $("btn-save-state").onclick = openSaveState;
    $("btn-preview").onclick = openPreview;
    $("btn-open-state").onclick = openStateDialog;
    $("btn-state-file").onclick = () => $("file-state").click();
    $("file-state").onchange = uploadState;
    $("state-name").oninput = updateStateFileName;
    $("state-order").oninput = updateStateFileName;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && saveTimer) saveNow();
    });
    window.addEventListener("beforeunload", () => {
      if (saveTimer) call("PUT", "/api/containers", toFc());
    });
  }

  function buildBandInputs() {
    const box = $("band-inputs");
    box.innerHTML = "<span>Pásma:</span><span>0 –</span>";
    S.settings.bands.forEach((h, i) => {
      if (i > 0) box.append(Object.assign(document.createElement("span"), { textContent: "–" }));
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = "1";
      inp.step = "10";
      inp.className = "num-input";
      inp.value = h;
      inp.setAttribute("aria-label", "Hranice " + (i + 1) + ". pásma v metrech");
      inp.onchange = bandsChanged;
      box.append(inp);
    });
    box.append(Object.assign(document.createElement("span"), { textContent: "m" }));
    const reset = Object.assign(document.createElement("button"), { className: "link", textContent: "výchozí" });
    reset.title = "Vrátit hranice z konfigurace";
    reset.onclick = () => {
      S.settings.bands = S.cfg.bands_m.slice();
      saveSettings();
      buildBandInputs();
      redrawNetwork();
    };
    box.append(reset);
  }

  function bandsChanged() {
    const inputs = Array.from($("band-inputs").querySelectorAll("input"));
    const values = inputs.map((i) => parseFloat(i.value));
    const ok = values.every((h) => isFinite(h) && h > 0) && values.every((h, i) => i === 0 || h > values[i - 1]);
    inputs.forEach((i) => { i.style.borderColor = ok ? "" : "#b42318"; });
    if (!ok) {
      toast("Hranice pásem musí být kladná a vzestupná čísla.", { error: true });
      return;
    }
    S.settings.bands = values;
    saveSettings();
    redrawNetwork();
  }

  function saveSettings() {
    stored("settings", { mode: S.settings.mode, bands: S.settings.bands });
  }

  // ------------------------------------------------------------------ types and containers

  function redrawTypes() {
    const box = $("types");
    box.innerHTML = "";
    const counts = {};
    S.containers.forEach((k) => { counts[k.typ] = (counts[k.typ] || 0) + 1; });
    S.types.forEach((t) => {
      const b = document.createElement("button");
      b.className = "type-btn";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(t.key === S.activeType));
      b.title = t.temporary ? "Dočasný typ (není v konfiguraci)" : "Aktivní typ pro přidávání";
      const light = R.isLightColor(t.color);
      b.innerHTML = '<span class="dot" style="background:' + t.color + ";color:" + (light ? "#222" : "#fff") + '">' +
        R.escapeHtml(t.abbr) + "</span>" + R.escapeHtml(t.name) + ' <span class="count">' + (counts[t.key] || 0) + "</span>";
      b.onclick = () => {
        S.activeType = t.key;
        stored("active", t.key);
        redrawTypes();
        redrawList();
      };
      box.append(b);
    });
    $("btn-compute").textContent = "Spočítat: " + (S.typesByKey[S.activeType] || {}).name;
  }

  function nextId() {
    return S.containers.reduce((m, k) => Math.max(m, k.id), 0) + 1;
  }

  function loadContainersFromFc(fc) {
    markerLayer.clearLayers();
    S.markers.clear();
    S.containers = (fc.features || []).map((f) => ({
      id: f.properties.id,
      typ: f.properties.typ,
      poznamka: f.properties.poznamka || "",
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }));
    S.containers.forEach(createMarker);
    redrawList();
    redrawTypes();
  }

  function toFc() {
    const r7 = (x) => Math.round(x * 1e7) / 1e7;
    return {
      type: "FeatureCollection",
      features: S.containers.map((k) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r7(k.lon), r7(k.lat)] },
        properties: { id: k.id, typ: k.typ, poznamka: k.poznamka },
      })),
    };
  }

  function hasProblem(p) {
    return p && (p.outside || p.long_connection || p.isolated);
  }

  function icon(k) {
    const t = S.typesByKey[k.typ] || { color: "#555", abbr: "?" };
    const cls = [];
    if (S.layer && S.layer !== SUMMARY && S.results[S.layer] && k.typ !== S.layer) cls.push("dimmed");
    if (hasProblem(S.snaps[String(k.id)])) cls.push("warn");
    return R.containerIcon(L, t, cls.join(" "));
  }

  function createMarker(k) {
    const m = L.marker([k.lat, k.lon], { icon: icon(k), draggable: true, autoPan: true, riseOnHover: true });
    m.on("dragend", () => {
      const ll = m.getLatLng();
      k.lat = ll.lat;
      k.lon = ll.lng;
      delete S.snaps[String(k.id)];
      m.setIcon(icon(k));
      changed([k.typ]);
    });
    m.bindPopup(() => popupContent(k, m), { minWidth: 230, autoPanPadding: [30, 30] });
    m.bindTooltip(() => R.escapeHtml((S.typesByKey[k.typ] || {}).name + " č. " + k.id + (k.poznamka ? " – " + k.poznamka : "")),
      { direction: "right", offset: [6, 0] });
    m.addTo(markerLayer);
    S.markers.set(k.id, m);
  }

  function refreshMarkers() {
    S.containers.forEach((k) => {
      const m = S.markers.get(k.id);
      if (m) m.setIcon(icon(k));
    });
  }

  function addContainer(latlng) {
    if (!S.area) {
      toast("Nejdřív vyber nebo připrav oblast (tlačítko „Změnit…“ nahoře v panelu).", { error: true });
      return;
    }
    if (S.loading) {
      toast("Oblast se ještě načítá – zkus to za okamžik.");
      return;
    }
    const k = { id: nextId(), typ: S.activeType, poznamka: "", lat: latlng.lat, lon: latlng.lng };
    S.containers.push(k);
    createMarker(k);
    changed([k.typ]);
  }

  function deleteContainer(k) {
    const i = S.containers.indexOf(k);
    if (i < 0) return;
    S.containers.splice(i, 1);
    const m = S.markers.get(k.id);
    if (m) markerLayer.removeLayer(m);
    S.markers.delete(k.id);
    changed([k.typ]);
    toast((S.typesByKey[k.typ] || {}).name + " č. " + k.id + " smazán.", {
      action: {
        text: "Vrátit",
        fn: () => {
          if (S.containers.some((x) => x.id === k.id)) k.id = nextId();
          S.containers.push(k);
          createMarker(k);
          changed([k.typ]);
        },
      },
    });
  }

  function popupContent(k, m) {
    const div = document.createElement("div");
    div.className = "popup-container";
    const options = S.types.map((t) => '<option value="' + t.key + '"' + (t.key === k.typ ? " selected" : "") + ">" +
      R.escapeHtml(t.name) + "</option>").join("");
    const p = S.snaps[String(k.id)];
    let info = "Vzdálenost k síti se zjistí při výpočtu.", warn = false;
    if (p) {
      if (p.outside) { info = "⚠ Leží mimo načtenou síť – nezapočítán."; warn = true; }
      else if (p.long_connection) { info = "⚠ Od nejbližší cesty " + Math.round(p.connection_m) + " m (víc než " + S.cfg.connection_warning_m + " m)."; warn = true; }
      else if (p.isolated) { info = "⚠ Připojený k izolovanému kousku cesty, který nenavazuje na zbytek sítě."; warn = true; }
      else info = "Přípojka k nejbližší cestě: " + Math.round(p.connection_m) + " m.";
    }
    div.innerHTML =
      "<h3>Kontejner č. " + k.id + "</h3>" +
      '<label>Typ<select class="sel-type">' + options + "</select></label>" +
      '<label>Poznámka<textarea class="txt-note" placeholder="např. u obchodu, 2 nádoby"></textarea></label>' +
      '<div class="info' + (warn ? " warn" : "") + '">' + R.escapeHtml(info) + "</div>" +
      '<div class="row"><button type="button" class="delete">Smazat</button><span class="spacer"></span>' +
      '<button type="button" class="done">Hotovo</button></div>';
    const txt = div.querySelector(".txt-note");
    txt.value = k.poznamka;
    txt.oninput = () => {
      k.poznamka = txt.value;
      scheduleSave();
      redrawListLater();
    };
    div.querySelector(".sel-type").onchange = (e) => {
      const old = k.typ;
      k.typ = e.target.value;
      delete S.snaps[String(k.id)];
      m.setIcon(icon(k));
      changed([old, k.typ]);
    };
    div.querySelector(".delete").onclick = () => { map.closePopup(); deleteContainer(k); };
    div.querySelector(".done").onclick = () => map.closePopup();
    return div;
  }

  let listTimer = null;
  function redrawListLater() {
    clearTimeout(listTimer);
    listTimer = setTimeout(redrawList, 300);
  }

  function redrawList() {
    const ul = $("list");
    ul.innerHTML = "";
    const onlyActive = $("chk-only-active").checked;
    const typeOrder = Object.fromEntries(S.types.map((t, i) => [t.key, i]));
    const shown = S.containers
      .filter((k) => !onlyActive || k.typ === S.activeType)
      .sort((a, b) => (typeOrder[a.typ] - typeOrder[b.typ]) || (a.id - b.id));
    shown.forEach((k) => {
      const t = S.typesByKey[k.typ] || { color: "#555", name: k.typ };
      const li = document.createElement("li");
      const p = S.snaps[String(k.id)];
      li.innerHTML = '<span class="dot" style="background:' + t.color + '"></span><span>' + R.escapeHtml(t.name) +
        " č. " + k.id + '</span><span class="note">' + R.escapeHtml(k.poznamka) + "</span>" +
        (hasProblem(p) ? '<span class="warn" title="' + (p.outside ? "mimo načtenou síť" : p.isolated ? "izolovaný kousek cesty" : "daleko od cesty") + '">!</span>' : "");
      li.onclick = () => {
        const m = S.markers.get(k.id);
        map.setView([k.lat, k.lon], Math.max(map.getZoom(), 17));
        if (m) setTimeout(() => m.openPopup(), 250);
      };
      ul.append(li);
    });
    $("total").textContent = S.containers.length + " celkem" + (onlyActive ? ", zobrazeno " + shown.length : "");
  }

  // placement changed: save, mark results as outdated, recompute if enabled
  function changed(types) {
    types.forEach((t) => {
      S.revision[t] = (S.revision[t] || 0) + 1;
      if (S.results[t]) S.stale.add(t);
    });
    if (S.summary) S.stale.add(SUMMARY);
    redrawList();
    redrawTypes();
    refreshLayers();
    scheduleSave();
    if ($("chk-auto").checked) scheduleRecompute();
  }

  let saveTimer = null;
  function scheduleSave() {
    changeCounter++;
    clearTimeout(saveTimer);
    $("saved").textContent = "Ukládám…";
    saveTimer = setTimeout(saveNow, 400);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      const r = await api("PUT", "/api/containers", toFc());
      $("saved").textContent = "Automaticky uloženo v " + clock() + ".";
      if (r.warnings && r.warnings.length) toast(r.warnings.join(" "));
    } catch (e) {
      $("saved").textContent = "⚠ Uložení selhalo: " + e.message;
      toast("Uložení selhalo: " + e.message, { error: true });
    }
  }

  // The backend received the containers together with a computation/export. A pending save is
  // cancelled only if nothing changed since sending (otherwise a note typed meanwhile would be lost).
  function containersSent(counterWhenSent) {
    if (counterWhenSent !== undefined && counterWhenSent !== changeCounter) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    $("saved").textContent = "Automaticky uloženo v " + clock() + ".";
  }

  // ------------------------------------------------------------------ area

  async function refreshStatus(first) {
    let s;
    try {
      s = await api("GET", "/api/status");
    } catch (e) {
      toast(e.message, { error: true });
      return null;
    }
    const slugBefore = S.area ? S.area.slug : null;
    S.area = s.area;
    showArea();
    showTask(s.task);
    if (s.area && (s.area.slug !== slugBefore || s.network.version !== S.netVersion)) await loadArea(s.area.slug !== slugBefore);
    if (s.task && s.task.running) watchTask();
    else if (first && !s.area) openAreaDialog();
    setBasemap();
    return s;
  }

  function updateButtons() {
    $("btn-update").disabled = S.taskRunning || !S.area;
    $("btn-update").title = S.taskRunning ? "Právě se připravuje oblast." : !S.area ? "Není otevřená žádná oblast." : "Znovu stáhne síť a podklad pro tuto oblast";
    for (const id of ["btn-new-extent", "btn-prepare-default", "btn-from-extent", "btn-osm-file", "btn-change-area", "btn-open-state"]) {
      $(id).disabled = S.taskRunning;
    }
  }

  function shortName(name) {
    return String(name || "").replace(/\s*\(.*\)\s*$/, "");
  }

  function showArea() {
    const o = S.area;
    $("area-name").textContent = o ? o.name : "Není vybraná žádná oblast";
    const el = $("area-info");
    if (!o) {
      el.className = "status status-none";
      el.textContent = "Vyber oblast nebo připrav novou (tlačítko „Změnit…“).";
    } else {
      el.className = "status status-ok";
      const date = new Date(o.downloaded).toLocaleString("cs-CZ", { dateStyle: "medium", timeStyle: "short" });
      const rows = [
        "Data stažena: " + date,
        "Zdroj: " + o.source,
        String(o.network.length_km).replace(".", ",") + " km pěších cest, oblast " + String(o.area_km2).replace(".", ",") + " km²",
      ];
      el.innerHTML = rows.map(R.escapeHtml).join("<br>");
    }
    updateButtons();
  }

  async function loadArea(isNew) {
    S.loading = true;
    try {
      S.cfg = await api("GET", "/api/config");
      setTypes(S.cfg.types);
      if (!S.typesByKey[S.activeType]) S.activeType = S.types[0].key;
      loadContainersFromFc(await api("GET", "/api/containers"));
      await loadBasemap();
      await loadSegments(isNew);
      if (isNew) {
        S.revision = {};
        if (!stored("title")) $("title").value = "Pěší dostupnost kontejnerů – " + shortName(S.area.name);
      }
      redrawTypes();
      refreshLayers();
    } catch (e) {
      toast("Oblast se nepodařilo zobrazit: " + e.message, { error: true });
    } finally {
      S.loading = false;
    }
  }

  async function loadBasemap() {
    let fc;
    try {
      fc = await api("GET", "/api/basemap");
    } catch (e) {
      fc = { type: "FeatureCollection", features: [] };
    }
    if (S.vectorLayer) {
      S.vectorLayer.dispose();
      map.removeLayer(S.vectorLayer);
    }
    S.vectorLayer = R.vectorBasemap(L, fc, { map, pane: "basemap" });
    setBasemap();
  }

  // Basemap: OSM tiles (the browser loads them itself) with the vector basemap below,
  // or only the vector basemap, or nothing.
  function setBasemap() {
    if (!map || !S.cfg) return;
    const mode = S.basemapMode;
    const want = (layer, yes) => {
      if (!layer) return;
      if (yes && !map.hasLayer(layer)) layer.addTo(map);
      if (!yes && map.hasLayer(layer)) map.removeLayer(layer);
    };
    if (!S.tileLayer) {
      const attr = S.cfg.tiles.attribution && S.cfg.tiles.attribution.indexOf("OpenStreetMap") < 0
        ? R.escapeHtml(S.cfg.tiles.attribution) : null;
      S.tileLayer = L.tileLayer(S.cfg.tiles.url, { maxZoom: S.cfg.tiles.max_zoom || 19, errorTileUrl: TRANSPARENT, attribution: attr });
    }
    want(S.tileLayer, mode === "auto");
    want(S.vectorLayer, mode !== "none");
  }

  async function openAreaDialog() {
    let d;
    try {
      d = await api("GET", "/api/areas");
    } catch (e) {
      toast(e.message, { error: true });
      return;
    }
    const ul = $("area-list");
    ul.innerHTML = "";
    const areas = d.areas.slice().sort((a, b) => (b.slug === d.last) - (a.slug === d.last));
    areas.forEach((o) => {
      const li = document.createElement("li");
      const date = new Date(o.downloaded).toLocaleDateString("cs-CZ");
      li.innerHTML = "<span><b>" + R.escapeHtml(o.name) + '</b><br><span class="muted small">data z ' + date + " · " +
        String(o.area_km2).replace(".", ",") + " km² · " + o.container_count + " kontejnerů · " + o.variant_count + " variant</span></span>";
      const b = document.createElement("button");
      b.type = "button";
      const isOpen = S.area && S.area.slug === o.slug;
      b.textContent = isOpen ? "Otevřená" : "Otevřít";
      b.className = isOpen ? "" : "primary";
      b.onclick = () => (isOpen ? $("dlg-areas").close() : openArea(o.slug));
      li.append(b);
      ul.append(li);
    });
    const def = S.cfg.default_area;
    const hasDefault = d.areas.some((o) => o.name === def.name);
    $("btn-prepare-default").hidden = hasDefault;
    $("btn-prepare-default").textContent = "Připravit " + def.name;
    updateButtons();
    if (!$("dlg-areas").open) $("dlg-areas").showModal();
    const first = ul.querySelector("button.primary") || (hasDefault ? null : $("btn-prepare-default"));
    if (first && !first.disabled) first.focus();
  }

  async function openArea(slug) {
    busy("Otevírám oblast…");
    try {
      if (saveTimer) await saveNow();
      await api("POST", "/api/areas/open", { slug });
      $("dlg-areas").close();
      await refreshStatus();
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      busy(null);
    }
  }

  async function runTask(url, body) {
    try {
      if (saveTimer) await saveNow();
      const s = await api("POST", url, body);
      showTask(s.task);
      watchTask();
      return true;
    } catch (e) {
      toast(e.message, { error: true });
      return false;
    }
  }

  async function prepareDefault() {
    if (await runTask("/api/areas/prepare", { default: true })) $("dlg-areas").close();
  }

  async function startPrepare() {
    const b = map.getBounds();
    const extent = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
    let o;
    try {
      o = await api("POST", "/api/areas/estimate", extent);
    } catch (e) {
      toast(e.message, { error: true });
      return;
    }
    const num = (x) => String(x).replace(".", ",");
    const rows = ["Plocha i s okrajem: " + num(o.area_km2) + " km²."];
    if (o.too_large) rows.push("Příliš velká – limit je " + o.limit_km2 + " km². Přibliž mapu.");
    const box = $("prepare-estimate");
    box.className = "status gap " + (o.too_large ? "status-error" : "");
    box.innerHTML = rows.map(R.escapeHtml).join("<br>");
    $("btn-prepare-ok").disabled = o.too_large;
    $("prepare-name").value = "Oblast " + new Date().toLocaleDateString("cs-CZ");
    const dlg = $("dlg-prepare");
    dlg.returnValue = "";
    dlg.onclose = async () => {
      if (dlg.returnValue !== "ok") return;
      const name = $("prepare-name").value.trim();
      if (!name) {
        toast("Zadej název oblasti.", { error: true });
        return;
      }
      await runTask("/api/areas/prepare", Object.assign({ name }, extent));
    };
    dlg.showModal();
    $("prepare-name").select();
  }

  async function updateArea() {
    if (!S.area) return;
    if (!confirm("Znovu stáhnout síť a podklad oblasti „" + S.area.name + "“ z OpenStreetMap?\n" +
      "Kontejnery, varianty a exporty zůstanou beze změny.")) return;
    await runTask("/api/areas/update");
  }

  async function uploadOsm(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const name = prompt("Název nové oblasti:", file.name.replace(/\.(osm|xml)$/i, ""));
    if (!name) return;
    try {
      if (saveTimer) await saveNow();
      const st = await areaFromOsm(file, name);
      $("dlg-areas").close();
      showTask(st.task);
      watchTask();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  let taskTimer = null;
  function watchTask() {
    clearTimeout(taskTimer);
    S.taskRunning = true;
    updateButtons();
    busy("Připravuji oblast…");
    taskTimer = setTimeout(taskStep, 500);
  }

  async function taskStep() {
    let t;
    try {
      t = await api("GET", "/api/task");
    } catch (e) {
      taskTimer = setTimeout(taskStep, 2000);
      return;
    }
    showTask(t);
    if (t.running) {
      busy(t.message || "Připravuji oblast…");
      taskTimer = setTimeout(taskStep, 700);
      return;
    }
    S.taskRunning = false;
    busy(null);
    if (t.phase === "done") toast(t.message);
    else if (t.phase === "error") toast(t.error, { error: true });
    if (t.phase === "done" && t.slug && (!S.area || S.area.slug !== t.slug)) {
      await openArea(t.slug); // pending changes are saved to the original area first
    } else {
      await refreshStatus();
    }
    updateButtons();
  }

  function showTask(t) {
    const box = $("task");
    if (!t || (!t.running && t.phase !== "error")) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.className = "status " + (t.running ? "status-busy" : "status-error");
    $("task-text").textContent = t.running ? "⏳ " + (t.message || t.description) : "Příprava se nepovedla: " + t.error;
    const pr = $("task-progress");
    pr.hidden = !(t.running && t.total);
    if (t.total) {
      pr.max = t.total;
      pr.value = t.done || 0;
    }
  }

  async function loadSegments(isNew) {
    let d;
    try {
      d = await api("GET", "/api/network/segments");
    } catch (e) {
      toast("Síť se nepodařilo zobrazit: " + e.message, { error: true });
      return;
    }
    const hadResults = Object.keys(S.results).length > 0;
    S.netVersion = d.version;
    S.segments = d.segments;
    S.lengths = d.lengths;
    S.results = {};
    S.summary = null;
    S.stale.clear();
    S.snaps = {};
    if (S.networkGroup) map.removeLayer(S.networkGroup);
    S.lines = S.segments.map((c, i) => L.polyline(c.map((p) => [p[1], p[0]]), { renderer, idx: i, weight: 2 }));
    S.networkGroup = L.featureGroup(S.lines);
    S.networkGroup.bindTooltip((l) => {
      const v = currentValues();
      if (!v) return "pěší síť";
      return R.escapeHtml(layerName(S.layer)) + ": " + R.formatM(v[l.options.idx]);
    }, { sticky: true, direction: "top", offset: [0, -8] });
    if (S.areaOutline) map.removeLayer(S.areaOutline);
    S.areaOutline = L.polygon(d.area.map((p) => [p[1], p[0]]), {
      color: "#334155", weight: 1.2, dashArray: "5 5", fill: false, interactive: false,
    }).addTo(map);
    if (isNew || !map.getBounds().intersects(S.areaOutline.getBounds())) map.fitBounds(S.areaOutline.getBounds());
    if (S.layer && S.layer !== SUMMARY && !S.typesByKey[S.layer]) S.layer = null;
    refreshMarkers();
    redrawList();
    refreshLayers();
    redrawNetwork();
    if (hadResults && !isNew) toast("Data oblasti se aktualizovala – výsledky spočítej znovu.");
  }

  function currentValues() {
    if (!S.layer) return null;
    if (S.layer === SUMMARY) return S.summary;
    return S.results[S.layer] || null;
  }

  function redrawNetwork() {
    if (!S.networkGroup) {
      legendDiv.hidden = true;
      $("stats").innerHTML = "";
      return;
    }
    const d = currentValues();
    const show = d || $("chk-show-network").checked;
    if (show && !map.hasLayer(S.networkGroup)) S.networkGroup.addTo(map);
    if (!show && map.hasLayer(S.networkGroup)) map.removeLayer(S.networkGroup);
    if (d) {
      const s = S.settings;
      for (let i = 0; i < S.lines.length; i++) {
        S.lines[i].setStyle({ color: R.color(d[i], s), weight: 4, opacity: 0.95 });
      }
      const caption = S.layer === SUMMARY
        ? "nejdelší z cest k nejbližším kontejnerům typů: " + S.summaryTypes.map(layerName).join(", ")
        : "vzdálenost po pěších cestách k nejbližšímu kontejneru";
      legendDiv.innerHTML = R.legendHtml(s, layerName(S.layer) + (S.stale.has(S.layer) ? " (neaktuální)" : ""), caption);
      legendDiv.hidden = false;
      showStats(d);
    } else {
      for (let i = 0; i < S.lines.length; i++) S.lines[i].setStyle({ color: "#4b5563", weight: 2, opacity: 0.7 });
      legendDiv.hidden = true;
      $("stats").innerHTML = "";
    }
    refreshMarkers();
  }

  function showStats(d) {
    const rows = R.statistics(d, S.lengths, S.settings);
    let h = '<div class="muted">Délka sítě v pásmech (celé načtené území):</div><table>';
    rows.forEach((r) => {
      h += '<tr><td><span class="line" style="background:' + r.color + '"></span>' + r.label + '</td><td class="num">' +
        r.km.toFixed(2).replace(".", ",") + ' km</td><td class="num">' + Math.round(r.share * 100) + " %</td></tr>";
    });
    $("stats").innerHTML = h + "</table>";
  }

  // ------------------------------------------------------------------ result layers

  function refreshLayers() {
    const box = $("layers");
    box.innerHTML = "";
    const items = [[null, "jen síť (bez výsledku)"]].concat(S.types.map((t) => [t.key, t.name]), [[SUMMARY, "Všechny typy (souhrn)"]]);
    items.forEach(([k, name]) => {
      const lab = document.createElement("label");
      const r = document.createElement("input");
      r.type = "radio";
      r.name = "layer";
      r.checked = S.layer === k;
      r.onchange = () => {
        S.layer = k;
        redrawNetwork();
      };
      lab.append(r);
      if (k && k !== SUMMARY) {
        const p = document.createElement("span");
        p.className = "dot small-dot";
        p.style.background = S.typesByKey[k].color;
        lab.append(p);
      }
      lab.append(document.createTextNode(" " + name + " "));
      if (k) {
        const computed = k === SUMMARY ? !!S.summary : !!S.results[k];
        const st = document.createElement("span");
        if (!computed) { st.className = "not-computed"; st.textContent = "(nespočítáno)"; }
        else if (S.stale.has(k)) { st.className = "stale"; st.textContent = "(neaktuální)"; }
        lab.append(st);
      }
      box.append(lab);
    });
  }

  // ------------------------------------------------------------------ computation

  let recomputeTimer = null;
  function scheduleRecompute() {
    clearTimeout(recomputeTimer);
    recomputeTimer = setTimeout(() => {
      if (!S.netVersion) return;
      if (S.layer === SUMMARY) compute("all", true);
      else {
        const k = S.layer && S.layer !== SUMMARY ? S.layer : S.activeType;
        if (S.containers.some((x) => x.typ === k)) compute([k], true);
      }
    }, 600);
  }

  async function compute(types, quiet) {
    if (!S.netVersion) {
      toast("Nejdřív vyber nebo připrav oblast.", { error: true });
      return false;
    }
    if (!quiet) busy("Počítám vzdálenosti…");
    const seq = ++requestCounter;
    const revisionWhenSent = Object.assign({}, S.revision);
    const changesWhenSent = changeCounter;
    const unchanged = (t) => (S.revision[t] || 0) === (revisionWhenSent[t] || 0);
    try {
      const r = await api("POST", "/api/compute", { types, containers: toFc() });
      containersSent(changesWhenSent);
      if (r.network_version !== S.netVersion) {
        await loadSegments();
        if (r.network_version !== S.netVersion) {
          toast("Síť se mezitím změnila – spočítej znovu.");
          return false;
        }
      }
      Object.entries(r.results).forEach(([k, d]) => {
        if ((S.usedResponse[k] || 0) > seq) return; // a newer result is already here
        S.results[k] = d;
        S.usedResponse[k] = seq;
        if (unchanged(k)) S.stale.delete(k);
        else S.stale.add(k);
      });
      if (r.summary && (S.usedResponse[SUMMARY] || 0) < seq) {
        S.summary = r.summary;
        S.summaryTypes = r.summary_types;
        S.usedResponse[SUMMARY] = seq;
        if (Object.keys(S.revision).every(unchanged)) S.stale.delete(SUMMARY);
        else S.stale.add(SUMMARY);
      }
      // take over snaps only for containers whose type did not change meanwhile
      const byId = Object.fromEntries(S.containers.map((k) => [String(k.id), k]));
      Object.entries(r.snaps).forEach(([id, info]) => {
        const k = byId[id];
        if (k && unchanged(k.typ)) S.snaps[id] = info;
      });
      const errors = Object.entries(r.checks || {}).filter(([, c]) => !c.ok)
        .map(([k, c]) => "Kontrola selhala (" + layerName(k) + "): na " + c.violated + " úsecích je vzdálenost po síti menší než vzdušná – nahlas prosím chybu.");
      showWarnings(r.warnings, errors);
      if (types === "all") {
        if (!S.layer || !(S.layer === SUMMARY || S.results[S.layer])) S.layer = S.results[S.activeType] ? S.activeType : SUMMARY;
      } else {
        S.layer = types[0];
      }
      refreshLayers();
      redrawNetwork();
      redrawList();
      if (!quiet) toast("Spočítáno: " + Object.keys(r.results).map(layerName).join(", ") + ".");
      return true;
    } catch (e) {
      showWarnings([], [e.message]);
      toast(e.message, { error: true });
      return false;
    } finally {
      busy(null);
    }
  }

  function showWarnings(warnings, errors) {
    const ul = $("warnings");
    ul.innerHTML = "";
    (errors || []).forEach((t) => {
      const li = document.createElement("li");
      li.className = "error";
      li.textContent = t;
      ul.append(li);
    });
    (warnings || []).forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      ul.append(li);
    });
  }

  // ------------------------------------------------------------------ variants and files

  async function saveVariant() {
    const def = "varianta " + new Date().toLocaleDateString("cs-CZ");
    const name = prompt("Název varianty rozmístění:", def);
    if (!name) return;
    try {
      const existing = await api("GET", "/api/variants");
      if (existing.some((v) => v.name.toLowerCase() === name.trim().toLowerCase()) &&
        !confirm("Varianta „" + name.trim() + "“ už existuje. Přepsat ji?")) return;
      const changesWhenSent = changeCounter;
      const r = await api("POST", "/api/variants", { name, containers: toFc() });
      containersSent(changesWhenSent);
      toast("Varianta „" + r.name + "“ uložena v prohlížeči.");
    } catch (e) {
      toast(e.message, { error: true });
    }
  }

  async function openVariants() {
    let list;
    try {
      list = await api("GET", "/api/variants");
    } catch (e) {
      toast(e.message, { error: true });
      return;
    }
    const ul = $("variant-list");
    ul.innerHTML = "";
    list.forEach((v) => {
      const li = document.createElement("li");
      const date = new Date(v.changed).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" });
      li.innerHTML = "<span><b>" + R.escapeHtml(v.name) + '</b><br><span class="muted small">' + date + " · " +
        (v.count ?? "?") + " kontejnerů</span></span>";
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Načíst";
      b.onclick = async () => {
        $("dlg-variants").close();
        try {
          await saveNow();
          const r = await api("POST", "/api/variants/load", { name: v.name });
          applyImport(r, "Načtena varianta „" + v.name + "“.");
        } catch (e) {
          toast(e.message, { error: true });
        }
      };
      li.append(b);
      ul.append(li);
    });
    $("dlg-variants").showModal();
  }

  async function uploadGeojson(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let fc;
    try {
      fc = JSON.parse(await file.text());
    } catch (err) {
      toast("Soubor není platný JSON/GeoJSON.", { error: true });
      return;
    }
    if (S.containers.length && !confirm("Nahradit " + S.containers.length + " aktuálních kontejnerů obsahem souboru?\n" +
      "(Tip: aktuální stav si můžeš nejdřív uložit jako variantu.)")) return;
    try {
      const r = await api("POST", "/api/containers/import", fc);
      applyImport(r, "Nahráno " + r.containers.features.length + " kontejnerů ze souboru " + file.name + ".");
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  function applyImport(r, message) {
    containersSent();
    setTypes(r.types);
    S.types.forEach((t) => { S.revision[t.key] = (S.revision[t.key] || 0) + 1; });
    S.snaps = {};
    Object.keys(S.results).forEach((k) => S.stale.add(k));
    if (S.summary) S.stale.add(SUMMARY);
    loadContainersFromFc(r.containers);
    refreshLayers();
    redrawNetwork();
    showWarnings(r.warnings, []);
    toast(message);
    if ($("chk-auto").checked) scheduleRecompute();
  }

  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function runExport(kind) {
    if (!S.netVersion) {
      toast("Nejdřív vyber nebo připrav oblast.", { error: true });
      return;
    }
    const b = map.getBounds();
    const body = {
      containers: toFc(),
      bands: S.settings.bands,
      mode: S.settings.mode,
      title: $("title").value.trim() || "Pěší dostupnost kontejnerů",
      layer: S.layer || S.activeType,
      extent: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      all: $("chk-png-all").checked,
      basemap: S.basemapMode,
    };
    busy(kind === "png" ? "Kreslím PNG… (chvíli to trvá)" : "Exportuji…");
    const changesWhenSent = changeCounter;
    try {
      const r = await exportData(kind, body);
      containersSent(changesWhenSent);
      downloadBlob(r.blob, r.name);
      if (r.warnings && r.warnings.length) {
        showWarnings(r.warnings, []);
        toast("Staženo: " + r.name + ", ale s varováním – viz panel Výpočet.");
      } else {
        toast("Staženo: " + r.name);
      }
    } catch (e) {
      toast("Export selhal: " + e.message, { error: true });
    } finally {
      busy(null);
    }
  }

  // ------------------------------------------------------------------ sharing

  function requireContainers() {
    if (!S.area) {
      toast("Nejdřív vyber nebo připrav oblast.", { error: true });
      return false;
    }
    if (!S.containers.length) {
      toast("Zatím není zadaný žádný kontejner.", { error: true });
      return false;
    }
    return true;
  }

  /** Layers a state can show: types with containers + summary. */
  function availableLayers() {
    const used = new Set(S.containers.map((k) => k.typ));
    return S.types.filter((t) => used.has(t.key)).map((t) => t.key).concat([SUMMARY]);
  }

  function defaultLayer() {
    const layers = availableLayers();
    return layers.indexOf(S.layer) >= 0 ? S.layer : SUMMARY;
  }

  function updateStateFileName() {
    const name = $("state-name").value.trim();
    $("state-file").textContent = name ? "Soubor: " + stateFileName(name, $("state-order").value) : "";
  }

  function openSaveState() {
    if (!requireContainers()) return;
    const sel = $("state-layer");
    sel.innerHTML = "";
    availableLayers().forEach((k) => sel.append(new Option(layerName(k), k)));
    sel.value = defaultLayer();
    const last = stored("last_state") || {};
    $("state-name").value = "";
    $("state-description").value = "";
    $("state-order").value = Number.isFinite(last.order) ? last.order + 1 : 1;
    updateStateFileName();
    const dlg = $("dlg-save-state");
    dlg.returnValue = "";
    dlg.onclose = async () => {
      if (dlg.returnValue !== "ok") return;
      const name = $("state-name").value.trim();
      if (!name) {
        toast("Zadej název stavu.", { error: true });
        return;
      }
      const order = $("state-order").value;
      busy("Ukládám stav…");
      const changesWhenSent = changeCounter;
      try {
        const o = await stateForSaving({ name, description: $("state-description").value, order, bands: S.settings.bands,
          layer: sel.value, containers: toFc() });
        containersSent(changesWhenSent);
        const file = stateFileName(name, order);
        downloadBlob(new Blob([JSON.stringify(o)], { type: "application/json" }), file);
        stored("last_state", { order: o.order });
        toast("Staženo: " + file + ". Nahraj ho do složky web/presets/ a zveřejni.", { long: true });
      } catch (e) {
        toast(e.message, { error: true });
      } finally {
        busy(null);
      }
    };
    dlg.showModal();
    $("state-name").focus();
  }

  async function openPreview() {
    if (!requireContainers()) return;
    // the window has to open right away (in the click), otherwise the browser blocks it
    const w = window.open("", "_blank");
    const changesWhenSent = changeCounter;
    try {
      const layer = defaultLayer();
      const o = await stateForSaving({ name: "Náhled (nezveřejněno)", description: "Náhled z režimu úprav – zatím není zveřejněný.",
        bands: S.settings.bands, layer, containers: toFc() });
      containersSent(changesWhenSent);
      await savePreview(o);
      const url = "index.html" + buildLink({ preview: true, layer });
      if (w) w.location.href = url;
      else location.href = url;
    } catch (e) {
      if (w) w.close();
      toast(e.message, { error: true });
    }
  }

  async function openStateDialog() {
    const ul = $("published-list");
    ul.innerHTML = '<li class="muted">Načítám seznam…</li>';
    $("dlg-open-state").showModal();
    let list;
    try {
      const r = await fetch("presets/index.json", { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      list = (await r.json()).states || [];
    } catch (e) {
      ul.innerHTML = '<li class="muted">Seznam zveřejněných stavů není k dispozici (' + R.escapeHtml(e.message) + ").</li>";
      return;
    }
    ul.innerHTML = "";
    list.forEach((s) => {
      const li = document.createElement("li");
      li.innerHTML = "<span><b>" + R.escapeHtml(s.name) + '</b><br><span class="muted small">' + R.escapeHtml(s.file) + " · " +
        s.containers + " kontejnerů · " + R.escapeHtml(s.area || "") + "</span></span>";
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Otevřít";
      b.onclick = async () => {
        busy("Načítám stav…");
        try {
          const r = await fetch("presets/" + encodeURIComponent(s.file), { cache: "no-cache" });
          if (!r.ok) throw new Error("Soubor " + s.file + " se nepodařilo načíst (HTTP " + r.status + ").");
          const o = await r.json();
          $("dlg-open-state").close();
          await takeOver(o);
        } catch (e) {
          toast(e.message, { error: true });
        } finally {
          busy(null);
        }
      };
      li.append(b);
      ul.append(li);
    });
  }

  async function uploadState(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let o;
    try {
      o = JSON.parse(await file.text());
      validateState(o);
    } catch (err) {
      toast(err instanceof SyntaxError ? "Soubor není platný JSON." : err.message, { error: true });
      return;
    }
    $("dlg-open-state").close();
    await takeOver(o);
  }

  async function takeOver(o) {
    if (!confirm("Otevřít stav „" + o.name + "“ k úpravám?\nKontejnery oblasti se nahradí kontejnery ze stavu " +
      "(dosavadní rozmístění se uloží jako varianta).")) return;
    busy("Otevírám stav…");
    try {
      if (saveTimer) await saveNow();
      const r = await takeOverState(o);
      if (o.display.bands.length === S.settings.bands.length) {
        S.settings.bands = o.display.bands.slice();
        saveSettings();
        buildBandInputs();
      }
      S.revision = {};
      S.snaps = {};
      await refreshStatus();
      const layer = o.display.layer;
      if (await compute("all", true)) {
        if (layer === SUMMARY || S.results[layer]) S.layer = layer;
        refreshLayers();
        redrawNetwork();
      }
      if (r.warnings && r.warnings.length) showWarnings(r.warnings, []);
      toast("Otevřen stav „" + o.name + "“" + (r.newArea ? " (nová oblast)" : "") +
        (r.backup ? ". Původní kontejnery jsou ve variantě „" + r.backup + "“." : "."), { long: true });
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      busy(null);
    }
  }

  start();
})();
