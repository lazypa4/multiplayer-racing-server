// Arcade top-down car physics. The same code drives the local player in the
// browser and the bots on the server, so everyone handles identically.

import { advance, ROAD_HALF, WALL } from './tracks.js';

export const STEP = 1 / 120;                 // fixed simulation step (seconds)
export const CAR = { length: 40, width: 20, circle: 10.5, offset: 10 };

export const TUNING = {
  accel: 430,          // px/s² from standstill
  brake: 950,
  reverseAccel: 260,
  maxSpeed: 560,
  maxReverse: 190,
  drag: 0.25,          // proportional drag
  rolling: 90,         // coasting deceleration
  grip: 11,            // how fast sideways velocity is killed
  driftGrip: 2.2,      // grip while the handbrake is held
  offroadGrip: 6,
  slipRecovery: 0.3,   // part of scrubbed sideways speed returned as forward speed
  turnRate: 3.3,       // rad/s at full lock
  offroadMax: 250,
  turboMult: 1.5,      // top speed multiplier while a turbo is burning
  turboAccel: 600,     // extra push while a turbo is burning
  turboDuration: 3,    // seconds per turbo
  turboStock: 5,       // most turbos a car can carry
};

export function createCar(x, y, a, idx = -1, prog = 0) {
  return {
    x, y, a, vx: 0, vy: 0,
    steer: 0,
    turbo: 0, turboTime: 0, turboHeld: false,
    boosting: false, drifting: false, offroad: false,
    wallHit: 0,
    idx, prog,
  };
}

export const NO_INPUT = Object.freeze({ up: false, down: false, left: false, right: false, handbrake: false, nitro: false });

// Advance one car by `dt` seconds. `input` holds booleans for up/down/left/
// right/handbrake/nitro (nitro = use a turbo), and optionally an analog
// `steer` in [-1, 1].
export function stepCar(car, input, dt, track, speedScale = 1) {
  const T = TUNING;
  const fx = Math.cos(car.a), fy = Math.sin(car.a);
  const rx = -fy, ry = fx;
  let vF = car.vx * fx + car.vy * fy;
  let vR = car.vx * rx + car.vy * ry;

  const targetSteer = input.steer ?? ((input.right ? 1 : 0) - (input.left ? 1 : 0));
  car.steer += (targetSteer - car.steer) * Math.min(1, dt * 12);

  // A fresh press of the turbo key spends one collected turbo.
  if (input.nitro && !car.turboHeld && car.turbo > 0 && car.turboTime <= 0) {
    car.turbo--;
    car.turboTime = T.turboDuration;
  }
  car.turboHeld = !!input.nitro;
  const boosting = car.turboTime > 0;
  if (boosting) car.turboTime = Math.max(0, car.turboTime - dt);
  car.boosting = boosting;
  let maxSpeed = T.maxSpeed * speedScale * (boosting ? T.turboMult : 1);
  if (car.offroad) maxSpeed = Math.min(maxSpeed, T.offroadMax * (boosting ? 1.3 : 1));

  const throttle = input.up || (boosting && !input.down);    // turbo pushes even off the gas
  if (throttle && vF >= -20) {
    if (vF < maxSpeed) {
      const a = T.accel * (1 - 0.55 * Math.max(0, vF) / maxSpeed) + (boosting ? T.turboAccel : 0);
      vF = Math.min(maxSpeed, vF + a * dt);
    }
  } else if (input.up) {
    vF += T.brake * dt;                      // braking out of reverse
  }
  if (input.down) {
    if (vF > 15) vF -= T.brake * dt;
    else if (vF > -T.maxReverse) vF -= T.reverseAccel * dt;
  }
  if (!throttle && !input.down) {
    vF -= Math.sign(vF) * Math.min(Math.abs(vF), T.rolling * dt);
  }
  if (input.handbrake) {
    vF -= Math.sign(vF) * Math.min(Math.abs(vF), 160 * dt);
  }
  if (vF > maxSpeed) vF -= (vF - maxSpeed) * Math.min(1, 2.2 * dt);   // bleed off excess speed
  vF -= vF * T.drag * dt * (car.offroad ? 3 : 1);

  // Lateral grip. Scrubbed speed is partly converted back to forward motion,
  // which keeps drifts fun instead of grinding the car to a halt.
  const grip = input.handbrake ? T.driftGrip : (car.offroad ? T.offroadGrip : T.grip);
  const keep = Math.exp(-grip * dt);
  const scrub = vR * (1 - keep);
  vR -= scrub;
  if (Math.abs(vF) < maxSpeed) vF += Math.sign(vF) * Math.abs(scrub) * T.slipRecovery;

  // Steering: needs some speed to turn, and is a bit less twitchy when fast.
  const speed = Math.abs(vF);
  const lowSpeed = Math.min(1, speed / 110);
  const highSpeed = 1 - 0.32 * Math.min(1, speed / (T.maxSpeed * T.turboMult));
  let turn = car.steer * T.turnRate * lowSpeed * highSpeed * (input.handbrake ? 1.4 : 1);
  if (vF < 0) turn = -turn;

  // Velocity stays in the old frame; the heading then rotates. The grip above
  // pulls the velocity back in line next step, which is what creates slides.
  car.vx = fx * vF + rx * vR;
  car.vy = fy * vF + ry * vR;
  car.a += turn * dt;
  if (car.a > Math.PI) car.a -= 2 * Math.PI;
  if (car.a < -Math.PI) car.a += 2 * Math.PI;

  car.drifting = Math.abs(vR) > 70 && speed > 140;

  car.x += car.vx * dt;
  car.y += car.vy * dt;
  applyTrack(car, track);
}

// Keep the car inside the barriers and flag whether it is on the grass.
export function applyTrack(car, track) {
  const loc = advance(car, track);
  const abs = Math.abs(loc.lat);
  car.offroad = abs > ROAD_HALF + 6;
  car.wallHit = 0;
  const limit = WALL - CAR.width * 0.6;
  if (abs > limit) {
    const s = Math.sign(loc.lat);
    const nx = track.nx[loc.idx] * s, ny = track.ny[loc.idx] * s;   // outward normal
    const over = abs - limit;
    car.x -= nx * over;
    car.y -= ny * over;
    const vn = car.vx * nx + car.vy * ny;
    if (vn > 0) {
      car.vx -= nx * vn * 1.35;
      car.vy -= ny * vn * 1.35;
      const keep = 1 - Math.min(0.35, vn / 1500);
      car.vx *= keep;
      car.vy *= keep;
      car.wallHit = vn;
    }
  }
}

// Each car is approximated by two circles along its axis. Resolves overlap
// between `a` and `b`. If `bFixed` is true only `a` is moved (used on the
// client, where other cars belong to other players).
export function collideCars(a, b, bFixed = false) {
  const dxc = a.x - b.x, dyc = a.y - b.y;
  if (dxc * dxc + dyc * dyc > 60 * 60) return 0;

  // Resolve the deepest overlapping circle pair; at 120 Hz that is plenty.
  const ca = circles(a), cb = circles(b);
  const r2 = CAR.circle * 2;
  let best = null;
  for (const p of ca) {
    for (const q of cb) {
      const dx = p.x - q.x, dy = p.y - q.y;
      const d = Math.hypot(dx, dy);
      if (d < r2 && (!best || d < best.d)) best = { dx, dy, d };
    }
  }
  if (!best) return 0;

  const d = best.d || 0.001;
  const nx = best.d ? best.dx / d : 1, ny = best.d ? best.dy / d : 0;
  const overlap = r2 - d;
  if (bFixed) {
    a.x += nx * overlap; a.y += ny * overlap;
  } else {
    a.x += nx * overlap / 2; a.y += ny * overlap / 2;
    b.x -= nx * overlap / 2; b.y -= ny * overlap / 2;
  }
  const rv = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (rv >= 0) return 0;
  const j = -(1 + 0.4) * rv / 2;              // equal masses, a bit bouncy
  a.vx += j * nx; a.vy += j * ny;
  if (!bFixed) { b.vx -= j * nx; b.vy -= j * ny; }
  return -rv;
}

function circles(c) {
  const ox = Math.cos(c.a) * CAR.offset, oy = Math.sin(c.a) * CAR.offset;
  return [{ x: c.x + ox, y: c.y + oy }, { x: c.x - ox, y: c.y - oy }];
}

export function speedKmh(car) {
  return Math.round(Math.hypot(car.vx, car.vy) * 0.4);
}
