// Simple metric projection around the area centre (for areas up to tens of km the length
// error is below 0.1 %), distances and helpers.
export const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;

export function projection(lat0, lon0) {
  const kx = Math.cos(lat0 * RAD) * EARTH_RADIUS * RAD;
  const ky = EARTH_RADIUS * RAD;
  return {
    lat0, lon0,
    toXY: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLL: (x, y) => [lon0 + x / kx, lat0 + y / ky],
  };
}

export function projectionForBbox(bbox) {
  return projection((bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2);
}

const M_PER_DEGREE = 111320;

/** bbox = [west, south, east, north] grown by marginM metres on every side. */
export function expandBbox([w, s, e, n], marginM) {
  const lat = (s + n) / 2;
  const dlat = marginM / M_PER_DEGREE;
  const dlon = marginM / (M_PER_DEGREE * Math.max(Math.cos(lat * RAD), 0.01));
  return [w - dlon, s - dlat, e + dlon, n + dlat];
}

export function areaKm2([w, s, e, n]) {
  const lat = (s + n) / 2;
  return Math.abs(n - s) * M_PER_DEGREE / 1000 * Math.abs(e - w) * M_PER_DEGREE * Math.cos(lat * RAD) / 1000;
}

/** Perpendicular projection of point p onto segment a–b: {t (0..1), x, y, d (distance)}. */
export function projectOntoSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return { t, x, y, d: Math.hypot(px - x, py - y) };
}
