// Keyboard, touch and gamepad input merged into one control state.

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'handbrake',
  ShiftLeft: 'nitro', ShiftRight: 'nitro', KeyN: 'nitro',
};

export class Input {
  constructor() {
    this.keys = new Set();
    this.touch = new Set();
    this.taps = new Set();        // presses held until the game has seen them once
    this.handlers = {};

    const typing = (e) => e.target instanceof HTMLInputElement;
    addEventListener('keydown', (e) => {
      if (typing(e)) return;
      const action = KEYMAP[e.code];
      if (action) {
        e.preventDefault();
        this.keys.add(action);
        if (!e.repeat) this.taps.add(action);
      }
      if (!e.repeat) this.handlers[e.code]?.();
    });
    addEventListener('keyup', (e) => {
      const action = KEYMAP[e.code];
      if (action) this.keys.delete(action);
    });
    addEventListener('blur', () => this.keys.clear());
  }

  // Register a one-shot handler for a key code (e.g. 'KeyR').
  on(code, fn) {
    this.handlers[code] = fn;
  }

  bindTouch(root) {
    for (const btn of root.querySelectorAll('[data-key]')) {
      const key = btn.dataset.key;
      const down = (e) => { e.preventDefault(); this.touch.add(key); this.taps.add(key); btn.classList.add('on'); };
      const up = (e) => { e.preventDefault(); this.touch.delete(key); btn.classList.remove('on'); };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
    }
  }

  // Call after the game has simulated at least one step with state().
  consumeTaps() {
    this.taps.clear();
  }

  state() {
    const has = (k) => this.keys.has(k) || this.touch.has(k) || this.taps.has(k);
    const s = {
      up: has('up'), down: has('down'), left: has('left'), right: has('right'),
      handbrake: has('handbrake'), nitro: has('nitro'),
    };
    const pad = navigator.getGamepads?.().find((g) => g && g.connected);
    if (pad) {
      const b = (i) => pad.buttons[i]?.pressed;
      const x = pad.axes[0] || 0;
      if (Math.abs(x) > 0.15) s.steer = x;
      s.up ||= b(7) || b(0);
      s.down ||= b(6) || b(1);
      s.handbrake ||= b(2);
      s.nitro ||= b(5) || b(3);
      s.left ||= b(14);
      s.right ||= b(15);
    }
    return s;
  }
}
