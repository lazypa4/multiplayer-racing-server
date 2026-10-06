// Turbo Rivals browser client: menus, lobby, networking and the race loop.
//
// Netcode in short: each browser simulates its own car (so steering has no
// lag) and streams its position to the server ~30 times a second. The server
// counts laps, runs the bots and broadcasts snapshots of every car ~20 times
// a second. Other cars are drawn 100 ms in the past, smoothly interpolated
// between snapshots.

import { getTrack, respawnPoint, advance, TRACK_LIST } from '/shared/tracks.js';
import { createCar, stepCar, collideCars, STEP, NO_INPUT, TUNING } from '/shared/physics.js';
import { touchesCapsule } from '/shared/turbo.js';
import { Renderer, CAMERA_MODES, ZOOM_MIN, ZOOM_MAX } from './render.js';
import { Sound } from './audio.js';
import { Input } from './input.js';

const COLORS = ['#ff4d4d', '#3d8bff', '#ffd23d', '#3ddc84', '#b46bff', '#ff8a3d', '#3de0e0', '#ff5fb4'];
const INTERP_MS = 100;
const SEND_MS = 33;

const $ = (id) => document.getElementById(id);
const sound = new Sound();
const input = new Input();
const renderer = new Renderer($('game'), $('minimap'));

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const app = {
  ws: null,
  id: null,
  code: null,
  lobby: null,
  tracks: TRACK_LIST,
  urls: [],
  name: store.get('tr-name', ''),
  color: store.get('tr-color', COLORS[Math.floor(Math.random() * COLORS.length)]),
  race: null,
  showingResults: false,
  clock: { offset: null, samples: [], rtt: 0 },
};

// ============================================================== helpers

const fmt = (ms) => {
  if (ms == null) return '—';
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), x = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
};
const suffix = (n) => (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const ordinal = (n) => n + suffix(n);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const wrapAngle = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

function setText(el, v) {
  if (el._v !== v) {
    el._v = v;
    el.textContent = v;
  }
}

function show(screen) {
  for (const id of ['menu', 'lobby', 'hud']) $(id).classList.toggle('active', id === screen);
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => (el.style.opacity = '0'), 2600);
  setTimeout(() => el.remove(), 3100);
}

let bannerTimer = null;
let bannerKind = null;
function banner(text, { cls = '', ms = 1200, kind = 'msg' } = {}) {
  const el = $('banner');
  el.textContent = text;
  el.className = `banner show pop ${cls}`;
  void el.offsetWidth;          // restart the pop animation
  bannerKind = kind;
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(hideBanner, ms);
}
function hideBanner() {
  $('banner').classList.remove('show', 'pop');
  bannerKind = null;
}
let subTimer = null;
function subBanner(text, ms = 2500) {
  const el = $('sub-banner');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(subTimer);
  if (ms) subTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function send(msg) {
  if (app.ws && app.ws.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(msg));
}

function drawSwatches(container, selected, taken, onPick) {
  container.innerHTML = '';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === selected ? ' selected' : '') + (taken.has(c) ? ' taken' : '');
    b.style.background = c;
    b.setAttribute('aria-label', `Color ${c}`);
    b.disabled = taken.has(c);
    b.onclick = () => onPick(c);
    container.append(b);
  }
}

// ============================================================== menu

$('name').value = app.name;
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase().slice(0, 4);

function drawMenuColors() {
  drawSwatches($('menu-colors'), app.color, new Set(), (c) => {
    app.color = c;
    store.set('tr-color', c);
    drawMenuColors();
  });
}
drawMenuColors();

// Where the game server lives. By default it's the site that served this
// page; config.js can point a static site (e.g. Netlify) at a separate server.
function gameServer() {
  const configured = String(window.TURBO_RIVALS_SERVER || '').trim().replace(/\/+$/, '');
  if (!configured) {
    return { ws: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`, http: null };
  }
  if (configured.includes('YOUR-')) {
    throw new Error('The game server address is not set yet. Put your server URL in config.js.');
  }
  const url = new URL(configured.includes('://') ? configured : `https://${configured}`);
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  return { ws: `${secure ? 'wss' : 'ws'}://${url.host}`, http: `${secure ? 'https' : 'http'}://${url.host}` };
}

// Free hosting plans put idle servers to sleep. Ping the server until it
// answers so the first player isn't met with a confusing error.
async function wakeServer(http) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const res = await fetch(`${http}/health`, { cache: 'no-store', signal: abort.signal });
      if (res.ok) return;
    } catch {
      // still asleep or unreachable; try again
    } finally {
      clearTimeout(timer);
    }
    const waited = Math.round((Date.now() - started) / 1000);
    $('menu-status').textContent = `Waking up the game server… ${waited}s (free servers can take up to a minute)`;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('The game server is not responding. Check the address in config.js and that the server is running.');
}

async function connect() {
  if (app.ws && app.ws.readyState <= WebSocket.OPEN) {
    return new Promise((resolve) => {
      if (app.ws.readyState === WebSocket.OPEN) resolve();
      else app.ws.addEventListener('open', resolve, { once: true });
    });
  }
  const server = gameServer();
  if (server.http) {
    $('menu-status').textContent = 'Connecting to the game server…';
    await wakeServer(server.http);
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(server.ws);
    app.ws = ws;
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Could not reach the game server.'));
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      if (app.id) $('disconnected').classList.add('active');
      app.ws = null;
    };
  });
}

async function join(room) {
  const name = $('name').value.trim() || 'Racer';
  app.name = name;
  store.set('tr-name', name);
  $('menu-error').textContent = '';
  sound.init();
  $('create').disabled = $('join').disabled = true;
  try {
    await connect();
    send({ t: 'join', name, color: app.color, room });
  } catch (err) {
    $('menu-error').textContent = err.message;
  } finally {
    $('menu-status').textContent = '';
    $('create').disabled = $('join').disabled = false;
  }
}

// Start waking a sleeping server as soon as the menu loads.
try {
  const { http } = gameServer();
  if (http) fetch(`${http}/health`, { cache: 'no-store' }).catch(() => {});
} catch {}

$('create').onclick = () => join('');
$('join').onclick = () => {
  const code = $('code').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) {
    $('menu-error').textContent = 'Enter the 4-letter room code your friend shared.';
    return;
  }
  join(code);
};
$('code').addEventListener('keydown', (e) => e.key === 'Enter' && $('join').click());
$('name').addEventListener('keydown', (e) => e.key === 'Enter' && ($('code').value.trim() ? $('join') : $('create')).click());

// ============================================================== lobby

$('add-bot').onclick = () => send({ t: 'addBot' });
$('remove-bot').onclick = () => send({ t: 'removeBot' });
$('laps-down').onclick = () => app.lobby && send({ t: 'config', track: app.lobby.track, laps: app.lobby.laps - 1 });
$('laps-up').onclick = () => app.lobby && send({ t: 'config', track: app.lobby.track, laps: app.lobby.laps + 1 });
$('start').onclick = () => send({ t: 'start' });
$('leave').onclick = () => {
  app.id = null;
  app.ws?.close();
  location.href = location.pathname;
};
$('copy-invite').onclick = async () => {
  const el = $('invite-url');
  try {
    await navigator.clipboard.writeText(el.value);
  } catch {
    el.select();
    document.execCommand('copy');
  }
  toast('Invite link copied');
};

function inviteUrl() {
  // Friends open the same website this page came from. Only when the game
  // server itself serves the page on localhost do we swap in its network
  // address, since "localhost" means nothing on a friend's device.
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  const servedByGameServer = !String(window.TURBO_RIVALS_SERVER || '').trim();
  const base = local && servedByGameServer && app.urls.length ? app.urls[0] : location.origin;
  return `${base}/?room=${app.code}`;
}

function buildTrackCards() {
  const wrap = $('tracks');
  if (wrap.childElementCount) return;
  for (const { id, name } of app.tracks) {
    const btn = document.createElement('button');
    btn.className = 'track-card';
    btn.dataset.track = id;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 160;
    drawTrackPreview(cv, getTrack(id));
    btn.append(cv, name);
    btn.onclick = () => app.lobby && send({ t: 'config', track: id, laps: app.lobby.laps });
    wrap.append(btn);
  }
}

function drawTrackPreview(cv, t) {
  const g = cv.getContext('2d');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < t.n; i++) {
    minX = Math.min(minX, t.xs[i]); maxX = Math.max(maxX, t.xs[i]);
    minY = Math.min(minY, t.ys[i]); maxY = Math.max(maxY, t.ys[i]);
  }
  const pad = 18, s = Math.min((cv.width - pad * 2) / (maxX - minX), (cv.height - pad * 2) / (maxY - minY));
  const ox = cv.width / 2 - ((minX + maxX) / 2) * s, oy = cv.height / 2 - ((minY + maxY) / 2) * s;
  g.beginPath();
  for (let i = 0; i < t.n; i += 2) g.lineTo(t.xs[i] * s + ox, t.ys[i] * s + oy);
  g.closePath();
  g.lineJoin = 'round';
  g.strokeStyle = t.theme.grass;
  g.lineWidth = 12;
  g.stroke();
  g.strokeStyle = '#e9ecf4';
  g.lineWidth = 4;
  g.stroke();
  g.fillStyle = '#ff3d5a';
  g.beginPath();
  g.arc(t.xs[0] * s + ox, t.ys[0] * s + oy, 6, 0, Math.PI * 2);
  g.fill();
}

function renderLobby() {
  const L = app.lobby;
  if (!L) return;
  const isHost = L.hostId === app.id;
  document.body.classList.toggle('is-host', isHost);
  setText($('room-code'), L.code);
  $('invite-url').value = inviteUrl();

  const me = L.players.find((p) => p.id === app.id);
  if (me) app.color = me.color;
  $('players').innerHTML = L.players.map((p) => `
    <li class="${p.id === app.id ? 'me' : ''}">
      <span class="car-chip" style="background:${p.color}"></span>
      <span class="name">${esc(p.name)}${p.id === app.id ? ' <span class="muted">(you)</span>' : ''}</span>
      ${p.id === L.hostId ? '<span class="badge host">Host</span>' : ''}
      ${p.bot ? '<span class="badge">Bot</span>' : ''}
    </li>`).join('');
  setText($('player-count'), `${L.players.length}/8`);
  $('add-bot').disabled = L.players.length >= 8;
  $('remove-bot').disabled = !L.players.some((p) => p.bot);

  const taken = new Set(L.players.filter((p) => p.id !== app.id).map((p) => p.color));
  drawSwatches($('lobby-colors'), app.color, taken, (c) => {
    store.set('tr-color', c);
    send({ t: 'color', color: c });
  });

  buildTrackCards();
  renderCameraPicker();
  for (const card of $('tracks').children) {
    card.classList.toggle('selected', card.dataset.track === L.track);
    card.disabled = !isHost;
  }
  setText($('laps'), String(L.laps));
  $('laps-down').disabled = !isHost || L.laps <= 1;
  $('laps-up').disabled = !isHost || L.laps >= 10;

  const host = L.players.find((p) => p.id === L.hostId);
  const racing = L.state !== 'lobby';
  $('start').style.display = isHost ? '' : 'none';
  $('start').disabled = racing;
  let status = '';
  if (racing) status = 'A race is in progress — you will join the next one.';
  else if (!isHost) status = `Waiting for ${host ? host.name : 'the host'} to start the race…`;
  else if (L.players.length === 1) status = 'Racing alone? Add a few bots, or share the invite link.';
  setText($('lobby-status'), status);
}

// ============================================================== messages

function handle(m) {
  switch (m.t) {
    case 'welcome':
      app.id = m.id;
      app.code = m.code;
      app.tracks = m.tracks;
      app.urls = m.urls || [];
      history.replaceState(null, '', `?room=${m.code}`);
      show('lobby');
      ping();
      break;
    case 'error':
      if (app.id) toast(m.msg);
      else $('menu-error').textContent = m.msg;
      break;
    case 'lobby':
      app.lobby = m;
      renderLobby();
      if (!app.race && !app.showingResults) show('lobby');
      break;
    case 'toast':
      toast(m.msg);
      break;
    case 'race':
      startRace(m);
      break;
    case 'go':
      onGo(m);
      break;
    case 'snap':
      onSnap(m);
      break;
    case 'lap':
      onLap(m);
      break;
    case 'finish':
      onFinish(m);
      break;
    case 'cap':
      onCapsule(m);
      break;
    case 'results':
      onResults(m);
      break;
    case 'pong': {
      const now = performance.now();
      const rtt = now - m.c;
      const c = app.clock;
      c.rtt = Math.round(rtt);
      c.samples.push({ rtt, off: m.ts - (m.c + rtt / 2) });
      if (c.samples.length > 10) c.samples.shift();
      c.offset = c.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
      break;
    }
  }
}

function ping() {
  send({ t: 'ping', c: performance.now() });
}
setInterval(() => app.id && ping(), 2000);

// ============================================================== race

function startRace(m) {
  const track = getTrack(m.track);
  renderer.setTrack(track);
  const now = performance.now();
  const race = {
    track,
    laps: m.laps,
    info: new Map(m.racers.map((r) => [r.id, r])),
    remotes: new Map(),
    local: null,
    phase: 'countdown',
    countdownEnd: now + m.countdown,
    lastCount: null,
    goAt: null,
    acc: 0,
    lastSend: 0,
    standings: m.racers.map((r) => ({ id: r.id, p: 0, l: 0, fin: 0 })),
    me: { laps: 0, best: null, place: 0, finishTime: null },
    wrongWay: 0,
    respawnAt: 0,
    spectate: 0,
    braking: false,
    wasBoosting: false,
    capsules: (m.capsules || []).map((c) => ({ ...c, hiddenUntil: 0 })),
  };
  for (const r of m.racers) {
    if (r.id === app.id) {
      race.local = createCar(r.x, r.y, r.a);
      advance(race.local, track);
    } else {
      race.remotes.set(r.id, makeRemote(r));
    }
  }
  app.race = race;
  app.showingResults = false;
  $('results').classList.remove('active');
  document.body.classList.toggle('spectating', !race.local);
  document.activeElement?.blur?.();
  hideBanner();
  show('hud');
  renderer.resize();
}

function makeRemote(r) {
  return {
    buf: [{ t: 0, x: r.x, y: r.y, a: r.a, vx: 0, vy: 0, s: 0, f: 0 }],
    cur: { id: r.id, name: r.name, color: r.color, x: r.x, y: r.y, a: r.a, vx: 0, vy: 0, steer: 0 },
  };
}

function onGo(m) {
  const race = app.race;
  if (!race) return;
  race.phase = 'racing';
  if (!m.late) {
    race.goAt = performance.now();
    banner('GO!', { ms: 900 });
    sound.beep(880, 0.4);
  }
}

function onSnap(m) {
  const race = app.race;
  if (!race || race.phase === 'over') return;
  const now = performance.now();
  if (app.clock.offset === null) app.clock.offset = m.ts - now;
  if (race.goAt === null && m.el > 0) race.goAt = now - m.el;

  const seen = new Set();
  for (const c of m.cars) {
    seen.add(c.i);
    if (c.i === app.id) {
      race.me.laps = c.l;
      continue;
    }
    let r = race.remotes.get(c.i);
    if (!r) {
      const info = race.info.get(c.i);
      if (!info) continue;
      race.remotes.set(c.i, (r = makeRemote(info)));
    }
    r.buf.push({ t: m.ts, x: c.x, y: c.y, a: c.a, vx: c.vx, vy: c.vy, s: c.s, f: c.f });
    if (r.buf.length > 40) r.buf.shift();
  }
  for (const id of race.remotes.keys()) if (!seen.has(id)) race.remotes.delete(id);

  race.standings = m.cars
    .map((c) => ({ id: c.i, p: c.p, l: c.l, fin: c.fin }))
    .sort((a, b) => (a.fin && b.fin ? a.fin - b.fin : a.fin ? -1 : b.fin ? 1 : b.p - a.p));
}

function onLap(m) {
  const race = app.race;
  if (!race) return;
  race.me.best = m.best;
  race.me.laps = m.lap;
  if (m.lap < race.laps) {
    banner(m.lap === race.laps - 1 ? 'FINAL LAP' : `LAP ${m.lap + 1}`, { cls: 'small', ms: 1600 });
    subBanner(`Lap ${m.lap}: ${fmt(m.time)}${m.time === m.best && m.lap > 1 ? '  ·  best lap!' : ''}`);
    sound.beep(660, 0.15);
  }
}

function onFinish(m) {
  const race = app.race;
  if (!race) return;
  if (m.id === app.id) {
    race.me.place = m.place;
    race.me.finishTime = m.time;
    banner(`${ordinal(m.place)} PLACE!`, { cls: 'small', ms: 3500 });
    subBanner(`Finished in ${fmt(m.time)} — waiting for the others`, 6000);
    sound.fanfare();
  } else {
    toast(`🏁 ${m.name} finished ${ordinal(m.place)}`);
  }
}

function onCapsule(m) {
  const race = app.race;
  const cap = race?.capsules.find((c) => c.id === m.id);
  if (!cap) return;
  if (m.on) {
    Object.assign(cap, { x: m.x, y: m.y, on: true, hiddenUntil: 0 });
    return;
  }
  // If we already hid it when driving through, the burst has been shown.
  if (cap.on && !(cap.hiddenUntil > performance.now())) renderer.burst(cap.x, cap.y);
  cap.on = false;
  if (m.by === app.id && race.local) {
    race.local.turbo = Math.min(TUNING.turboStock, race.local.turbo + 1);
    sound.pickup();
    const pop = $('turbo-pop');
    pop.classList.remove('show');
    void pop.offsetWidth;
    pop.classList.add('show');
  }
}

function onResults(m) {
  const race = app.race;
  if (race) race.phase = 'over';
  app.showingResults = true;
  sound.engine(0, false, false);
  sound.screech(0);
  hideBanner();
  const trackName = app.tracks.find((t) => t.id === m.track)?.name || '';
  setText($('results-sub'), `${trackName} · ${m.laps} lap${m.laps > 1 ? 's' : ''}`);
  const medals = ['🥇', '🥈', '🥉'];
  const winner = m.results[0]?.time;
  $('results-body').innerHTML = m.results.map((r) => `
    <tr class="${r.id === app.id ? 'me' : ''}">
      <td>${medals[r.pos - 1] || r.pos}</td>
      <td><span class="who"><span class="car-chip" style="background:${r.color}"></span>${esc(r.name)}${r.bot ? ' <span class="badge">Bot</span>' : ''}</span></td>
      <td class="${r.time == null ? 'dnf' : ''}">${r.time == null ? 'DNF' : r.pos === 1 ? fmt(r.time) : `+${((r.time - winner) / 1000).toFixed(3)}s`}</td>
      <td>${fmt(r.best)}</td>
    </tr>`).join('');
  $('results').classList.add('active');
}

$('back-to-lobby').onclick = () => {
  app.race = null;
  app.showingResults = false;
  $('results').classList.remove('active');
  document.body.classList.remove('spectating');
  renderLobby();
  show('lobby');
};

// ============================================================== controls

input.on('KeyR', () => {
  const race = app.race;
  const car = race?.local;
  if (!car || race.phase !== 'racing' || performance.now() - race.respawnAt < 1500) return;
  race.respawnAt = performance.now();
  const p = respawnPoint(race.track, car.idx);
  Object.assign(car, { x: p.x, y: p.y, a: p.a, vx: 0, vy: 0, steer: 0 });
});
input.on('KeyM', toggleMute);
const spectateStep = (d) => {
  const race = app.race;
  if (race && !race.local) race.spectate += d;
};
input.on('ArrowLeft', () => spectateStep(-1));
input.on('ArrowRight', () => spectateStep(1));

function toggleMute() {
  sound.init();
  const muted = sound.toggleMute();
  $('mute').textContent = muted ? '🔇' : '🔊';
}
$('mute').textContent = sound.muted ? '🔇' : '🔊';
$('mute').onclick = (e) => {
  toggleMute();
  e.currentTarget.blur();
};

// ============================================================== camera view

const CAMERA_ICONS = {
  classic: '<rect x="1" y="1" width="32" height="24" rx="3"/><path d="M6 8h22M6 18h22" opacity=".5"/><rect x="13" y="10" width="9" height="5" rx="1.5" fill="currentColor"/><path d="M29 4v5M27.5 5.5 29 4l1.5 1.5"/>',
  chase: '<rect x="1" y="1" width="32" height="24" rx="3"/><path d="M12 25 15 3M22 25 19 3" opacity=".5"/><rect x="14.5" y="14" width="5" height="8" rx="1.5" fill="currentColor"/>',
  close: '<rect x="1" y="1" width="32" height="24" rx="3"/><rect x="7" y="8" width="20" height="10" rx="3" fill="currentColor"/>',
  wide: '<rect x="1" y="1" width="32" height="24" rx="3"/><rect x="6" y="6" width="22" height="14" rx="7" opacity=".5"/><rect x="15" y="4.5" width="4" height="3" rx="1" fill="currentColor"/>',
};

renderer.setCameraMode(store.get('tr-camera', 'classic'));
renderer.setUserZoom(parseFloat(store.get('tr-zoom', '1')) || 1);
setText($('camera-name'), renderer.mode.name);

let viewHintTimer = null;
function viewHint(title, sub = '') {
  if (!app.race) return;
  const el = $('view-hint');
  el.innerHTML = `${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  el.classList.add('show');
  clearTimeout(viewHintTimer);
  viewHintTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function setCamera(id) {
  const mode = renderer.setCameraMode(id);
  store.set('tr-camera', mode.id);
  setText($('camera-name'), mode.name);
  renderCameraPicker();
  viewHint(`${mode.name} view`, mode.desc);
}

function cycleCamera() {
  const i = CAMERA_MODES.indexOf(renderer.mode);
  setCamera(CAMERA_MODES[(i + 1) % CAMERA_MODES.length].id);
}

function setZoom(z) {
  const zoom = renderer.setUserZoom(z);
  store.set('tr-zoom', zoom.toFixed(2));
  viewHint(`Zoom ${Math.round(zoom * 100)}%`, zoom === ZOOM_MIN ? 'Fully zoomed out' : zoom === ZOOM_MAX ? 'Fully zoomed in' : 'Press 0 to reset');
}

function renderCameraPicker() {
  const wrap = $('lobby-camera');
  if (!wrap.childElementCount) {
    for (const m of CAMERA_MODES) {
      const b = document.createElement('button');
      b.dataset.mode = m.id;
      b.title = m.desc;
      b.innerHTML = `<svg viewBox="0 0 34 26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${CAMERA_ICONS[m.id]}</svg>${m.name}`;
      b.onclick = () => setCamera(m.id);
      wrap.append(b);
    }
    const hint = document.createElement('div');
    hint.className = 'cam-hint';
    wrap.after(hint);
  }
  for (const b of wrap.children) b.classList.toggle('selected', b.dataset.mode === renderer.mode.id);
  setText(wrap.nextElementSibling, `${renderer.mode.desc}. Press C in a race to switch.`);
}

input.on('KeyC', cycleCamera);
input.on('Minus', () => setZoom(renderer.userZoom / 1.12));
input.on('NumpadSubtract', () => setZoom(renderer.userZoom / 1.12));
input.on('Equal', () => setZoom(renderer.userZoom * 1.12));
input.on('NumpadAdd', () => setZoom(renderer.userZoom * 1.12));
input.on('Digit0', () => setZoom(1));
for (const [id, fn] of [['camera', cycleCamera], ['zoom-out', () => setZoom(renderer.userZoom / 1.12)], ['zoom-in', () => setZoom(renderer.userZoom * 1.12)]]) {
  $(id).onclick = (e) => {
    fn();
    e.currentTarget.blur();      // keep Space for the handbrake, not the button
  };
}
$('game').addEventListener('wheel', (e) => {
  if (!app.race) return;
  e.preventDefault();
  setZoom(renderer.userZoom * Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

const touchCapable = matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
if (touchCapable) {
  document.body.classList.add('touch-enabled');
  input.bindTouch($('touch'));
}

// ============================================================== loop

function interpolate(r, t) {
  const b = r.buf;
  let i = b.length - 1;
  while (i > 0 && b[i].t > t) i--;
  const s0 = b[i], s1 = b[i + 1], c = r.cur;
  if (s1 && t >= s0.t) {
    const k = (t - s0.t) / (s1.t - s0.t || 1);
    c.x = s0.x + (s1.x - s0.x) * k;
    c.y = s0.y + (s1.y - s0.y) * k;
    c.a = s0.a + wrapAngle(s1.a - s0.a) * k;
    c.vx = s0.vx + (s1.vx - s0.vx) * k;
    c.vy = s0.vy + (s1.vy - s0.vy) * k;
    c.steer = s0.s + (s1.s - s0.s) * k;
  } else {
    // Ran out of snapshots: extrapolate briefly along the last velocity.
    const e = Math.max(0, Math.min(0.15, (t - s0.t) / 1000));
    c.x = s0.x + s0.vx * e;
    c.y = s0.y + s0.vy * e;
    c.a = s0.a;
    c.vx = s0.vx;
    c.vy = s0.vy;
    c.steer = s0.s;
  }
  const f = s0.f;
  c.boosting = !!(f & 1);
  c.drifting = !!(f & 2);
  c.offroad = !!(f & 4);
  c.skid = c.drifting;
  if (i > 2) b.splice(0, i - 2);
}

let lastFrame = performance.now();

function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const race = app.race;
  if (race) {
    updateRace(race, now, dt);
    drawRace(race, now, dt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function updateRace(race, now, dt) {
  if (race.phase === 'countdown') {
    const n = Math.ceil((race.countdownEnd - now) / 1000);
    if (n !== race.lastCount && n >= 1 && n <= 3) {
      race.lastCount = n;
      banner(String(n), { ms: 0, kind: 'count' });
      sound.beep(440, 0.18);
    }
  }

  const renderTs = now + (app.clock.offset ?? 0) - INTERP_MS;
  for (const r of race.remotes.values()) interpolate(r, renderTs);

  const car = race.local;
  if (!car) return;
  const controls = race.phase === 'racing' ? input.state() : NO_INPUT;
  race.acc = Math.min(race.acc + dt, 0.1);
  let wall = 0, impact = 0, steps = 0;
  const x0 = car.x, y0 = car.y;
  while (race.acc >= STEP) {
    race.acc -= STEP;
    steps++;
    stepCar(car, controls, STEP, race.track);
    wall = Math.max(wall, car.wallHit);
    for (const r of race.remotes.values()) impact = Math.max(impact, collideCars(car, r.cur, true));
  }
  if (steps) input.consumeTaps();
  const fwd = car.vx * Math.cos(car.a) + car.vy * Math.sin(car.a);
  const speed = Math.hypot(car.vx, car.vy);
  race.braking = controls.down && fwd > 30;

  // Hide capsules we drive through right away; the server confirms the
  // pickup a moment later (and un-hides it if someone else got there first).
  if (race.phase === 'racing' && car.turbo < TUNING.turboStock) {
    for (const cap of race.capsules) {
      if (cap.on && !(cap.hiddenUntil > now) && touchesCapsule(cap, x0, y0, car.x, car.y)) {
        cap.hiddenUntil = now + 700;
        renderer.burst(cap.x, cap.y);
      }
    }
  }
  if (car.boosting && !race.wasBoosting) {
    sound.turbo();
    renderer.addShake(5);
  }
  race.wasBoosting = car.boosting;

  if (wall > 70) {
    sound.crash(wall / 450);
    renderer.sparks(car.x + Math.cos(car.a) * 14, car.y + Math.sin(car.a) * 14, wall / 500);
    renderer.addShake(wall / 70);
  }
  if (impact > 50) {
    sound.crash(impact / 400);
    renderer.sparks(car.x, car.y, impact / 500);
    renderer.addShake(impact / 80);
  }

  if (race.phase === 'racing' && now - race.lastSend >= SEND_MS) {
    race.lastSend = now;
    send({
      t: 's',
      x: Math.round(car.x * 10) / 10,
      y: Math.round(car.y * 10) / 10,
      a: Math.round(car.a * 1000) / 1000,
      vx: Math.round(car.vx),
      vy: Math.round(car.vy),
      s: Math.round(car.steer * 100) / 100,
      f: (car.boosting ? 1 : 0) | (car.drifting ? 2 : 0) | (car.offroad ? 4 : 0),
      n: car.turbo,
    });
  }

  // Driving against the flow of the track for a while?
  const t = race.track;
  const along = car.vx * t.tx[car.idx] + car.vy * t.ty[car.idx];
  race.wrongWay = race.phase === 'racing' && along < -60 ? race.wrongWay + dt : 0;

  const slip = Math.abs(-car.vx * Math.sin(car.a) + car.vy * Math.cos(car.a));
  if (race.phase !== 'over') {
    sound.engine(speed, car.boosting, true);
    sound.screech(car.drifting && !car.offroad ? Math.min(1, slip / 260) : 0);
  }
}

function drawRace(race, now, dt) {
  const cars = [];
  for (const r of race.remotes.values()) cars.push(r.cur);
  let focus = null;
  if (race.local) {
    const c = race.local;
    const info = race.info.get(app.id);
    const speed = Math.hypot(c.vx, c.vy);
    focus = {
      id: app.id, me: true, name: info?.name, color: info?.color || app.color,
      x: c.x, y: c.y, a: c.a, vx: c.vx, vy: c.vy, steer: c.steer,
      boosting: c.boosting, drifting: c.drifting, offroad: c.offroad,
      braking: race.braking,
      skid: c.drifting || (race.braking && speed > 220),
      highlight: race.phase === 'countdown' ? 1 : race.goAt ? Math.max(0, 1 - (now - race.goAt) / 2500) : 0,
    };
    cars.push(focus);
  } else {
    // Spectating: follow a car from the current standings.
    const list = race.standings.filter((s) => race.remotes.has(s.id));
    if (list.length) {
      const idx = ((race.spectate % list.length) + list.length) % list.length;
      focus = race.remotes.get(list[idx].id).cur;
    }
  }

  for (const c of cars) renderer.effects(c, dt);
  renderer.updateParticles(dt);
  if (focus) renderer.follow(focus, dt);
  renderer.draw(cars, { now, showMe: race.phase === 'countdown', capsules: race.capsules });
  renderer.drawMinimap(cars, race.capsules);
  updateHud(race, now, focus);
}

let standingsKey = '';
function updateHud(race, now, focus) {
  const st = race.standings;
  const shownId = race.local ? app.id : focus?.id;
  const idx = st.findIndex((s) => s.id === shownId);
  const place = (race.local && race.me.place) || (idx >= 0 ? idx + 1 : 1);
  setText($('hud-pos'), String(place));
  setText($('hud-pos-suffix'), suffix(place));
  setText($('hud-pos-total'), `/${st.length}`);
  setText($('hud-lap'), race.me.place ? 'FINISHED' : `${Math.min(race.me.laps + 1, race.laps)}/${race.laps}`);
  const elapsed = race.me.finishTime ?? (race.goAt != null && race.phase !== 'countdown' ? now - race.goAt : 0);
  setText($('hud-time'), fmt(Math.max(0, elapsed)));
  setText($('hud-best'), fmt(race.me.best));
  setText($('hud-ping'), app.clock.rtt ? `${app.clock.rtt} ms` : '');

  if (race.local) {
    const c = race.local;
    setText($('hud-speed'), String(Math.round(Math.hypot(c.vx, c.vy) * 0.4)));
    const slots = $('turbo-slots').children;
    for (let i = 0; i < slots.length; i++) slots[i].classList.toggle('full', i < c.turbo);
    setText($('turbo-count'), String(c.turbo));
    $('turbo').classList.toggle('active', c.boosting);
    $('turbo-time').style.width = `${(c.turboTime / TUNING.turboDuration) * 100}%`;
    $('hud-speed').parentElement.classList.toggle('turbo', c.boosting);
  }

  const key = st.map((s) => `${s.id}:${s.fin}`).join(',');
  if (key !== standingsKey) {
    standingsKey = key;
    $('standings').innerHTML = st.map((s, i) => {
      const info = race.info.get(s.id) || {};
      return `<li class="${s.id === app.id ? 'me' : ''}"><span class="p">${i + 1}</span><span class="dot" style="background:${info.color}"></span><span class="n">${esc(info.name || '?')}</span>${s.fin ? '<span class="s">🏁</span>' : ''}</li>`;
    }).join('');
  }

  if (race.wrongWay > 1 && !bannerKind) banner('WRONG WAY', { cls: 'warn', ms: 0, kind: 'wrong' });
  else if (race.wrongWay === 0 && bannerKind === 'wrong') hideBanner();
  if (race.phase === 'racing' && bannerKind === 'count') hideBanner();
}
