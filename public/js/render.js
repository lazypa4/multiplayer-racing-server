// Canvas renderer: track, cars, skid marks, particles, name tags, minimap.

import { ROAD_HALF, WALL, gridSlot } from '/shared/tracks.js';

const MAX_SKIDS = 2600;
const MAX_PARTICLES = 500;

// Camera views the player can pick from. `zoom` multiplies the base zoom,
// `lead` is how far (in seconds of travel) the camera looks ahead, and
// `rotate` turns the world so the car always points up the screen.
export const CAMERA_MODES = [
  { id: 'classic', name: 'Classic', desc: 'Top-down, north always up', zoom: 1, lead: 0.28, rotate: false },
  { id: 'chase', name: 'Chase', desc: 'Turns with your car, road ahead is always up', zoom: 1.1, lead: 0, rotate: true },
  { id: 'close', name: 'Close-up', desc: 'Zoomed in tight on your car', zoom: 1.55, lead: 0.18, rotate: false },
  { id: 'wide', name: 'Wide', desc: 'Zoomed out to see more of the track', zoom: 0.62, lead: 0.32, rotate: false },
];
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 1.8;

const wrapAngle = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

export class Renderer {
  constructor(canvas, minimap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = minimap;
    this.mctx = minimap.getContext('2d');
    this.cam = { x: 0, y: 0, zoom: 1, rot: 0, ready: false };
    this.mode = CAMERA_MODES[0];
    this.userZoom = 1;
    this.skids = new Float32Array(MAX_SKIDS * 4);
    this.skidHead = 0;
    this.skidCount = 0;
    this.particles = [];
    this.fx = new Map();          // per-car effect state (last wheel positions)
    this.shake = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    const mw = this.mini.clientWidth || 180;
    this.mini.width = Math.round(mw * this.dpr);
    this.mini.height = Math.round(mw * this.dpr);
    if (this.track) this.buildMinimap();
  }

  setTrack(track) {
    this.track = track;
    const { xs, ys, nx, ny, n } = track;
    const offset = (d) => {
      const p = new Path2D();
      for (let i = 0; i < n; i++) {
        const x = xs[i] + nx[i] * d, y = ys[i] + ny[i] * d;
        i ? p.lineTo(x, y) : p.moveTo(x, y);
      }
      p.closePath();
      return p;
    };
    this.center = offset(0);
    this.edges = [offset(-(ROAD_HALF - 8)), offset(ROAD_HALF - 8)];
    this.walls = [offset(-(WALL + 6)), offset(WALL + 6)];
    this.curbs = buildCurbs(track);
    this.grass = makeGrass(this.ctx, track.theme);
    this.asphalt = makeAsphalt(this.ctx);
    this.trees = placeTrees(track);
    this.treeSprites = [26, 32, 38].map((r) => treeSprite(r, track.theme));
    this.gridSlots = Array.from({ length: 8 }, (_, i) => gridSlot(track, i));
    this.skidHead = this.skidCount = 0;
    this.particles = [];
    this.fx.clear();
    this.cam.ready = false;
    this.buildMinimap();
  }

  // ------------------------------------------------------------ camera

  setCameraMode(id) {
    this.mode = CAMERA_MODES.find((m) => m.id === id) || CAMERA_MODES[0];
    return this.mode;
  }

  setUserZoom(z) {
    this.userZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    return this.userZoom;
  }

  follow(target, dt) {
    const cam = this.cam, m = this.mode;
    const vx = target.vx || 0, vy = target.vy || 0;
    const speedK = Math.min(1, Math.hypot(vx, vy) / 780);
    const base = Math.sqrt(this.w * this.h) / 1050;
    const zoom = base * m.zoom * this.userZoom * (1 - 0.2 * speedK);

    // Rotation eases toward the car's heading in chase view, and back to
    // north-up in the other views, so switching never snaps.
    const rot = m.rotate ? -Math.PI / 2 - target.a : 0;
    if (!cam.ready) cam.rot = rot;
    else cam.rot = wrapAngle(cam.rot + wrapAngle(rot - cam.rot) * (1 - Math.exp(-dt * 3.5)));

    let lx, ly;
    if (m.rotate) {
      // Sit the car low on screen, looking along the (smoothed) camera heading.
      const heading = -Math.PI / 2 - cam.rot;
      const ahead = ((0.16 + 0.08 * speedK) * this.h) / (cam.ready ? cam.zoom : zoom);
      lx = target.x + Math.cos(heading) * ahead;
      ly = target.y + Math.sin(heading) * ahead;
    } else {
      lx = target.x + vx * m.lead;
      ly = target.y + vy * m.lead;
    }

    if (!cam.ready) {
      Object.assign(cam, { x: lx, y: ly, zoom, ready: true });
      return;
    }
    const k = 1 - Math.exp(-dt * (m.rotate ? 7 : 5));
    cam.x += (lx - cam.x) * k;
    cam.y += (ly - cam.y) * k;
    cam.zoom += (zoom - cam.zoom) * (1 - Math.exp(-dt * 3));
  }

  toScreen(x, y) {
    const { cam, w, h } = this;
    const dx = (x - cam.x) * cam.zoom, dy = (y - cam.y) * cam.zoom;
    const c = Math.cos(cam.rot), s = Math.sin(cam.rot);
    return [dx * c - dy * s + w / 2, dx * s + dy * c + h / 2];
  }

  addShake(amount) {
    this.shake = Math.min(14, this.shake + amount);
  }

  // ------------------------------------------------------------ effects

  // Called once per frame per car to lay skid marks and emit smoke/dust.
  effects(car, dt) {
    let st = this.fx.get(car.id);
    if (!st) this.fx.set(car.id, (st = { rear: null }));
    const c = Math.cos(car.a), s = Math.sin(car.a);
    const wheel = (lx, ly) => ({ x: car.x + c * lx - s * ly, y: car.y + s * lx + c * ly });
    const rear = [wheel(-12, -8), wheel(-12, 8)];
    const speed = Math.hypot(car.vx, car.vy);

    if (car.skid && st.rear && !car.offroad) {
      for (let k = 0; k < 2; k++) this.addSkid(st.rear[k].x, st.rear[k].y, rear[k].x, rear[k].y);
    }
    st.rear = rear;

    if (car.skid && speed > 120 && !car.offroad && Math.random() < dt * 40) {
      const w = rear[Math.random() < 0.5 ? 0 : 1];
      this.particle({ x: w.x, y: w.y, vx: car.vx * 0.1 + (Math.random() - 0.5) * 40, vy: car.vy * 0.1 + (Math.random() - 0.5) * 40, life: 0.9, size: 6, grow: 26, kind: 'smoke' });
    }
    if (car.offroad && speed > 90 && Math.random() < dt * 30) {
      const w = rear[Math.random() < 0.5 ? 0 : 1];
      this.particle({ x: w.x, y: w.y, vx: -car.vx * 0.15 + (Math.random() - 0.5) * 50, vy: -car.vy * 0.15 + (Math.random() - 0.5) * 50, life: 0.7, size: 5, grow: 18, kind: 'dust' });
    }
  }

  addSkid(x1, y1, x2, y2) {
    if ((x2 - x1) ** 2 + (y2 - y1) ** 2 > 900) return;     // teleport/respawn
    const o = this.skidHead * 4;
    this.skids[o] = x1; this.skids[o + 1] = y1; this.skids[o + 2] = x2; this.skids[o + 3] = y2;
    this.skidHead = (this.skidHead + 1) % MAX_SKIDS;
    this.skidCount = Math.min(MAX_SKIDS, this.skidCount + 1);
  }

  particle(p) {
    p.max = p.life;
    if (this.particles.length < MAX_PARTICLES) this.particles.push(p);
  }

  sparks(x, y, strength) {
    const n = Math.min(24, 4 + strength * 30);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = 80 + Math.random() * 260 * (0.5 + strength);
      this.particle({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.25 + Math.random() * 0.3, size: 2, grow: 0, kind: 'spark' });
    }
  }

  updateParticles(dt) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) { ps[i] = ps[ps.length - 1]; ps.pop(); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = p.kind === 'spark' ? 3 : 2;
      p.vx -= p.vx * drag * dt;
      p.vy -= p.vy * drag * dt;
      p.size += p.grow * dt;
    }
    this.shake *= Math.exp(-dt * 10);
  }

  // ------------------------------------------------------------ frame

  draw(cars, opts = {}) {
    const { ctx, cam, dpr, w, h, track } = this;
    if (!track) return;
    const z = cam.zoom;
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(w / 2 + sx, h / 2 + sy);
    ctx.rotate(cam.rot);
    ctx.scale(z, z);
    ctx.translate(-cam.x, -cam.y);
    // Visible world area; a square around the screen's diagonal also covers
    // every rotation of the chase camera.
    const diag = Math.hypot(w, h) / 2 / z + 60;
    const rx = cam.rot ? diag : w / 2 / z + 60, ry = cam.rot ? diag : h / 2 / z + 60;
    const view = { x0: cam.x - rx, y0: cam.y - ry, x1: cam.x + rx, y1: cam.y + ry };

    // grass
    ctx.fillStyle = this.grass;
    ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';

    // run-off area & barriers
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = WALL * 2;
    ctx.stroke(this.center);
    for (const wall of this.walls) {
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 14;
      ctx.stroke(wall);
      ctx.strokeStyle = '#f2f2f2';
      ctx.lineWidth = 9;
      ctx.stroke(wall);
      ctx.setLineDash([22, 22]);
      ctx.strokeStyle = '#d8323f';
      ctx.stroke(wall);
      ctx.setLineDash([]);
    }

    // curbs, then the road on top
    ctx.lineWidth = ROAD_HALF * 2 + 22;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.stroke(this.center);
    for (const c of this.curbs) {
      ctx.lineWidth = 14;
      ctx.strokeStyle = '#e03a3a';
      ctx.stroke(c);
      ctx.setLineDash([16, 16]);
      ctx.strokeStyle = '#f5f5f5';
      ctx.stroke(c);
      ctx.setLineDash([]);
    }
    ctx.lineWidth = ROAD_HALF * 2;
    ctx.strokeStyle = this.asphalt;
    ctx.stroke(this.center);

    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 3;
    for (const e of this.edges) ctx.stroke(e);
    ctx.setLineDash([36, 44]);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.stroke(this.center);
    ctx.setLineDash([]);

    this.drawGrid(ctx);
    this.drawStartLine(ctx);

    // skid marks
    if (this.skidCount) {
      ctx.strokeStyle = 'rgba(16,16,18,0.34)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const s = this.skids;
      for (let i = 0; i < this.skidCount; i++) {
        const o = i * 4;
        ctx.moveTo(s[o], s[o + 1]);
        ctx.lineTo(s[o + 2], s[o + 3]);
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    if (opts.capsules) this.drawCapsules(ctx, opts.capsules, opts.now || 0, view);

    // dust & smoke under the cars, sparks above
    this.drawParticles(ctx, false);
    for (const car of cars) drawCar(ctx, car, opts.now || 0);
    this.drawParticles(ctx, true);

    // trees
    for (const t of this.trees) {
      if (t.x < view.x0 - 50 || t.x > view.x1 + 50 || t.y < view.y0 - 50 || t.y > view.y1 + 50) continue;
      const spr = this.treeSprites[t.v];
      ctx.drawImage(spr, t.x - spr.width / 4, t.y - spr.height / 4, spr.width / 2, spr.height / 2);
    }

    // name tags in screen space
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '700 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const car of cars) {
      if (car.me && !opts.showMe) continue;
      const [x, cy] = this.toScreen(car.x, car.y);
      const y = cy - 34 * z - 8;
      if (x < -100 || x > w + 100 || y < -40 || y > h + 40) continue;
      const label = car.me ? 'YOU' : car.name;
      const tw = ctx.measureText(label).width + 16;
      ctx.fillStyle = 'rgba(10,12,20,0.7)';
      roundRect(ctx, x - tw / 2, y - 10, tw, 20, 10);
      ctx.fill();
      ctx.fillStyle = car.color;
      ctx.fillRect(x - tw / 2 + 8, y + 6, tw - 16, 2);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x, y);
    }
  }

  drawCapsules(ctx, capsules, now, view) {
    const t = now / 1000;
    for (const c of capsules) {
      if (!c.on || c.hiddenUntil > now) continue;
      if (c.x < view.x0 || c.x > view.x1 || c.y < view.y0 || c.y > view.y1) continue;
      const pulse = 1 + Math.sin(t * 5 + c.id) * 0.08;

      ctx.globalCompositeOperation = 'lighter';
      const glow = ctx.createRadialGradient(c.x, c.y, 2, c.x, c.y, 36 * pulse);
      glow.addColorStop(0, 'rgba(255,215,90,0.6)');
      glow.addColorStop(1, 'rgba(255,110,20,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 36 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';

      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(t * 1.8 + c.id);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      roundRect(ctx, -10, -3, 26, 14, 7);
      ctx.fill();
      ctx.save();
      roundRect(ctx, -13, -7, 26, 14, 7);
      ctx.clip();
      ctx.fillStyle = '#ff6a1a';
      ctx.fillRect(-13, -7, 13, 14);
      ctx.fillStyle = '#ffd23d';
      ctx.fillRect(0, -7, 13, 14);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(-11, -5, 22, 2.5);
      ctx.restore();
      ctx.strokeStyle = 'rgba(90,35,0,0.7)';
      ctx.lineWidth = 1.2;
      roundRect(ctx, -13, -7, 26, 14, 7);
      ctx.stroke();
      // lightning bolt
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(1.5, -6);
      ctx.lineTo(-3, 1);
      ctx.lineTo(0, 1);
      ctx.lineTo(-1.5, 6);
      ctx.lineTo(3, -1);
      ctx.lineTo(0, -1);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // Golden flash when a capsule is collected.
  burst(x, y) {
    this.particle({ x, y, vx: 0, vy: 0, life: 0.45, size: 12, grow: 120, kind: 'ring' });
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2, v = 120 + Math.random() * 220;
      this.particle({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.3 + Math.random() * 0.3, size: 2, grow: 0, kind: 'spark' });
    }
  }

  drawParticles(ctx, top) {
    for (const p of this.particles) {
      const isTop = p.kind === 'spark' || p.kind === 'ring';
      if (isTop !== top) continue;
      const a = p.life / p.max;
      if (p.kind === 'ring') {
        ctx.strokeStyle = `rgba(255,200,70,${a * 0.9})`;
        ctx.lineWidth = 4 * a + 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'spark') {
        ctx.strokeStyle = `rgba(255,${180 + Math.random() * 60 | 0},80,${a})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.kind === 'smoke' ? `rgba(225,225,230,${a * 0.35})` : `rgba(120,95,60,${a * 0.4})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawStartLine(ctx) {
    const t = this.track;
    ctx.save();
    ctx.translate(t.xs[0], t.ys[0]);
    ctx.rotate(t.ang[0]);
    const sq = 10;
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < (ROAD_HALF * 2) / sq; k++) {
        ctx.fillStyle = (row + k) % 2 ? '#111' : '#f4f4f4';
        ctx.fillRect(-15 + row * sq, -ROAD_HALF + k * sq, sq, sq);
      }
    }
    ctx.restore();
  }

  drawGrid(ctx) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2.5;
    for (const g of this.gridSlots) {
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(g.a);
      ctx.beginPath();
      ctx.moveTo(14, -15);
      ctx.lineTo(26, -15);
      ctx.lineTo(26, 15);
      ctx.lineTo(14, 15);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ------------------------------------------------------------ minimap

  buildMinimap() {
    const t = this.track, size = this.mini.width;
    const b = t.bounds;
    const pad = 0.12 * size;
    const s = Math.min((size - pad * 2) / (b.maxX - b.minX - 2 * (WALL + 260) + 1), (size - pad * 2) / (b.maxY - b.minY - 2 * (WALL + 260) + 1));
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    this.mm = { s, ox: size / 2 - cx * s, oy: size / 2 - cy * s };
    const p = new Path2D();
    for (let i = 0; i < t.n; i += 3) {
      const x = t.xs[i] * s + this.mm.ox, y = t.ys[i] * s + this.mm.oy;
      i ? p.lineTo(x, y) : p.moveTo(x, y);
    }
    p.closePath();
    this.mmPath = p;
  }

  drawMinimap(cars, capsules = []) {
    const { mctx: c, mm, dpr } = this;
    if (!mm) return;
    const size = this.mini.width;
    c.clearRect(0, 0, size, size);
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = 9 * dpr;
    c.stroke(this.mmPath);
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = 2 * dpr;
    c.stroke(this.mmPath);
    const t = this.track;
    c.fillStyle = '#fff';
    c.fillRect(t.xs[0] * mm.s + mm.ox - 2 * dpr, t.ys[0] * mm.s + mm.oy - 6 * dpr, 4 * dpr, 12 * dpr);
    c.fillStyle = '#ffc53d';
    for (const cap of capsules) {
      if (!cap.on) continue;
      c.beginPath();
      c.arc(cap.x * mm.s + mm.ox, cap.y * mm.s + mm.oy, 2 * dpr, 0, Math.PI * 2);
      c.fill();
    }
    const sorted = [...cars].sort((a, b) => (a.me ? 1 : 0) - (b.me ? 1 : 0));
    for (const car of sorted) {
      const x = car.x * mm.s + mm.ox, y = car.y * mm.s + mm.oy;
      c.beginPath();
      c.arc(x, y, (car.me ? 6 : 4.5) * dpr, 0, Math.PI * 2);
      c.fillStyle = car.color;
      c.fill();
      c.lineWidth = (car.me ? 2.5 : 1.5) * dpr;
      c.strokeStyle = car.me ? '#fff' : 'rgba(0,0,0,0.6)';
      c.stroke();
    }
  }
}

// -------------------------------------------------------------- helpers

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const shadeCache = new Map();
function shades(hex) {
  if (!shadeCache.has(hex)) {
    const n = parseInt(hex.slice(1), 16);
    const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const mix = (k, t) => `rgb(${Math.round(r + (t - r) * k)},${Math.round(g + (t - g) * k)},${Math.round(b + (t - b) * k)})`;
    shadeCache.set(hex, { light: mix(0.35, 255), dark: mix(0.4, 0), darker: mix(0.6, 0) });
  }
  return shadeCache.get(hex);
}

export function drawCar(ctx, car, now) {
  const sh = shades(car.color);
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.a);

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, -18, -7, 40, 20, 6);
  ctx.fill();

  if (car.boosting) {
    ctx.globalCompositeOperation = 'lighter';
    for (const y of [-5, 5]) {
      const len = 24 + Math.random() * 22;
      const g = ctx.createLinearGradient(-20, 0, -20 - len, 0);
      g.addColorStop(0, 'rgba(255,250,210,0.95)');
      g.addColorStop(0.3, 'rgba(255,170,40,0.85)');
      g.addColorStop(1, 'rgba(255,50,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-19, y - 5);
      ctx.lineTo(-20 - len, y);
      ctx.lineTo(-19, y + 5);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // wheels
  ctx.fillStyle = '#121212';
  ctx.fillRect(-17, -11, 10, 4.5);
  ctx.fillRect(-17, 6.5, 10, 4.5);
  for (const y of [-8.75, 8.75]) {
    ctx.save();
    ctx.translate(11, y);
    ctx.rotate((car.steer || 0) * 0.45);
    ctx.fillRect(-5, -2.25, 10, 4.5);
    ctx.restore();
  }

  // body
  const g = ctx.createLinearGradient(0, -10, 0, 10);
  g.addColorStop(0, sh.light);
  g.addColorStop(0.45, car.color);
  g.addColorStop(1, sh.dark);
  ctx.fillStyle = g;
  roundRect(ctx, -20, -9.5, 40, 19, 6);
  ctx.fill();
  ctx.strokeStyle = sh.darker;
  ctx.lineWidth = 1;
  ctx.stroke();

  // racing stripes
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(-19, -3, 38, 1.8);
  ctx.fillRect(-19, 1.2, 38, 1.8);

  // cockpit + windshield
  ctx.fillStyle = '#151b2a';
  roundRect(ctx, -8, -7, 16, 14, 3.5);
  ctx.fill();
  ctx.fillStyle = 'rgba(150,200,255,0.45)';
  roundRect(ctx, 3, -6, 4, 12, 1.5);
  ctx.fill();

  // spoiler and lights
  ctx.fillStyle = sh.darker;
  ctx.fillRect(-21.5, -10, 4, 20);
  ctx.fillStyle = '#fff6c8';
  ctx.fillRect(18, -8, 2.2, 4);
  ctx.fillRect(18, 4, 2.2, 4);
  ctx.fillStyle = car.braking ? '#ff2a2a' : '#7a1515';
  ctx.fillRect(-20, -8, 1.8, 4);
  ctx.fillRect(-20, 4, 1.8, 4);
  if (car.braking) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,40,40,0.35)';
    ctx.beginPath();
    ctx.arc(-21, -6, 5, 0, Math.PI * 2);
    ctx.arc(-21, 6, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();

  if (car.me && now) {
    // soft pulsing ring so you can spot yourself on the grid
    const pulse = car.highlight || 0;
    if (pulse > 0) {
      ctx.strokeStyle = `rgba(255,255,255,${pulse * 0.8})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(car.x, car.y, 30 + Math.sin(now / 150) * 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function buildCurbs(track) {
  // Curbs only on corners: runs of samples with a tight radius.
  const { n, radius, xs, ys, nx, ny } = track;
  const isCorner = (i) => radius[(i + n) % n] < 700;
  let start = 0;
  while (start < n && isCorner(start)) start++;
  const paths = [];
  let run = null;
  for (let k = 0; k <= n; k++) {
    const i = (start + k) % n;
    if (isCorner(i) && k < n) {
      if (!run) run = [];
      run.push(i);
    } else if (run) {
      if (run.length > 4) {
        // extend a little before/after the corner
        const ext = 6;
        const ids = [];
        for (let e = ext; e > 0; e--) ids.push((run[0] - e + n) % n);
        ids.push(...run);
        for (let e = 1; e <= ext; e++) ids.push((run[run.length - 1] + e) % n);
        for (const side of [-1, 1]) {
          const p = new Path2D();
          ids.forEach((j, q) => {
            const d = side * (ROAD_HALF + 5);
            q ? p.lineTo(xs[j] + nx[j] * d, ys[j] + ny[j] * d) : p.moveTo(xs[j] + nx[j] * d, ys[j] + ny[j] * d);
          });
          paths.push(p);
        }
      }
      run = null;
    }
  }
  return paths;
}

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function placeTrees(track) {
  const rand = rng(track.n * 7919);
  const trees = [];
  const b = track.bounds;
  const cell = 120;
  const minD2 = (WALL + 55) ** 2;
  for (let y = b.minY; y < b.maxY; y += cell) {
    for (let x = b.minX; x < b.maxX; x += cell) {
      if (rand() < 0.45) continue;
      const tx = x + rand() * cell, ty = y + rand() * cell;
      let ok = true;
      for (let i = 0; i < track.n; i += 2) {
        const dx = tx - track.xs[i], dy = ty - track.ys[i];
        if (dx * dx + dy * dy < minD2) { ok = false; break; }
      }
      if (ok) trees.push({ x: tx, y: ty, v: Math.floor(rand() * 3) });
    }
  }
  return trees;
}

function treeSprite(r, theme) {
  // Rendered at 2x for crispness; drawn at half size.
  const pad = 14;
  const size = (r + pad) * 2 * 2;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(2, 2);
  const m = r + pad;
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.beginPath();
  g.arc(m + 7, m + 9, r, 0, Math.PI * 2);
  g.fill();
  const blobs = [[0, 0, 1], [-0.35, -0.2, 0.62], [0.35, -0.25, 0.6], [0.1, 0.35, 0.6]];
  for (const [bx, by, br] of blobs) {
    const x = m + bx * r, y = m + by * r, rr = r * br;
    const grad = g.createRadialGradient(x - rr * 0.35, y - rr * 0.35, rr * 0.1, x, y, rr);
    grad.addColorStop(0, lighten(theme.tree, 0.25));
    grad.addColorStop(0.7, theme.tree);
    grad.addColorStop(1, theme.treeDark);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, rr, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

function lighten(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v + (255 - v) * k);
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function makeGrass(ctx, theme) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = theme.grass;
  g.fillRect(0, 0, 256, 256);
  const rand = rng(42);
  for (let i = 0; i < 1600; i++) {
    g.fillStyle = rand() < 0.6 ? theme.grassDark : lighten(theme.grass, 0.12);
    g.globalAlpha = 0.25 + rand() * 0.4;
    g.fillRect(rand() * 256, rand() * 256, 1.5 + rand() * 2.5, 1.5 + rand() * 2.5);
  }
  return ctx.createPattern(c, 'repeat');
}

function makeAsphalt(ctx) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#3b3f47';
  g.fillRect(0, 0, 128, 128);
  const rand = rng(7);
  for (let i = 0; i < 900; i++) {
    const v = rand() < 0.5 ? 30 + rand() * 25 : 80 + rand() * 40;
    g.fillStyle = `rgba(${v},${v},${v + 4},${0.35 + rand() * 0.3})`;
    g.fillRect(rand() * 128, rand() * 128, 1 + rand() * 1.5, 1 + rand() * 1.5);
  }
  return ctx.createPattern(c, 'repeat');
}
