'use strict';
// Main application: frame loop, camera following and frame switching, nested rendering, picking,
// player divisions, the stress test and adaptive resolution.

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

class App {
  constructor() {
    this.canvas = document.getElementById('view');
    this.params = new URLSearchParams(location.search);
    this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
    this.canvas.addEventListener('webglcontextrestored', () => location.reload());
    const gl = GLU.init(this.canvas);
    if (!gl) { UI.showUnsupported(); return; }
    this.gl = gl;
    this.input = new Input(this.canvas, {
      onSplitPress: (x, y) => this.onSplitPress(x, y),
      onSplitRelease: () => this.onSplitRelease(),
      onToggleMenu: () => UI.togglePanel(),
      onModeChange: m => UI.updateMode(m),
    });
    UI.init(this);
    this.resScale = 1;
    this.adaptive = !this.params.has('noadapt');
    this.resize();
    this.progs = {
      birth: GLU.program(SH.fullscreenVS, SH.birthFS, 'birth'),
      grid: GLU.program(SH.gridVS, SH.gridFS, 'grid'),
      solver: GLU.program(SH.fullscreenVS, SH.solverFS, 'solver'),
      cell: GLU.program(SH.cellVS, SH.cellFS, 'cell'),
      container: GLU.program(SH.fullscreenVS, SH.containerFS, 'container'),
      particle: GLU.program(SH.particleVS, SH.particleFS, 'particle'),
      noise: GLU.program(SH.fullscreenVS, SH.noiseFS, 'noise'),
    };
    this.makeNoise();
    this.makePick();
    this.grid = new Grid(gl);
    this.palettesDirty = true;
    this.palData = new Float32Array(54 * 3);
    this.marbData = new Float32Array(6 * 4);

    this.worlds = [];
    const w0 = new World(this, 0, randomShape());
    this.worlds.push(w0);
    w0.populate(populationForLevel(0), null);
    this.ensureLevels(2);

    this.camera = new Camera(w0);
    this.camera.logScale = Math.log(this.screenMin / CFG.startViewRadii);
    this.prevVisible = new Set([w0]);
    this.split = null;
    this.playerDiv = null;
    this.stress = null;
    this.pick = null;
    this.fps = 60;
    this.avgDt = 1 / 60;
    this.startT = performance.now();
    this.lastResChange = 0;
    this.lastSlow = performance.now();
    this.last = performance.now();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  get screenMin() { return Math.min(innerWidth, innerHeight); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, CFG.maxDpr);
    const k = dpr * this.resScale;
    const w = Math.max(1, Math.round(innerWidth * k)), h = Math.max(1, Math.round(innerHeight * k));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.pxPerCss = w / innerWidth;
  }

  makeNoise() {
    const gl = this.gl, N = CFG.noiseSize;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(N)) + 1, gl.RGBA8, N, N);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (GLU.aniso) {
      const maxA = gl.getParameter(GLU.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, GLU.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, maxA));
    }
    const f = GLU.fbo([t]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.viewport(0, 0, N, N);
    gl.disable(gl.BLEND);
    this.progs.noise.use().set('uSize', N);
    GLU.drawFullscreen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(f);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.noise = t;
  }

  makePick() {
    const gl = this.gl;
    this.pickTex = GLU.floatTex(1, 1);
    this.pickFbo = GLU.fbo([this.pickTex]);
    this.pickBuf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pickBuf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 16, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.pickOut = new Float32Array(4);
  }

  // The two levels above the camera's world always exist; create them on demand.
  ensureLevels(maxLevel) {
    while (this.worlds.length <= maxLevel) {
      const L = this.worlds.length;
      const child = this.worlds[L - 1];
      const w = new World(this, L, randomShape());
      w.child = child;
      child.parent = w;
      this.worlds.push(w);
      w.populate(populationForLevel(L), child.shape);
    }
  }

  // ------------------------------------------------------------------ frame

  frame(now) {
    requestAnimationFrame(this.frame);
    if (this.lost) return;
    const dtReal = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    const dt = Math.min(0.1, dtReal);
    const simDt = Math.min(dt, 1 / 30);
    this.resize();
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);

    this.applyInput(this.input.consume(dt), dt);

    const sims = new Set(this.prevVisible);
    sims.add(this.camera.world);
    if (simDt < 1e-4) sims.clear();
    for (const w of this.worlds) {
      if (sims.has(w)) w.stepContainer(simDt);
      else { w.expandK = 1; w.expandSub = 1; if (w.cont) { w.contOld = w.contPose(); w.contNew = w.contOld; } }
    }
    this.rideExpansion();
    this.followContainers(sims);
    this.switchFrames();
    this.ensureLevels(this.camera.world.level + 2);

    const view = this.computeView();
    this.updatePlayerDivision(simDt, sims);
    this.updateStress(sims);
    for (const w of this.worlds) if (sims.has(w)) w.simulate(simDt, false);
    this.prevVisible = new Set(view.list.map(e => e.world));

    this.render(view);
    this.updatePick(view, now);
    this.updateResolution(now, dtReal);
    if (dtReal > 0) this.fps += (1 / dtReal - this.fps) * 0.05;
    UI.updateStats({
      fps: this.fps, res: this.resScale, level: this.camera.world.level,
      here: this.camera.world.count, total: this.worlds.reduce((a, w) => a + w.count, 0), worlds: this.worlds.length,
    });
  }

  updateResolution(now, dtReal) {
    if (!this.adaptive || now - this.startT < 1500) return;
    this.avgDt += (dtReal - this.avgDt) * 0.1;
    if (this.avgDt > CFG.slowFrame) {
      this.lastSlow = now;
      if (this.resScale > CFG.resMin && now - this.lastResChange > 600) {
        this.resScale = Math.max(CFG.resMin, this.resScale - CFG.resStep);
        this.lastResChange = now;
      }
    } else if (this.resScale < 1 && now - this.lastSlow > CFG.resProbeAfter * 1000 &&
               now - this.lastResChange > CFG.resProbeAfter * 1000) {
      this.resScale = Math.min(1, this.resScale + CFG.resStep);
      this.lastResChange = now;
    }
  }

  // ------------------------------------------------------------------ camera

  applyInput(inp, dt) {
    const cam = this.camera;
    if (inp.px || inp.py) cam.pan(inp.px, -inp.py);
    if (inp.dz) {
      const sx = inp.zx - innerWidth / 2, sy = -(inp.zy - innerHeight / 2);
      let dz = inp.dz;
      if (dz > 0) {
        const maxLog = this.maxLogScale(sx, sy);
        if (cam.logScale + dz > maxLog) {
          dz = Math.max(0, maxLog - cam.logScale);
          this.input.clampZoom(1);
        }
      }
      if (dz) cam.zoomAt(dz, sx, sy);
    }
    this.clampToRim(dt);
  }

  // Hard zoom limit (a cell's radius about three screens) except when zooming into the container.
  maxLogScale(sx, sy) {
    const cam = this.camera, F = cam.world;
    if (F.cont && F.child) {
      const [ax, ay] = cam.screenToWorld(sx, sy);
      if (this.insideContainer(F, ax, ay) || this.insideContainer(F, cam.cx, cam.cy)) return Infinity;
    }
    return Math.log(CFG.maxZoomScreens * this.screenMin);
  }

  insideContainer(W, x, y) {
    const c = W.cont, s = W.child.shape;
    const dx = x - c.x, dy = y - c.y, cs = Math.cos(c.th), sn = Math.sin(c.th);
    const lx = dx * cs + dy * sn, ly = -dx * sn + dy * cs;
    const A = s.size * s.aspect;
    return sdEggCPU(lx, ly, A * (1 + s.egg), A * (1 - s.egg), s.size)[0] < 0;
  }

  // Zoomed deeper than the outer world's limit, the view centre may not leave the membrane.
  clampToRim(dt) {
    const cam = this.camera, F = cam.world;
    if (!F.parent) return;
    const s = cam.scale, sm = this.screenMin;
    const t = F.memB * s / sm;
    if (t < 2) return;
    const allowed = CFG.followBand * Math.max(0, Math.min(1, 3 - t)) * sm / s;
    const [d, nx, ny] = sdEggCPU(cam.cx, cam.cy, F.memAf, F.memAb, F.memB);
    if (d > allowed) {
      const k = 1 - Math.exp(-dt / 0.06);
      cam.cx -= nx * (d - allowed) * k;
      cam.cy -= ny * (d - allowed) * k;
    }
  }

  // How strongly the camera rides with the container holding world X: by its radius on screen and
  // by how far (in screens) the view centre is outside its outline.
  followAlpha(X, cx, cy, scale) {
    const sm = this.screenMin;
    const t = X.memB * scale / sm;
    const d = sdEggCPU(cx, cy, X.memAf, X.memAb, X.memB)[0] * scale / sm;
    return smoothstep(CFG.followDetach, CFG.followAttach, t) * (1 - smoothstep(0, CFG.followBand, d));
  }

  followContainers(sims) {
    const cam = this.camera, F = cam.world;
    let Q = cam.pose();
    let changed = false;
    // The container inside the camera's world (holding F.child).
    if (F.cont && F.child && sims.has(F)) {
      const X = F.child;
      const U = F.childTransform(F.contNew).inv();
      const [xx, xy] = U.apply(cam.cx, cam.cy);
      const beta = this.followAlpha(X, xx, xy, cam.scale / X.S);
      if (beta > 0) {
        const o = F.contOld, n = F.contNew;
        Q = partialMotion(o.x, o.y, n.x, n.y, wrapAngle(n.th - o.th), 1, beta).mul(Q);
        changed = true;
      }
    }
    // The container holding the camera's world, in the parent.
    const P = F.parent;
    if (P && P.cont && sims.has(P)) {
      const alpha = this.followAlpha(F, cam.cx, cam.cy, cam.scale);
      const o = P.contOld, n = P.contNew;
      if (alpha < 1 && (o.x !== n.x || o.y !== n.y || o.th !== n.th)) {
        const T0 = P.childTransform(o), T1 = P.childTransform(n);
        const M = partialMotion(o.x, o.y, n.x, n.y, wrapAngle(n.th - o.th), 1, alpha);
        Q = T1.inv().mul(M).mul(T0).mul(Q);
        changed = true;
      }
    }
    if (changed) cam.setFromPose(Q);
  }

  // The camera lives in exactly one world's frame; switches are exact similarity conversions.
  switchFrames() {
    const cam = this.camera, sm = this.screenMin;
    for (let guard = 0; guard < 4; guard++) {
      const F = cam.world;
      if (F.parent) {
        const t = F.memB * cam.scale / sm;
        const d = sdEggCPU(cam.cx, cam.cy, F.memAf, F.memAb, F.memB)[0] * cam.scale / sm;
        if (t < CFG.switchUp || d > CFG.switchUpOutside) {
          const P = F.parent;
          cam.setFromPose(P.childTransform().mul(cam.pose()));
          cam.world = P;
          this.ensureLevels(P.level + 2);
          continue;
        }
      }
      if (F.cont && F.child) {
        const X = F.child;
        const U = F.childTransform().inv();
        const [xx, xy] = U.apply(cam.cx, cam.cy);
        const sX = cam.scale / X.S;
        const t = X.memB * sX / sm;
        const d = sdEggCPU(xx, xy, X.memAf, X.memAb, X.memB)[0];
        if (t > CFG.switchDown && d < 0) {
          cam.setFromPose(U.mul(cam.pose()));
          cam.world = X;
          continue;
        }
      }
      break;
    }
  }

  // ------------------------------------------------------------------ view

  screenInside(W, T) {
    const inv = T.inv();
    const hw = innerWidth / 2, hh = innerHeight / 2;
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
      const [wx, wy] = inv.apply(x, y);
      if (sdEggCPU(wx, wy, W.memAf, W.memAb, W.memB)[0] >= 0) return false;
    }
    return true;
  }

  innerFade(t) {
    const x = Math.min(1, Math.max(0, (t - CFG.innerFadeStart) / Math.max(CFG.innerFadeEnd - CFG.innerFadeStart, 1e-3)));
    return x * x;
  }

  // Walk outward until the screen lies inside one container, then collect the visible nested worlds.
  // Transforms map world coordinates to CSS px relative to the screen centre (y up).
  computeView() {
    const cam = this.camera;
    let W = cam.world, T = cam.toScreen();
    while (W.parent && !this.screenInside(W, T)) {
      T = T.mul(W.parent.childTransform().inv());
      W = W.parent;
    }
    const list = [];
    const sm = this.screenMin, hw = innerWidth / 2, hh = innerHeight / 2;
    const visit = (W, T, opacity) => {
      const e = { world: W, T, opacity, child: null, contVisible: false };
      list.push(e);
      W.innerOpacity = 0;
      W.flex = 1;
      if (W.cont && W.child) {
        const U = T.mul(W.childTransform());
        const s = W.child.shape;
        const t = s.size * T.scale() / sm;
        const o = this.innerFade(t);
        W.innerOpacity = o;
        W.flex = 1 - smoothstep(0, 0.05, o);
        const [cx, cy] = U.apply(0, 0);
        const r = (s.aspect * (1 + Math.abs(s.egg)) + CFG.haloSize) * s.size * T.scale();
        e.contVisible = Math.abs(cx) - r < hw && Math.abs(cy) - r < hh;
        e.U = U;
        if (o > 0 && e.contVisible) e.child = visit(W.child, U, opacity * o);
      }
      return e;
    };
    const root = visit(W, T, 1);
    return { root, list };
  }

  // ------------------------------------------------------------------ rendering

  uploadPalettes(p) {
    if (this.palettesDirty) {
      PALETTES.forEach((pal, i) => {
        PALETTE_KEYS.forEach((k, j) => this.palData.set(hexToRgb(pal[k]), (i * 9 + j) * 3));
        this.marbData.set([pal.marbleLo, pal.marbleHi, pal.veins, pal.strength], i * 4);
      });
      this.palettesDirty = false;
    }
    p.set('uPalC', this.palData).set('uMarb', this.marbData);
  }

  magFade(pxWorld) {
    const tpp = pxWorld * CFG.interiorScale * CFG.noiseSize * (1 - 0.5 * CFG.interiorBulge);
    const coarse = smoothstep(0.06, 0.3, tpp);
    const fine = smoothstep(0.06, 0.3, tpp * 4) * (1 - coarse) * 0.75;
    return [coarse, fine];
  }

  // CSS-px transform → device-px transform.
  dev(T) { const k = this.pxPerCss; return new Sim2(T.a * k, T.b * k, T.tx * k, T.ty * k); }

  render(view) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // Backdrop: the container holding the root world, its interior fully become the background.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const root = view.root;
    this.drawContainer(root.world, root.T, 1, 1, 1, root.world.parent, true);
    this.drawWorld(root);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
  }

  drawWorld(e) {
    const W = e.world, gl = this.gl;
    this.drawParticles(W, e.T, e.opacity);
    const separate = !!(W.cont && W.child && W.flex <= 0);
    const skip = separate ? 0 : -1;
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawCells(W, e.T, e.opacity, 0, skip);
    if (separate && e.contVisible) this.drawContainer(W.child, e.U, W.innerOpacity, e.opacity, 0, W);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawCells(W, e.T, e.opacity, 1, skip);
    if (separate && e.contVisible) this.drawContainer(W.child, e.U, W.innerOpacity, e.opacity, 1, W);
    if (e.child) this.drawWorld(e.child);
  }

  setCellUniforms(p, W, Td) {
    const o = Td.inv().apply(0, 0);
    const pxW = 1 / Td.scale();
    p.set('uOrigin', o).set('uRS', [Td.a, Td.b]).set('uViewport', [this.canvas.width, this.canvas.height]);
    p.set('uPx', pxW).set('uTime', W.time).set('uCount', W.count);
    p.set('uCancel', W.cancel ? [W.cancel.mother, 1] : [-1, 0]);
    p.set('uCancelSep', W.cancel ? [W.cancel.sep, W.cancel.merge] : [0, 0]);
    p.set('uContFlex', W.flex).set('uContInner', W.innerOpacity);
    p.set('uMagFade', this.magFade(pxW));
  }

  drawCells(W, T, opacity, pass, skip) {
    const gl = this.gl;
    const p = this.progs.cell.use();
    W.state.forEach((t, k) => p.tex('uS' + k, t));
    W.attrs.forEach((t, k) => p.tex('uA' + k, t));
    p.tex('uNoise', this.noise);
    setTunables(p);
    this.uploadPalettes(p);
    this.setCellUniforms(p, W, this.dev(T));
    p.set('uPass', pass).set('uOpacity', opacity).set('uSkip', skip).set('uPickXf', [1, 1, 0, 0]);
    gl.bindVertexArray(GLU.emptyVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, W.count);
  }

  // Draws the container holding world X in its exact double-precision frame. U maps X → screen (CSS px).
  // owner = the world the container cell belongs to (for its texture attributes).
  drawContainer(X, U, inner, opacity, pass, owner, backdrop) {
    const gl = this.gl;
    const Ud = this.dev(U);
    const inv = Ud.inv();
    const mb = X.memB;
    const W = this.canvas.width, H = this.canvas.height;
    const s = X.shape;
    const p = this.progs.container.use();
    p.tex('uNoise', this.noise);
    setTunables(p);
    this.uploadPalettes(p);
    const [u0x, u0y] = inv.apply(0, 0);
    p.set('uU0', [u0x / mb, u0y / mb]);
    p.set('uJ', [inv.a / mb, inv.b / mb, -inv.b / mb, inv.a / mb]);
    p.set('uViewport', [W, H]);
    p.set('uEgg', [s.aspect * (1 + s.egg), s.aspect * (1 - s.egg), 1]);
    p.set('uPalI', X.pal).set('uPass', pass).set('uInner', inner).set('uOpacity', opacity);
    const pxL = inv.scale() / mb;
    p.set('uPxL', pxL).set('uScale', mb);
    p.set('uMagFade', this.magFade(pxL * s.size));
    if (owner) {
      const a = owner.sA2;
      const tex = [a[0] + Math.cos(a[3]) * 0.004 * owner.time, a[1] + Math.sin(a[3]) * 0.004 * owner.time, a[2], 0];
      p.set('uTexP', tex);
    } else {
      p.set('uTexP', [0.3, 0.6, 1.0, 0]);
    }
    if (!backdrop) {
      const [cx, cy] = Ud.apply(0, 0);
      const r = (s.aspect * (1 + Math.abs(s.egg)) + (pass === 0 ? CFG.haloSize : 0) + 0.05) * mb * Ud.scale();
      const x0 = Math.max(0, Math.floor(W / 2 + cx - r)), x1 = Math.min(W, Math.ceil(W / 2 + cx + r));
      const y0 = Math.max(0, Math.floor(H / 2 + cy - r)), y1 = Math.min(H, Math.ceil(H / 2 + cy + r));
      if (x1 <= x0 || y1 <= y0) return;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x0, y0, x1 - x0, y1 - y0);
    }
    GLU.drawFullscreen();
    gl.disable(gl.SCISSOR_TEST);
  }

  drawParticles(W, T, opacity) {
    const gl = this.gl;
    const s = T.scale();
    const Td = this.dev(T);
    const p = this.progs.particle.use();
    const inv = T.inv();
    const [ox, oy] = inv.apply(0, 0);
    const halfDiag = Math.hypot(innerWidth, innerHeight) / 2 / s;
    const kinds = [
      { kind: 0, tile: 3, base: 3, rmin: 0.016, rmax: 0.04, fade: smoothstep(10, 24, s) },
      { kind: 1, tile: 8, base: 0.6, rmin: 0.2, rmax: 0.5, fade: smoothstep(2.5, 7, s) },
    ];
    gl.blendFunc(gl.ONE, gl.ONE);
    const pal = PALETTES[W.pal];
    for (const k of kinds) {
      if (k.fade <= 0 || CFG.particleDensity <= 0) continue;
      const mean = k.base * CFG.particleDensity;
      const perTile = Math.max(1, Math.ceil(mean));
      const prob = mean / perTile;
      const reach = halfDiag / 0.7 + k.tile;
      const tx0 = Math.floor((ox - reach) / k.tile), tx1 = Math.floor((ox + reach) / k.tile);
      const ty0 = Math.floor((oy - reach) / k.tile), ty1 = Math.floor((oy + reach) / k.tile);
      const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
      const total = nx * ny * perTile;
      if (total > 400000) continue;
      p.set('uTile0', [tx0, ty0]).set('uTilesX', nx).set('uPerTile', perTile).set('uKind', k.kind);
      p.set('uTileSize', k.tile).set('uProb', prob).set('uRMin', k.rmin).set('uRMax', k.rmax);
      p.set('uFade', k.fade).set('uSeed', W.particleSeed).set('uPx', 1 / Td.scale()).set('uTime', W.time);
      p.set('uOrigin', [ox, oy]).set('uRS', [Td.a, Td.b]).set('uViewport', [this.canvas.width, this.canvas.height]);
      p.set('uMem', [W.memB, W.memAf, W.memAb]);
      p.set('uColor', hexToRgb(pal.particle)).set('uOpacity', opacity);
      gl.bindVertexArray(GLU.emptyVAO);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, total);
    }
  }

  // ------------------------------------------------------------------ picking and splitting

  onSplitPress(x, y) {
    this.split = { t: performance.now(), x, y, result: null, requested: false, started: false };
  }

  onSplitRelease() {
    this.split = null;
    const d = this.playerDiv;
    if (d && d.state === 'hold') {
      const te = d.world.time - d.start;
      const target = Math.min(d.full, CFG.pullApartSpeed * te);
      if (target < CFG.commitFraction * d.full) {
        d.state = 'cancel';
        d.zeroT = 0;
        d.world.cancel = { mother: d.mother, sep: target, merge: 0 };
      } else {
        d.state = 'committed';
      }
    }
  }

  // Renders cell IDs at the cursor into a 1×1 target and reads it back asynchronously with a fence.
  updatePick(view, now) {
    const gl = this.gl, sp = this.split;
    if (this.pickSync) {
      const st = gl.getSyncParameter(this.pickSync, gl.SYNC_STATUS);
      if (st === gl.SIGNALED) {
        gl.deleteSync(this.pickSync);
        this.pickSync = null;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pickBuf);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pickOut);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        const req = this.pickReq;
        if (req && req.split === this.split) req.split.result = { world: req.world, index: Math.round(this.pickOut[0]) - 1 };
      }
    }
    if (sp && !sp.requested && !this.pickSync) {
      sp.requested = true;
      const entry = this.pickEntry(view);
      if (!entry) { sp.result = { world: null, index: -1 }; }
      else {
        const W = entry.world;
        const Td = this.dev(entry.T);
        const cw = this.canvas.width, ch = this.canvas.height;
        const px = sp.x * this.pxPerCss, py = ch - sp.y * this.pxPerCss;
        const cx = px / cw * 2 - 1, cy = py / ch * 2 - 1;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
        gl.viewport(0, 0, 1, 1);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const p = this.progs.cell.use();
        W.state.forEach((t, k) => p.tex('uS' + k, t));
        W.attrs.forEach((t, k) => p.tex('uA' + k, t));
        p.tex('uNoise', this.noise);
        setTunables(p);
        this.uploadPalettes(p);
        this.setCellUniforms(p, W, Td);
        const skip = (W.cont && (W.flex <= 0 || W.innerOpacity > 0.5)) ? 0 : -1;
        p.set('uPass', 2).set('uOpacity', 1).set('uSkip', skip).set('uPickXf', [cw, ch, -cx * cw, -cy * ch]);
        gl.bindVertexArray(GLU.emptyVAO);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, W.count);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pickBuf);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.pickSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        this.pickReq = { split: sp, world: W };
      }
    }
    // Start the division once the button has been held long enough.
    if (sp && !sp.started && sp.result && this.input.rightDown && now - sp.t >= CFG.holdDelay * 1000) {
      sp.started = true;
      if (sp.result.world && sp.result.index >= 0) this.startPlayerDivision(sp.result.world, sp.result.index);
    }
  }

  // Deepest visible level whose cells are at least ~6 CSS px in radius.
  pickEntry(view) {
    let best = null;
    for (const e of view.list) {
      if (e.opacity < 0.5) continue;
      if (e.T.scale() < 6) continue;
      if (!best || e.world.level < best.world.level) best = e;
    }
    return best;
  }

  startPlayerDivision(W, idx) {
    if (this.playerDiv) return;
    if (idx < 0 || idx >= W.count || W.isBusy(idx)) return;
    if (W.count >= CFG.maxPerWorld) return;
    W.divide([idx], false);
    this.playerDiv = { world: W, mother: idx, daughter: W.count - 1, start: W.time, full: W.fullSeparation(idx), state: 'hold' };
  }

  updatePlayerDivision(simDt, sims) {
    const d = this.playerDiv;
    if (!d) return;
    const W = d.world;
    const te = W.time - d.start;
    const dur = d.full / CFG.pullApartSpeed;
    if (d.state === 'hold' && te >= dur) d.state = 'committed';
    if (d.state === 'committed' && te > dur + CFG.bridgeTime + 0.1) this.playerDiv = null;
    if (d.state === 'cancel') {
      const step = sims.has(W) ? simDt : 0;
      const c = W.cancel;
      c.sep = Math.max(0, c.sep - CFG.pullApartSpeed * step);
      if (c.sep === 0) {
        d.zeroT += step;
        c.merge = smoothstep(0.1, 0.4, d.zeroT);
      }
      if (d.zeroT > 0.45 || !sims.has(W)) {
        W.removeDaughter(d.mother);
        W.cancel = null;
        this.playerDiv = null;
      }
    }
  }

  playerBlocks(W) {
    const d = this.playerDiv;
    return !!(d && d.world === W && (d.state === 'hold' || d.state === 'cancel'));
  }

  // The camera rides along with its world's expansion as the population grows.
  rideExpansion() {
    const cam = this.camera, W = cam.world;
    if (W.expandK === 1) return;
    [cam.cx, cam.cy] = W.expandPos(cam.cx, cam.cy, W.expandK);
  }

  divideAllHere() {
    const W = this.camera.world;
    if (this.playerBlocks(W)) return;
    const mothers = [];
    for (let i = 0; i < W.count; i++) if (!W.isBusy(i)) mothers.push(i);
    W.divide(mothers, true);
  }

  startStress(target) {
    this.stress = { world: this.camera.world, target };
  }

  updateStress(sims) {
    const s = this.stress;
    if (!s) return;
    const W = s.world;
    if (W.count >= Math.min(s.target, CFG.maxPerWorld)) { this.stress = null; return; }
    if (!sims.has(W) || this.playerBlocks(W)) return;
    const n = W.count;
    let budget = Math.round(n * CFG.stressFraction);
    budget = Math.max(CFG.stressMin, Math.min(CFG.stressMax, budget));
    budget = Math.min(budget, s.target - n);
    const mothers = [];
    const limit = Math.min(n, budget * 3);
    for (let k = 0; k < limit && mothers.length < budget; k++) {
      const i = W.stressCursor % n;
      W.stressCursor = (W.stressCursor + 1) % n;
      if (!W.isBusy(i)) mothers.push(i);
    }
    W.divide(mothers, true);
  }
}

window.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
