'use strict';
// Input: drag to pan (with a little inertia), wheel/pinch to zoom, right-click hold to split, M for the menu.

const MODE_KEY = 'nestedCells.inputMode';

function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch (e) { return null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
}

class Input {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.h = handlers;            // { onSplitPress(x, y), onSplitRelease(), onToggleMenu(), onModeChange(mode) }
    this.mode = storageGet(MODE_KEY) === 'trackpad' ? 'trackpad' : 'mouse';
    this.mouseX = innerWidth / 2;
    this.mouseY = innerHeight / 2;
    this.panX = 0; this.panY = 0;           // pending pan this frame (CSS px)
    this.velX = 0; this.velY = 0;           // inertia (CSS px / s)
    this.zoomPending = 0;                   // pending log-scale change
    this.zoomTau = CFG.wheelEase;
    this.zoomX = this.mouseX; this.zoomY = this.mouseY;
    this.dragging = false;
    this.samples = [];
    this.rightDown = false;
    this.gestureScale = 1;
    this.bind();
  }

  setMode(mode) {
    this.mode = mode;
    storageSet(MODE_KEY, mode);
    if (this.h.onModeChange) this.h.onModeChange(mode);
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('mousedown', e => this.onDown(e));
    window.addEventListener('mousemove', e => this.onMove(e));
    window.addEventListener('mouseup', e => this.onUp(e));
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    // Keep the browser from page-zooming on pinch anywhere in the page.
    window.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
    c.addEventListener('gesturestart', e => { e.preventDefault(); this.gestureScale = 1; this.setAnchor(e); });
    c.addEventListener('gesturechange', e => {
      e.preventDefault();
      const s = e.scale || 1;
      this.addZoom(Math.log(s / this.gestureScale), CFG.pinchEase);
      this.gestureScale = s;
      this.setAnchor(e);
    });
    c.addEventListener('gestureend', e => e.preventDefault());
    window.addEventListener('keydown', e => {
      if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (this.h.onToggleMenu) this.h.onToggleMenu();
      }
    });
    window.addEventListener('blur', () => this.cancelAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.cancelAll(); });
  }

  setAnchor(e) {
    if (typeof e.clientX === 'number') {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      this.zoomX = e.clientX; this.zoomY = e.clientY;
    }
  }

  onDown(e) {
    this.mouseX = e.clientX; this.mouseY = e.clientY;
    if (e.button === 0) {
      this.dragging = true;
      this.velX = 0; this.velY = 0;
      this.samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      e.preventDefault();
    } else if (e.button === 2) {
      this.rightDown = true;
      if (this.h.onSplitPress) this.h.onSplitPress(e.clientX, e.clientY);
      e.preventDefault();
    }
  }

  onMove(e) {
    const dx = e.clientX - this.mouseX, dy = e.clientY - this.mouseY;
    this.mouseX = e.clientX; this.mouseY = e.clientY;
    if (this.dragging) {
      this.panX += dx; this.panY += dy;
      const now = performance.now();
      this.samples.push({ t: now, x: e.clientX, y: e.clientY });
      while (this.samples.length > 2 && now - this.samples[0].t > 100) this.samples.shift();
    }
  }

  onUp(e) {
    if (e.button === 0 && this.dragging) {
      this.dragging = false;
      // Inertia only if the pointer was still moving at release.
      const now = performance.now();
      const s = this.samples;
      const last = s[s.length - 1];
      if (s.length >= 2 && now - last.t < 50) {
        let k = 0;
        while (k < s.length - 2 && now - s[k].t > 80) k++;
        const dt = (last.t - s[k].t) / 1000;
        if (dt > 0.005) { this.velX = (last.x - s[k].x) / dt; this.velY = (last.y - s[k].y) / dt; }
      }
    } else if (e.button === 2 && this.rightDown) {
      this.rightDown = false;
      if (this.h.onSplitRelease) this.h.onSplitRelease();
    }
  }

  onWheel(e) {
    e.preventDefault();
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    else if (e.deltaMode === 2) { dx *= innerHeight * 0.9; dy *= innerHeight * 0.9; }
    this.mouseX = e.clientX; this.mouseY = e.clientY;
    if (e.ctrlKey) {
      this.zoomX = e.clientX; this.zoomY = e.clientY;
      this.addZoom(-dy * CFG.pinchZoomStep, CFG.pinchEase);
    } else if (this.mode === 'mouse') {
      this.zoomX = e.clientX; this.zoomY = e.clientY;
      this.addZoom(-dy * CFG.wheelZoomStep, CFG.wheelEase);
    } else {
      this.panX -= dx; this.panY -= dy;
      this.velX = 0; this.velY = 0;
    }
  }

  addZoom(d, tau) {
    this.zoomPending += d;
    this.zoomTau = tau;
  }

  cancelAll() {
    this.dragging = false;
    this.velX = 0; this.velY = 0;
    if (this.rightDown) {
      this.rightDown = false;
      if (this.h.onSplitRelease) this.h.onSplitRelease();
    }
  }

  // Returns this frame's pan (CSS px) and zoom step (log scale), applying easing and inertia.
  consume(dt) {
    let px = this.panX, py = this.panY;
    this.panX = 0; this.panY = 0;
    if (!this.dragging && (this.velX || this.velY)) {
      px += this.velX * dt; py += this.velY * dt;
      const k = Math.exp(-dt / CFG.inertiaDecay);
      this.velX *= k; this.velY *= k;
      if (Math.hypot(this.velX, this.velY) < 2) { this.velX = 0; this.velY = 0; }
    }
    let dz = 0;
    if (this.zoomPending !== 0) {
      dz = this.zoomPending * (1 - Math.exp(-dt / Math.max(this.zoomTau, 1e-3)));
      this.zoomPending -= dz;
      if (Math.abs(this.zoomPending) < 1e-5) { dz += this.zoomPending; this.zoomPending = 0; }
    }
    return { px, py, dz, zx: this.zoomX, zy: this.zoomY };
  }

  // Called when zoom hits a hard limit: drop the remaining pending zoom in that direction.
  clampZoom(sign) {
    if (Math.sign(this.zoomPending) === sign) this.zoomPending = 0;
  }
}
