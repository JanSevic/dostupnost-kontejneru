// Web app configuration. Waste types and other values are edited here.
export const CONFIG = {
  territory_name: "Dřínov",
  default_view: { label: "Dřínov, okres Mělník", lat: 50.2736, lon: 14.3975, zoom: 15 },
  // [west, south, east, north]; network_margin_m is added around the extent
  default_area: { name: "Dřínov (okres Mělník)", extent: [14.3862, 50.2664, 14.4088, 50.2808] },
  types: [
    { key: "plast", name: "Plast", color: "#f2c200", abbr: "Pl" },
    { key: "papir", name: "Papír", color: "#1f63c6", abbr: "Pa" },
    { key: "sklo", name: "Sklo", color: "#1b8a3a", abbr: "Sk" },
    { key: "kovy", name: "Kovy", color: "#7d8590", abbr: "Ko" },
    { key: "textil", name: "Textil", color: "#8e44ad", abbr: "Tx" },
    { key: "kartony", name: "Nápojové kartony", color: "#f76707", abbr: "NK" },
    { key: "oleje", name: "Jedlé oleje", color: "#5c3d1e", abbr: "Ol" },
  ],
  bands_m: [100, 200],
  band_colors: ["#1a9850", "#f08c00", "#d7301f"],
  unreachable_color: "#9e9e9e",
  network_margin_m: 300,
  max_area_km2: 30,
  segment_length_m: 10,
  connection_warning_m: 30,
  tiles: {
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© přispěvatelé OpenStreetMap",
    max_zoom: 19,
  },
  overpass_url: "https://overpass-api.de/api/interpreter",
  summary_key: "vse",
};

export const OSM_ATTRIBUTION = "© přispěvatelé OpenStreetMap";
