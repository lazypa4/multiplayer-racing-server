// Turbo capsules: pickups scattered along the road. Each one collected adds a
// turbo to the car's stock. The server decides who gets each capsule.

import { ROAD_HALF } from './tracks.js';

export const CAPSULE_RADIUS = 30;          // pickup distance from the car's center
export const CAPSULE_RESPAWN_MS = 8000;
const CAPSULE_SPACING = 700;               // roughly one capsule per this many px of track

// One capsule per stretch of track, so they're spread over the whole lap.
export function createCapsules(track) {
  const count = Math.max(6, Math.round(track.length / CAPSULE_SPACING));
  return Array.from({ length: count }, (_, slot) => ({ id: slot, slot, count, on: true, respawnAt: 0, ...capsuleSpot(track, slot, count) }));
}

// A random spot on the road inside the capsule's stretch. The starting grid
// and the first few meters after the line are kept clear.
export function capsuleSpot(track, slot, count) {
  const first = Math.round(150 / track.spacing);
  const last = track.n - Math.round(450 / track.spacing);
  const len = (last - first) / count;
  const idx = first + Math.floor((slot + 0.15 + Math.random() * 0.7) * len);
  const lat = (Math.random() * 2 - 1) * (ROAD_HALF - 22);
  return {
    idx,
    lat,
    x: Math.round(track.xs[idx] + track.nx[idx] * lat),
    y: Math.round(track.ys[idx] + track.ny[idx] * lat),
  };
}

// Did a car moving from (x0, y0) to (x1, y1) pass over the capsule? Checking
// the whole segment means fast cars can't skip over one between updates.
export function touchesCapsule(cap, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((cap.x - x0) * dx + (cap.y - y0) * dy) / l2)) : 0;
  const px = x0 + dx * t - cap.x, py = y0 + dy * t - cap.y;
  return px * px + py * py < CAPSULE_RADIUS * CAPSULE_RADIUS;
}
