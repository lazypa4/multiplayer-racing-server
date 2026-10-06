// Simple racing AI: chase a point further down the centerline (with a
// personal lane offset), brake for corners, grab turbo capsules and burn
// turbos on straights.

import { respawnPoint } from './shared/tracks.js';
import { TUNING } from './shared/physics.js';

const BOT_NAMES = ['Blaze', 'Nitro', 'Vortex', 'Turbo', 'Comet', 'Jolt', 'Raptor', 'Spark', 'Bolt', 'Viper', 'Ace', 'Dash'];

export function botName(taken) {
  const free = BOT_NAMES.filter((n) => !taken.has(n));
  return free.length ? free[Math.floor(Math.random() * free.length)] : `Bot ${taken.size + 1}`;
}

export function createBrain() {
  return {
    skill: 0.86 + Math.random() * 0.1,     // fraction of max speed it dares to carry
    lane: (Math.random() - 0.5) * 50,
    greed: 40 + Math.random() * 80,         // how far off its line it will swerve for a capsule
    laneTarget: 0,
    stuck: 0,
    tries: 0,
    reverse: 0,
  };
}

const wrap = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

export function botInput(car, brain, track, others, dt, capsules = []) {
  const n = track.n;
  const speed = Math.hypot(car.vx, car.vy);
  const idx = Math.max(0, car.idx);

  // Avoid running straight into a car just ahead by drifting to a side lane.
  let blocked = 0;
  const fx = Math.cos(car.a), fy = Math.sin(car.a);
  for (const o of others) {
    const dx = o.x - car.x, dy = o.y - car.y;
    const ahead = dx * fx + dy * fy;
    const side = -dx * fy + dy * fx;
    if (ahead > 0 && ahead < 120 && Math.abs(side) < 30) blocked = side > 0 ? -1 : 1;
  }

  // Swerve for a turbo capsule coming up if it isn't too far off our line.
  let capLane = null;
  if (car.turbo < TUNING.turboStock) {
    let best = Infinity;
    for (const c of capsules) {
      if (!c.on) continue;
      const ahead = (c.idx - idx + n) % n;
      if (ahead < 1 || ahead > 70 || ahead >= best || Math.abs(c.lat - brain.lane) > brain.greed) continue;
      best = ahead;
      capLane = c.lat;
    }
  }
  const want = blocked ? blocked * 45 : capLane ?? brain.laneTarget;
  brain.lane += (want - brain.lane) * Math.min(1, dt * (capLane === null ? 2 : 3));
  if (Math.random() < dt * 0.3) brain.laneTarget = (Math.random() - 0.5) * 60;

  const look = Math.round((70 + speed * 0.42) / track.spacing);
  const ti = (idx + look) % n;
  const tx = track.xs[ti] + track.nx[ti] * brain.lane;
  const ty = track.ys[ti] + track.ny[ti] * brain.lane;
  const diff = wrap(Math.atan2(ty - car.y, tx - car.x) - car.a);

  // Fastest speed that still lets us slow down for every corner ahead.
  const cornerGrip = 1.75 * brain.skill;           // rad/s we're willing to turn at
  const decel = 650;
  const turboOn = car.turboTime > 0;
  const normalCap = TUNING.maxSpeed * brain.skill;
  const turboCap = normalCap * TUNING.turboMult;
  const canTurbo = !turboOn && car.turbo > 0 && speed > 250;
  let target = turboOn || canTurbo ? turboCap : normalCap;
  let bend = 0;
  const plan = Math.max(speed, canTurbo ? turboCap : 0);
  const reach = Math.round((plan * plan) / (2 * decel) / track.spacing) + 12;
  for (let k = 0; k <= reach; k += 2) {
    const i = (idx + k) % n;
    const vCorner = cornerGrip * track.radius[i];
    const dist = k * track.spacing;
    target = Math.min(target, Math.sqrt(vCorner * vCorner + 2 * decel * dist));
    if (k < 60) bend = Math.max(bend, 1 / track.radius[i]);
  }
  bend *= 300;
  // Only fire a turbo when there's enough straight road to use it.
  const nitro = canTurbo && bend < 0.3 && target > normalCap * 1.3;
  if (!turboOn && !nitro) target = Math.min(target, normalCap);

  const input = {
    steer: Math.max(-1, Math.min(1, diff * 2.6)),
    up: speed < target,
    down: speed > target + 70,
    handbrake: false,
    nitro,
  };

  // Stuck against something? Back up for a moment, and respawn if that fails.
  if (brain.reverse > 0) {
    brain.reverse -= dt;
    return { steer: -input.steer, up: false, down: true, handbrake: false, nitro: false };
  }
  if (speed > 150) brain.tries = 0;
  if (speed < 25) brain.stuck += dt; else brain.stuck = 0;
  if (brain.stuck > 1.2) {
    brain.stuck = 0;
    if (++brain.tries >= 3) {
      brain.tries = 0;
      const p = respawnPoint(track, idx);
      Object.assign(car, { x: p.x, y: p.y, a: p.a, vx: 0, vy: 0 });
    } else {
      brain.reverse = 0.8;
    }
  }
  return input;
}
