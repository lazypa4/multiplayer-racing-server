// Turbo Rivals game server: serves the client files and runs rooms, races,
// lap counting and bots over WebSockets.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { getTrack, gridSlot, advance, TRACK_LIST, DEFAULT_TRACK } from './shared/tracks.js';
import { createCar, stepCar, collideCars, STEP, TUNING } from './shared/physics.js';
import { createCapsules, capsuleSpot, touchesCapsule, CAPSULE_RESPAWN_MS } from './shared/turbo.js';
import { createBrain, botInput, botName } from './bot.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 3000;
const FINISH_GRACE_MS = 30000;     // after the first car finishes
const ALL_HUMANS_DONE_MS = 8000;   // once every human has finished
const SNAPSHOT_MS = 50;
const COLORS = ['#ff4d4d', '#3d8bff', '#ffd23d', '#3ddc84', '#b46bff', '#ff8a3d', '#3de0e0', '#ff5fb4'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (pathname === '/health') {
    // Lets a separately hosted page (e.g. on Netlify) check the server is awake.
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }
  let base = path.join(ROOT, 'public');
  if (pathname === '/') pathname = '/index.html';
  if (pathname.startsWith('/shared/')) {
    base = path.join(ROOT, 'shared');
    pathname = pathname.slice('/shared'.length);
  }
  const file = path.normalize(path.join(base, pathname));
  if (!file.startsWith(base + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- rooms

const rooms = new Map();
let nextId = 1;

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { code, players: new Map(), hostId: null, state: 'lobby', track: DEFAULT_TRACK, laps: 3, race: null });
  }
  return rooms.get(code);
}

const humans = (room) => [...room.players.values()].filter((p) => !p.brain);
const racers = (room) => [...room.players.values()].filter((p) => p.racing);

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except = null) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p !== except && p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(data);
  }
}

function lobbyState(room) {
  return {
    t: 'lobby',
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    track: room.track,
    laps: room.laps,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, bot: !!p.brain, racing: p.racing })),
  };
}

function freeColor(room, wanted) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  if (wanted && !used.has(wanted)) return wanted;
  return COLORS.find((c) => !used.has(c)) || COLORS[0];
}

function cleanName(name) {
  const s = String(name ?? '').replace(/[^\p{L}\p{N} _\-.!?]/gu, '').trim().slice(0, 16);
  return s || 'Racer';
}

function addPlayer(room, player) {
  player.color = freeColor(room, player.color);
  room.players.set(player.id, player);
  if (!room.hostId) room.hostId = player.id;
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  room.players.delete(id);
  if (room.hostId === id) room.hostId = humans(room)[0]?.id ?? null;
  if (!humans(room).length) {
    rooms.delete(room.code);
    return;
  }
  if (!p.brain) broadcast(room, { t: 'toast', msg: `${p.name} left` });
  broadcast(room, lobbyState(room));
}

// ---------------------------------------------------------------- races

function raceInfo(room, now) {
  return {
    t: 'race',
    track: room.race.track.id,
    laps: room.laps,
    countdown: Math.max(0, room.race.goAt - now),
    racers: racers(room).sort((a, b) => b.car.prog - a.car.prog).map((p) => ({ id: p.id, name: p.name, color: p.color, bot: !!p.brain, x: p.car.x, y: p.car.y, a: p.car.a })),
    capsules: room.race.capsules.map(({ id, x, y, on }) => ({ id, x, y, on })),
  };
}

// Hand out any turbo capsules a car drove over between two positions.
function grabCapsules(room, p, x0, y0, x1, y1, now) {
  for (const cap of room.race.capsules) {
    if (p.car.turbo >= TUNING.turboStock) return;
    if (!cap.on || !touchesCapsule(cap, x0, y0, x1, y1)) continue;
    cap.on = false;
    cap.respawnAt = now + CAPSULE_RESPAWN_MS;
    p.car.turbo++;
    broadcast(room, { t: 'cap', id: cap.id, on: false, by: p.id });
  }
}

function respawnCapsules(room, now) {
  for (const cap of room.race.capsules) {
    if (cap.on || now < cap.respawnAt) continue;
    Object.assign(cap, capsuleSpot(room.race.track, cap.slot, cap.count), { on: true });
    broadcast(room, { t: 'cap', id: cap.id, on: true, x: cap.x, y: cap.y });
  }
}

function startRace(room) {
  const track = getTrack(room.track);
  const now = Date.now();
  const grid = [...room.players.values()];
  for (let i = grid.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [grid[i], grid[j]] = [grid[j], grid[i]];
  }
  grid.forEach((p, i) => {
    const g = gridSlot(track, i);
    p.car = createCar(g.x, g.y, g.a, g.idx, g.prog);
    p.racing = true;
    p.lapsDone = 0;
    p.lapStart = 0;
    p.bestLap = null;
    p.place = 0;
    p.finishTime = null;
    if (p.brain) p.brain = createBrain();
  });
  room.state = 'countdown';
  room.race = { track, capsules: createCapsules(track), goAt: now + COUNTDOWN_MS, firstFinishAt: 0, lastFinishAt: 0, humansDoneAt: 0, places: 0, lastTick: now, acc: 0, lastSnap: 0 };
  broadcast(room, raceInfo(room, now));
  broadcast(room, lobbyState(room));
}

function checkLap(room, p, now) {
  const { track } = room.race;
  const laps = Math.floor(p.car.prog / track.n);
  if (laps <= p.lapsDone) return;
  p.lapsDone = laps;
  const lapTime = now - p.lapStart;
  p.lapStart = now;
  p.bestLap = p.bestLap === null ? lapTime : Math.min(p.bestLap, lapTime);
  send(p.ws, { t: 'lap', lap: laps, time: lapTime, best: p.bestLap });
  if (laps >= room.laps && !p.place) {
    p.place = ++room.race.places;
    p.finishTime = now - room.race.goAt;
    room.race.firstFinishAt ||= now;
    room.race.lastFinishAt = now;
    broadcast(room, { t: 'finish', id: p.id, name: p.name, place: p.place, time: p.finishTime });
  }
}

function standings(room) {
  return racers(room).sort((a, b) => {
    if (a.place && b.place) return a.place - b.place;
    if (a.place || b.place) return a.place ? -1 : 1;
    return b.car.prog - a.car.prog;
  });
}

function endRace(room) {
  const results = standings(room).map((p, i) => ({
    pos: i + 1, id: p.id, name: p.name, color: p.color, bot: !!p.brain, time: p.finishTime, best: p.bestLap,
  }));
  for (const p of room.players.values()) {
    p.racing = false;
    p.car = null;
  }
  room.state = 'lobby';
  room.race = null;
  broadcast(room, { t: 'results', results, track: room.track, laps: room.laps });
  broadcast(room, lobbyState(room));
}

function snapshot(room, now) {
  return {
    t: 'snap',
    ts: now,
    el: now - room.race.goAt,
    cars: racers(room).map((p) => {
      const c = p.car;
      // Players report ~30x/s but snapshots go out 20x/s; project each human
      // car to "now" so remote cars move evenly instead of stuttering.
      const ahead = p.brain || !c.recvAt ? 0 : Math.min(0.1, (now - c.recvAt) / 1000);
      return {
        i: p.id,
        x: Math.round((c.x + c.vx * ahead) * 10) / 10,
        y: Math.round((c.y + c.vy * ahead) * 10) / 10,
        a: Math.round(c.a * 1000) / 1000,
        vx: Math.round(c.vx),
        vy: Math.round(c.vy),
        s: Math.round(c.steer * 100) / 100,
        f: (c.boosting ? 1 : 0) | (c.drifting ? 2 : 0) | (c.offroad ? 4 : 0),
        p: Math.round(c.prog),
        l: p.lapsDone,
        fin: p.place,
      };
    }),
  };
}

function tickRoom(room, now) {
  const race = room.race;
  if (room.state === 'countdown' && now >= race.goAt) {
    room.state = 'racing';
    for (const p of racers(room)) p.lapStart = race.goAt;
    broadcast(room, { t: 'go' });
  }
  if (room.state !== 'racing') return;

  // Simulate bots with the same fixed step the browsers use.
  race.acc += Math.min(0.1, (now - race.lastTick) / 1000);
  race.lastTick = now;
  const all = racers(room);
  const bots = all.filter((p) => p.brain);
  while (race.acc >= STEP) {
    race.acc -= STEP;
    for (const b of bots) {
      const others = all.filter((o) => o !== b).map((o) => o.car);
      const input = botInput(b.car, b.brain, race.track, others, STEP, race.capsules);
      const x0 = b.car.x, y0 = b.car.y;
      stepCar(b.car, input, STEP, race.track, b.place ? 0.55 : 1);
      grabCapsules(room, b, x0, y0, b.car.x, b.car.y, now);
    }
    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) collideCars(bots[i].car, bots[j].car);
      for (const h of all) if (!h.brain) collideCars(bots[i].car, h.car, true);
    }
  }
  for (const b of bots) checkLap(room, b, now);
  respawnCapsules(room, now);

  if (now - race.lastSnap >= SNAPSHOT_MS) {
    race.lastSnap = now;
    broadcast(room, snapshot(room, now));
  }

  const people = all.filter((p) => !p.brain);
  if (!people.length) return endRace(room);
  if (people.every((p) => p.place)) race.humansDoneAt ||= now;
  if (all.every((p) => p.place) && now - race.lastFinishAt > 2000) return endRace(room);
  if (race.firstFinishAt && now - race.firstFinishAt > FINISH_GRACE_MS) return endRace(room);
  if (race.humansDoneAt && now - race.humansDoneAt > ALL_HUMANS_DONE_MS) return endRace(room);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) if (room.race) tickRoom(room, now);
}, 1000 / 60);

// ---------------------------------------------------------------- sockets

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let player = null;
  let room = null;

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (player) return;
      const code = String(m.room || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (code && code.length !== 4) return send(ws, { t: 'error', msg: 'Room codes are 4 letters.' });
      if (code && !rooms.has(code)) return send(ws, { t: 'error', msg: `Room ${code} doesn't exist. Check the code or create a new room.` });
      room = getRoom(code || newCode());
      if (room.players.size >= MAX_PLAYERS) {
        // Make space by dropping a bot if there is one.
        const bot = [...room.players.values()].reverse().find((p) => p.brain && !p.racing);
        if (!bot) {
          room = null;
          return send(ws, { t: 'error', msg: 'That room is full (8 racers).' });
        }
        room.players.delete(bot.id);
      }
      player = { id: nextId++, ws, name: cleanName(m.name), color: COLORS.includes(m.color) ? m.color : null, brain: null, racing: false, car: null };
      addPlayer(room, player);
      send(ws, { t: 'welcome', id: player.id, code: room.code, tracks: TRACK_LIST, urls: lanUrls() });
      broadcast(room, { t: 'toast', msg: `${player.name} joined` }, player);
      broadcast(room, lobbyState(room));
      if (room.race) {
        const now = Date.now();
        send(ws, raceInfo(room, now));
        if (room.state === 'racing') send(ws, { t: 'go', late: true });
      }
      return;
    }

    if (!player || !room) return;
    const isHost = room.hostId === player.id;

    switch (m.t) {
      case 's': {
        // Position update for the player's own car.
        if (room.state !== 'racing' || !player.racing) return;
        const nums = [m.x, m.y, m.a, m.vx, m.vy, m.s];
        if (!nums.every(Number.isFinite)) return;
        const c = player.car;
        const now = Date.now();
        // A jump (e.g. pressing R to reset) only counts where the car lands.
        const jumped = Math.hypot(m.x - c.x, m.y - c.y) > 150;
        const x0 = jumped ? m.x : c.x, y0 = jumped ? m.y : c.y;
        Object.assign(c, { x: m.x, y: m.y, a: m.a, vx: m.vx, vy: m.vy, steer: m.s, recvAt: now });
        if (Number.isInteger(m.n)) c.turbo = Math.max(0, Math.min(TUNING.turboStock, m.n));
        c.boosting = !!(m.f & 1);
        c.drifting = !!(m.f & 2);
        c.offroad = !!(m.f & 4);
        advance(c, room.race.track);
        grabCapsules(room, player, x0, y0, c.x, c.y, now);
        checkLap(room, player, now);
        break;
      }
      case 'config': {
        if (!isHost || room.state !== 'lobby') return;
        if (TRACK_LIST.some((t) => t.id === m.track)) room.track = m.track;
        if (Number.isInteger(m.laps)) room.laps = Math.max(1, Math.min(10, m.laps));
        broadcast(room, lobbyState(room));
        break;
      }
      case 'addBot': {
        if (!isHost || room.state !== 'lobby' || room.players.size >= MAX_PLAYERS) return;
        const taken = new Set([...room.players.values()].map((p) => p.name));
        addPlayer(room, { id: nextId++, ws: null, name: botName(taken), color: null, brain: createBrain(), racing: false, car: null });
        broadcast(room, lobbyState(room));
        break;
      }
      case 'removeBot': {
        if (!isHost || room.state !== 'lobby') return;
        const bot = [...room.players.values()].reverse().find((p) => p.brain);
        if (bot) room.players.delete(bot.id);
        broadcast(room, lobbyState(room));
        break;
      }
      case 'color': {
        if (room.state !== 'lobby' || !COLORS.includes(m.color)) return;
        if ([...room.players.values()].some((p) => p !== player && p.color === m.color)) return;
        player.color = m.color;
        broadcast(room, lobbyState(room));
        break;
      }
      case 'start': {
        if (isHost && room.state === 'lobby') startRace(room);
        break;
      }
      case 'ping': {
        send(ws, { t: 'pong', c: m.c, ts: Date.now() });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (player && room) removePlayer(room, player.id);
    player = null;
    room = null;
  });
});

// Drop connections that stopped answering.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

server.listen(PORT, () => {
  console.log(`\n  🏁 Turbo Rivals is running!\n`);
  console.log(`  On this computer:   http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  On your network:    ${u}`);
  console.log(`\n  Share the network link with friends on the same Wi-Fi to race together.\n`);
});
