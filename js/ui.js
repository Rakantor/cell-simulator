'use strict';
// User interface: the help bar, the hidden tuning panel (M) and the unsupported-browser message.

const UI = {
  init(app) {
    this.app = app;
    this.helpBar = document.getElementById('helpbar');
    this.panel = document.getElementById('panel');
    this.buildHelpBar();
    this.buildPanel();
  },

  showUnsupported() {
    const hb = document.getElementById('helpbar');
    if (hb) hb.remove();
    const m = document.getElementById('message');
    m.textContent = 'This demo needs WebGL2 with float render targets.';
    m.hidden = false;
  },

  buildHelpBar() {
    const hb = this.helpBar;
    hb.innerHTML = '';
    const item = (txt, id) => {
      const s = document.createElement('span');
      s.className = 'hb-item';
      if (id) s.id = id;
      s.textContent = txt;
      return s;
    };
    const sep = () => { const s = document.createElement('span'); s.className = 'hb-sep'; s.textContent = '·'; return s; };
    this.panLabel = item('', 'hb-pan');
    this.zoomLabel = item('', 'hb-zoom');
    hb.append(this.panLabel, sep(), this.zoomLabel, sep(), item('Right-click & hold: split'), sep(), item('M: menu'));
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Input device');
    this.modeButtons = {};
    for (const [mode, label] of [['mouse', 'Mouse'], ['trackpad', 'Trackpad']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => this.app.input.setMode(mode));
      this.modeButtons[mode] = b;
      seg.append(b);
    }
    hb.append(seg);
    this.updateMode(this.app.input.mode);
  },

  updateMode(mode) {
    const mouse = mode === 'mouse';
    this.panLabel.textContent = mouse ? 'Drag: pan' : 'Drag / two-finger scroll: pan';
    this.zoomLabel.textContent = mouse ? 'Wheel: zoom' : 'Pinch: zoom';
    for (const m in this.modeButtons) {
      this.modeButtons[m].classList.toggle('on', m === mode);
      this.modeButtons[m].setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    }
  },

  togglePanel() {
    this.panel.hidden = !this.panel.hidden;
  },

  buildPanel() {
    const p = this.panel;
    p.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'p-head';
    head.innerHTML = '<span class="p-title">Tuning</span><span class="p-hint">M to close</span>';
    p.append(head);
    this.stats = document.createElement('div');
    this.stats.className = 'p-stats';
    p.append(this.stats);

    const btns = document.createElement('div');
    btns.className = 'p-buttons';
    const button = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', fn);
      btns.append(b);
      return b;
    };
    button('Divide all here', () => this.app.divideAllHere());
    button('Grow here to 100k', () => this.app.startStress(100000));
    button('Copy settings', () => this.copySettings());
    p.append(btns);

    this.sliders = {};
    for (const group of TUNING_GROUPS) {
      const sec = document.createElement('div');
      sec.className = 'p-group';
      const h = document.createElement('div');
      h.className = 'p-gtitle';
      h.textContent = group.name;
      sec.append(h);
      for (const [key, label, min, max, step] of group.items) {
        const row = document.createElement('label');
        row.className = 'p-row';
        const name = document.createElement('span');
        name.className = 'p-name';
        name.textContent = label;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = min; input.max = max; input.step = step;
        input.value = CFG[key];
        const val = document.createElement('span');
        val.className = 'p-val';
        const fmt = v => (step >= 1 ? String(Math.round(v)) : Number(v).toFixed(step < 0.01 ? 3 : 2));
        val.textContent = fmt(CFG[key]);
        input.addEventListener('input', () => {
          CFG[key] = step >= 1 ? Math.round(+input.value) : +input.value;
          val.textContent = fmt(CFG[key]);
        });
        row.append(name, input, val);
        sec.append(row);
        this.sliders[key] = { input, val, fmt };
      }
      p.append(sec);
    }

    const palSec = document.createElement('div');
    palSec.className = 'p-group';
    const ph = document.createElement('div');
    ph.className = 'p-gtitle';
    ph.textContent = 'Palettes';
    palSec.append(ph);
    PALETTES.forEach((pal) => {
      const det = document.createElement('details');
      det.className = 'p-pal';
      const sum = document.createElement('summary');
      sum.textContent = pal.name;
      det.append(sum);
      const grid = document.createElement('div');
      grid.className = 'p-colors';
      for (const key of PALETTE_KEYS) {
        const cell = document.createElement('label');
        cell.className = 'p-color';
        const input = document.createElement('input');
        input.type = 'color';
        input.value = pal[key];
        input.addEventListener('input', () => { pal[key] = input.value; this.app.palettesDirty = true; });
        const n = document.createElement('span');
        n.textContent = key;
        cell.append(input, n);
        grid.append(cell);
      }
      det.append(grid);
      palSec.append(det);
    });
    p.append(palSec);
  },

  updateStats(s) {
    if (this.panel.hidden) return;
    this.stats.textContent =
      `${s.fps.toFixed(0)} fps · res ${Math.round(s.res * 100)}% · level ${s.level}\n` +
      `cells here ${s.here.toLocaleString()} · total ${s.total.toLocaleString()} · worlds ${s.worlds}`;
  },

  copySettings() {
    const json = JSON.stringify({ settings: CFG, palettes: PALETTES }, null, 2);
    const fallback = () => console.log(json);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).catch(fallback);
      } else {
        fallback();
      }
    } catch (e) {
      fallback();
    }
  },
};
