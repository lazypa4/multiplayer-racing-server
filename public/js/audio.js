// Tiny synthesized sound kit: engine hum, tyre screech, bumps and beeps.
// Everything is generated with WebAudio, so there are no asset files.

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    try { this.muted = localStorage.getItem('tr-muted') === '1'; } catch {}
  }

  // Browsers only allow audio after a user gesture, so call this from a click.
  init() {
    if (this.ctx) return this.ctx.resume();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(ctx.destination);

    // Engine: a sawtooth and a sub square through a lowpass filter.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 700;
    this.engineFilter.Q.value = 4;
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    const sub = ctx.createGain();
    sub.gain.value = 0.5;
    this.osc1.connect(this.engineFilter);
    this.osc2.connect(sub).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.osc1.start();
    this.osc2.start();

    // Shared white noise for screeches and crashes.
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const screech = ctx.createBufferSource();
    screech.buffer = this.noise;
    screech.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1700;
    band.Q.value = 6;
    this.screechGain = ctx.createGain();
    this.screechGain.gain.value = 0;
    screech.connect(band).connect(this.screechGain).connect(this.master);
    screech.start();
  }

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem('tr-muted', this.muted ? '1' : '0'); } catch {}
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  // speed in px/s; fake gear changes make it sound like a real engine.
  engine(speed, boosting, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const gearSize = 170;
    const gear = Math.min(4, Math.floor(speed / gearSize));
    const rpm = gear >= 4 ? Math.min(1.4, (speed - 4 * gearSize) / gearSize + 0.4) : (speed % gearSize) / gearSize;
    const f = 48 + rpm * 70 + gear * 10 + (boosting ? 25 : 0);
    this.osc1.frequency.setTargetAtTime(f, t, 0.04);
    this.osc2.frequency.setTargetAtTime(f / 2, t, 0.04);
    this.engineFilter.frequency.setTargetAtTime(500 + rpm * 900 + (boosting ? 700 : 0), t, 0.05);
    this.engineGain.gain.setTargetAtTime(active ? 0.07 + rpm * 0.04 : 0, t, 0.1);
  }

  screech(amount) {
    if (!this.ctx) return;
    this.screechGain.gain.setTargetAtTime(Math.min(0.12, amount * 0.12), this.ctx.currentTime, 0.06);
  }

  crash(strength) {
    if (!this.ctx || strength < 0.05) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400 + strength * 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.5, strength * 0.5), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, 0.3);
  }

  beep(freq = 440, dur = 0.18) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  pickup() {
    [988, 1319, 1976].forEach((f, i) => setTimeout(() => this.beep(f, 0.09), i * 55));
  }

  // Rising whoosh when a turbo fires.
  turbo() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 3;
    band.frequency.setValueAtTime(300, t);
    band.frequency.exponentialRampToValueAtTime(3200, t + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    src.connect(band).connect(g).connect(this.master);
    src.start(t, 0, 1);
  }

  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, 0.22), i * 130));
  }
}
