// How each waste type is collected. The settings travel with the containers as the foreign member
// "sber" of the container GeoJSON. Its keys are Czech because it is part of the user-facing file format:
//   {"papir": {"od_domu": true}, "kovy": {"spolu_s": ["plast"]}}
//   od_domu  – door-to-door collection: every household has it at home; containers of the type are only backup points,
//   spolu_s  – multi-commodity collection: the type is also accepted in containers of the listed types.
const KEY = /^[a-z0-9_]+$/;

/** Cleans the collection settings (unknown keys and invalid values are dropped). */
export function normaliseCollection(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!KEY.test(k) || !v || typeof v !== "object") continue;
    const r = {};
    if (v.od_domu === true) r.od_domu = true;
    const also = Array.isArray(v.spolu_s) ? [...new Set(v.spolu_s.map(String).filter((x) => KEY.test(x) && x !== k))] : [];
    if (also.length) r.spolu_s = also;
    if (Object.keys(r).length) out[k] = r;
  }
  return out;
}

export const isDoorToDoor = (c, key) => !!(c && c[key] && c[key].od_domu);
export const sharedWith = (c, key) => (c && c[key] && c[key].spolu_s) || [];

/** Points serving each type: its own containers plus containers of the types it is collected together with. */
export function sourcesByType(fc, types, collection) {
  const own = {};
  for (const f of fc.features) {
    (own[f.properties.typ] ||= []).push({ id: f.properties.id, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
  }
  const out = {};
  for (const t of types) {
    const points = [...(own[t.key] || [])];
    for (const other of sharedWith(collection, t.key)) points.push(...(own[other] || []));
    if (points.length) out[t.key] = points;
  }
  return out;
}

/** Types that count towards the "all types" summary – door-to-door types do not (everyone has them at home). */
export function summaryKeys(keys, collection) {
  return keys.filter((k) => !isDoorToDoor(collection, k));
}

/** Czech sentences describing the collection settings (for the viewer and legends). */
export function describeCollection(collection, types) {
  const name = (k) => (types.find((t) => t.key === k) || { name: k }).name;
  const lines = [];
  const door = types.filter((t) => isDoorToDoor(collection, t.key)).map((t) => t.name);
  if (door.length) lines.push("Svoz od domu: " + door.join(", ") + " (kontejnery jsou jen záložní místa).");
  for (const t of types) {
    const also = sharedWith(collection, t.key).filter((k) => types.some((x) => x.key === k));
    if (also.length) lines.push(t.name + " se sbírá také do kontejnerů: " + also.map(name).join(", ") + ".");
  }
  return lines;
}

/** Layer name with the collection mode, e.g. "Papír – záložní místa". */
export function layerLabel(type, collection) {
  return isDoorToDoor(collection, type.key) ? type.name + " – záložní místa" : type.name;
}
