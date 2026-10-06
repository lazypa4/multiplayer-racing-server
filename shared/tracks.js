// Track definitions and geometry helpers. Shared by the server (bots, lap
// counting) and the browser (rendering, local physics).

export const ROAD_HALF = 80;          // half the asphalt width
export const RUNOFF = 48;             // grass between the road edge and the barrier
export const WALL = ROAD_HALF + RUNOFF;
const SPACING = 10;                   // distance between resampled centerline points

// Control points are in "units" (scaled by `scale`) and are joined with a
// closed Catmull-Rom spline. The race runs in the order the points are listed
// and the start/finish line sits on the first point.
const TRACK_DEFS = {
  oval: {
    name: 'Sunset Speedway',
    scale: 100,
    theme: { grass: '#c7a25a', grassDark: '#b28c48', tree: '#7c8a3c', treeDark: '#5f6b2b' },
    points: stadium(0, 0, 22, 6.2, 16),
  },
  grandprix: {
    name: 'Grand Prix',
    scale: 110,
    theme: { grass: '#3f7d36', grassDark: '#376e2f', tree: '#2f6b2a', treeDark: '#21501e' },
    points: [
      [6, 0], [12, 0], [16, 0.8], [18.2, 3.4], [18, 6.6], [15.6, 8.6],
      [12.4, 8.4], [10.2, 6.8], [7.8, 6.4], [5.8, 8], [5.4, 10.8], [7, 13.2],
      [10.4, 13.8], [14.2, 14.2], [17, 15.8], [17, 18.6], [14, 19.8], [8, 19.8],
      [2, 19.6], [-2.4, 18], [-4, 14.6], [-3.4, 10.4], [-4.4, 6.4], [-4, 2.4], [-2.4, 0.4], [0, 0],
    ],
  },
  canyon: {
    name: 'Canyon Run',
    scale: 105,
    theme: { grass: '#a4583a', grassDark: '#8f4a30', tree: '#6b7d3a', treeDark: '#4f5e28' },
    points: [
      [5, 0], [10, 0.2], [13.6, 1.6], [14.6, 4.6], [12.8, 7], [9.6, 7.2],
      [7.6, 8.8], [8, 11.6], [11, 12.6], [14.6, 12], [18, 11.4], [21, 12.6],
      [22, 15.8], [20, 18.6], [16, 19.4], [11, 19.2], [6, 19.6], [1.6, 19.2],
      [-1.8, 17], [-2.6, 13.4], [-0.6, 10.6], [1.4, 8], [0.6, 5], [-1.8, 3.8], [-3, 2], [-2.2, 0.3], [0, 0],
    ],
  },
};

export const TRACK_LIST = Object.entries(TRACK_DEFS).map(([id, d]) => ({ id, name: d.name }));
export const DEFAULT_TRACK = 'grandprix';

function stadium(cx, cy, length, radius, perSide) {
  // A rounded rectangle racetrack, traced clockwise (screen coords) from the
  // middle of the top straight.
  const pts = [];
  const half = length / 2;
  const straight = (x0, x1, y) => {
    for (let i = 0; i < perSide; i++) pts.push([x0 + (x1 - x0) * (i / perSide), y]);
  };
  const arc = (ax, ay, from) => {
    const steps = 10;
    for (let i = 0; i < steps; i++) {
      const t = from + Math.PI * (i / steps);
      pts.push([ax + Math.cos(t) * radius, ay + Math.sin(t) * radius]);
    }
  };
  // start mid top straight going right
  for (let i = 0; i < perSide / 2; i++) pts.push([cx + half * (i / (perSide / 2)), cy - radius]);
  arc(cx + half, cy, -Math.PI / 2);
  straight(cx + half, cx - half, cy + radius);
  arc(cx - half, cy, Math.PI / 2);
  for (let i = 0; i < perSide / 2; i++) pts.push([cx - half + half * (i / (perSide / 2)), cy - radius]);
  return pts;
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

const cache = new Map();

export function getTrack(id) {
  if (!TRACK_DEFS[id]) id = DEFAULT_TRACK;
  if (!cache.has(id)) cache.set(id, buildTrack(id));
  return cache.get(id);
}

function buildTrack(id) {
  const def = TRACK_DEFS[id];
  const cp = def.points.map(([x, y]) => [x * def.scale, y * def.scale]);
  const m = cp.length;

  // Densely sample the spline, then resample at a fixed arc length so that
  // "index distance" is proportional to real distance along the track.
  const dense = [];
  for (let i = 0; i < m; i++) {
    const p0 = cp[(i - 1 + m) % m], p1 = cp[i], p2 = cp[(i + 1) % m], p3 = cp[(i + 2) % m];
    for (let s = 0; s < 40; s++) {
      const t = s / 40;
      dense.push([catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  dense.push(dense[0]);

  let total = 0;
  const cum = [0];
  for (let i = 1; i < dense.length; i++) {
    total += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
    cum.push(total);
  }
  const n = Math.round(total / SPACING);
  const step = total / n;
  const xs = new Float32Array(n), ys = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = i * step;
    while (cum[j + 1] < d) j++;
    const f = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
    xs[i] = dense[j][0] + (dense[j + 1][0] - dense[j][0]) * f;
    ys[i] = dense[j][1] + (dense[j + 1][1] - dense[j][1]) * f;
  }

  // Tangents, normals (pointing to the right of the driving direction) and heading.
  const tx = new Float32Array(n), ty = new Float32Array(n);
  const nx = new Float32Array(n), ny = new Float32Array(n), ang = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    let dx = xs[b] - xs[a], dy = ys[b] - ys[a];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    tx[i] = dx; ty[i] = dy;
    nx[i] = -dy; ny[i] = dx;
    ang[i] = Math.atan2(dy, dx);
  }
  // Radius of curvature at each sample (large on straights).
  const radius = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let d = ang[(i + 3) % n] - ang[(i - 3 + n) % n];
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    radius[i] = Math.min(5000, (6 * step) / (Math.abs(d) || 1e-6));
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]);
    minY = Math.min(minY, ys[i]); maxY = Math.max(maxY, ys[i]);
  }
  const pad = WALL + 260;
  const bounds = { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };

  return { id, name: def.name, theme: def.theme, n, spacing: step, length: total, xs, ys, tx, ty, nx, ny, ang, radius, bounds };
}

// Find the centerline sample nearest to (x, y). When `hint` is a valid index
// only a window around it is searched, which keeps cars from "jumping" to a
// different part of the circuit that happens to be close by.
export function locate(track, x, y, hint = -1) {
  const { n, xs, ys } = track;
  let best = 0, bestD = Infinity;
  if (hint >= 0) {
    for (let k = -45; k <= 45; k++) {
      const i = (hint + k + n) % n;
      const dx = x - xs[i], dy = y - ys[i];
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const dx = x - xs[i], dy = y - ys[i];
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
  }
  const lat = (x - xs[best]) * track.nx[best] + (y - ys[best]) * track.ny[best];
  return { idx: best, lat };
}

// Update a car's nearest index and its continuous progress counter
// (`prog`, measured in samples; one lap == track.n).
export function advance(car, track) {
  const loc = locate(track, car.x, car.y, car.idx);
  if (car.idx >= 0) {
    let d = loc.idx - car.idx;
    if (d > track.n / 2) d -= track.n;
    if (d < -track.n / 2) d += track.n;
    car.prog += d;
  }
  car.idx = loc.idx;
  return loc;
}

// Starting grid: two staggered columns behind the start/finish line.
export function gridSlot(track, slot) {
  const row = Math.floor(slot / 2), col = slot % 2;
  const back = 70 + row * 90 + col * 45;
  const steps = Math.round(back / track.spacing);
  const idx = (track.n - steps) % track.n;
  const lat = col === 0 ? -34 : 34;
  return {
    x: track.xs[idx] + track.nx[idx] * lat,
    y: track.ys[idx] + track.ny[idx] * lat,
    a: track.ang[idx],
    idx,
    prog: -steps,
  };
}

// Respawn point on the centerline at a given index.
export function respawnPoint(track, idx) {
  return { x: track.xs[idx], y: track.ys[idx], a: track.ang[idx] };
}
