'use strict';
// A world: one level of nesting, its population, GPU state and solver.

const TEX_W = 512;
const FLAG_CONT = 16, FLAG_MOTHER = 32, FLAG_AUTO = 64, FLAG_RELEASED = 128;

// Uniform names for every tunable, e.g. wanderSpeed -> uWanderSpeed.
const TUNABLE_UNIFORMS = Object.keys(CFG).map(k => ['u' + k[0].toUpperCase() + k.slice(1), k]);

function setTunables(prog) {
  if (!prog.tunables) prog.tunables = TUNABLE_UNIFORMS.filter(([u]) => prog.has(u));
  for (const [u, k] of prog.tunables) prog.set(u, CFG[k]);
}

function rand(a, b) { return a + Math.random() * (b - a); }

// Deterministic hash of a float seed for the CPU-side container wander.
function hashJS(seed, k) {
  const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// Largest reach of any cell from its centre, in radii (stretch cap, egg and ripple included).
function maxCellReach() {
  return (Math.sqrt(CFG.aspectMax * CFG.maxAspect) * (1 + CFG.eggVar) + 0.05) * (1 + CFG.sizeVar);
}

function randomShape() {
  return {
    size: 1 + rand(-1, 1) * CFG.sizeVar,
    aspect: rand(CFG.aspectMin, CFG.aspectMax),
    egg: rand(-1, 1) * CFG.eggVar,
  };
}

// The shared depth-peeled grid: 12 layers packed into the channels of three RGBA32F textures.
class Grid {
  constructor(gl) { this.gl = gl; this.w = 0; this.h = 0; this.tex = []; this.fbos = []; }

  ensure(w, h) {
    if (w <= this.w && h <= this.h) return;
    const gl = this.gl;
    w = Math.max(w, this.w); h = Math.max(h, this.h);
    this.tex.forEach(t => gl.deleteTexture(t));
    this.fbos.forEach(f => gl.deleteFramebuffer(f));
    if (this.depth) gl.deleteRenderbuffer(this.depth);
    this.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    this.tex = [0, 1, 2].map(() => GLU.floatTex(w, h));
    this.fbos = this.tex.map(t => GLU.fbo([t], this.depth));
    this.w = w; this.h = h;
  }
}

class World {
  constructor(app, level, shape) {
    this.app = app;
    this.gl = app.gl;
    this.level = level;
    this.pal = paletteForLevel(level);
    this.shape = shape;              // shape of the container cell that holds this world
    this.parent = null;
    this.child = null;
    this.time = 0;
    this.count = 0;
    this.rows = 0;
    this.cur = 0;
    this.bornStart = Infinity;
    this.cancel = null;
    this.cont = null;                // CPU state of this world's container cell (index 0)
    this.contPoses = [];
    this.capacity = CFG.capacity;
    this.memB = membraneRadius(this.capacity, shape.aspect);
    this.memBTarget = this.memB;
    this.flex = 1;
    this.innerOpacity = 0;
    this.particleSeed = Math.random();
    this.stressCursor = 0;
    this.colonyR = 0;               // smoothed natural radius the colony has expanded to
    this.expandK = 1;               // this frame's expansion factor
    this.expandSub = 1;             // per substep
    this.updateMembrane();
  }

  // Membrane = container outline scaled up; semi-minor memB, front/back semi-major.
  updateMembrane() {
    const s = this.shape;
    this.memAf = this.memB * s.aspect * (1 + s.egg);
    this.memAb = this.memB * s.aspect * (1 - s.egg);
    this.S = this.memB / s.size;
  }

  naturalRadius(n) { return membraneRadius(Math.max(n, 1), this.shape.aspect); }

  // ------------------------------------------------------------------ GPU storage

  allocState(rows) {
    const gl = this.gl;
    const old = this.allocated ? { sets: this.sets, fbos: this.fbos, cur: this.cur, rows: this.rows } : null;
    this.sets = [0, 1].map(() => [0, 1, 2, 3].map(() => GLU.floatTex(TEX_W, rows)));
    this.fbos = this.sets.map(set => GLU.fbo(set));
    this.attrs = [0, 1, 2].map(() => GLU.floatTex(TEX_W, rows));
    const n = rows * TEX_W * 4;
    const grow = (arr) => { const a = new Float32Array(n); if (arr) a.set(arr.subarray(0, Math.min(arr.length, n))); return a; };
    this.sA0 = grow(this.sA0); this.sA1 = grow(this.sA1); this.sA2 = grow(this.sA2);
    this.rows = rows;
    this.allocated = true;
    if (old) {
      // Copy the old dynamic state on the GPU into the new, taller textures.
      this.cur = 0;
      const p = this.app.progs.birth.use();
      old.sets[old.cur].forEach((t, k) => p.tex('uS' + k, t));
      p.tex('uA0', this.attrs[0]).tex('uA1', this.attrs[1]);
      p.set('uCount', this.count).set('uBornStart', this.count);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[0]);
      gl.viewport(0, 0, TEX_W, rows);
      GLU.drawFullscreen();
      old.sets.flat().forEach(t => gl.deleteTexture(t));
      old.fbos.forEach(f => gl.deleteFramebuffer(f));
    }
    this.uploadAttrRows(0, rows);
  }

  ensureCapacity(n) {
    let rows = Math.max(this.rows, 1);
    while (rows * TEX_W < n) rows *= 2;
    if (rows !== this.rows) this.allocState(rows);
  }

  uploadAttrRows(r0, r1) {
    if (r1 <= r0) return;
    const gl = this.gl;
    const off = r0 * TEX_W * 4, len = (r1 - r0) * TEX_W * 4;
    [this.sA0, this.sA1, this.sA2].forEach((arr, k) => {
      gl.bindTexture(gl.TEXTURE_2D, this.attrs[k]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r0, TEX_W, r1 - r0, gl.RGBA, gl.FLOAT, arr.subarray(off, off + len));
    });
  }

  uploadAttrIndexRange(i0, i1) {
    if (i1 <= i0) return;
    this.uploadAttrRows(Math.floor(i0 / TEX_W), Math.floor((i1 - 1) / TEX_W) + 1);
  }

  get state() { return this.sets[this.cur]; }

  // ------------------------------------------------------------------ Population

  // Places the colony by random non-overlapping sampling, container pinned at the centre, then relaxes.
  populate(n, childShape) {
    const cells = [];
    if (childShape) {
      cells.push({ x: 0, y: 0, th: rand(-Math.PI, Math.PI), size: childShape.size, aspect: childShape.aspect,
        egg: childShape.egg, cont: true });
    }
    let R = this.naturalRadius(n) * 1.1;
    let fails = 0;
    while (cells.length < n) {
      const s = randomShape();
      const r = R * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
      const c = { x: r * Math.cos(a), y: r * Math.sin(a), th: rand(-Math.PI, Math.PI), size: s.size, aspect: s.aspect, egg: s.egg };
      c.circles = eggCircles(c);
      if (cells.some(o => eggsOverlap(c, o))) {
        if (++fails > 400) { R *= 1.05; fails = 0; }
        continue;
      }
      fails = 0;
      cells.push(c);
    }
    this.count = n;
    this.colonyR = this.naturalRadius(n);
    this.ensureCapacity(n);
    const st = [0, 1, 2, 3].map(() => new Float32Array(this.rows * TEX_W * 4));
    cells.forEach((c, i) => {
      const o = i * 4;
      st[0].set([c.x, c.y, 0, 0], o);
      st[1].set([c.th, 0, 0, 0], o);
      const flags = c.cont ? (paletteForLevel(this.level - 1) | FLAG_CONT) : this.pal;
      this.sA0.set([c.size, c.aspect, c.egg, Math.random()], o);
      this.sA1.set([flags, -1, -1000, Math.random()], o);
      this.sA2.set([Math.random(), Math.random(), Math.random() * Math.PI * 2, Math.random() * Math.PI * 2], o);
    });
    const gl = this.gl;
    for (let k = 0; k < 4; k++) {
      gl.bindTexture(gl.TEXTURE_2D, this.state[k]);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, this.rows, gl.RGBA, gl.FLOAT, st[k]);
    }
    this.uploadAttrRows(0, this.rows);
    if (childShape) {
      const c = cells[0];
      this.cont = { x: 0, y: 0, vx: 0, vy: 0, th: c.th, om: 0, seed: Math.random(), size: c.size, aspect: c.aspect, egg: c.egg };
      this.contPoses = [];
      this.contOld = this.contPose();
      this.contNew = this.contPose();
    }
    // Relax any remaining overlaps before the first frame.
    for (let k = 0; k < 6; k++) this.simulate(1 / 60, true, 4);
  }

  contPose() {
    const c = this.cont;
    return c ? { x: c.x, y: c.y, th: c.th } : null;
  }

  // Similarity child-world → this-world for the container (its centre, long axis, 1/S scale).
  childTransform(pose) {
    const p = pose || this.contPose();
    const child = this.child;
    const s = 1 / child.S;
    return new Sim2(Math.cos(p.th) * s, Math.sin(p.th) * s, p.x, p.y);
  }

  // ------------------------------------------------------------------ Divisions

  partnerOf(i) {
    const p = Math.round(this.sA1[i * 4 + 1]);
    if (p < 0 || p >= this.count) return -1;
    return Math.round(this.sA1[p * 4 + 1]) === i ? p : -1;
  }

  divisionDuration(i) {
    const f = Math.round(this.sA1[i * 4]);
    if (f & FLAG_AUTO) return CFG.autoSplitTime;
    return this.fullSeparation(i) / CFG.pullApartSpeed;
  }

  fullSeparation(i) { return (2 * this.sA0[i * 4 + 1] + CFG.splitGap) * this.sA0[i * 4]; }

  isBusy(i) {
    const f = Math.round(this.sA1[i * 4]);
    if (f & FLAG_CONT) return true;
    const p = this.partnerOf(i);
    if (p < 0) return false;
    const te = this.time - this.sA1[i * 4 + 2];
    // A little per-cell jitter keeps automatic splits from firing in synchronized waves.
    return te < this.divisionDuration(i) + CFG.bridgeTime + 0.25 + 0.6 * this.sA1[i * 4 + 3];
  }

  // Creates one daughter per mother; she is born on the GPU on top of her mother.
  divide(mothers, auto) {
    if (!mothers.length) return 0;
    const room = CFG.maxPerWorld - this.count;
    if (room <= 0) return 0;
    if (mothers.length > room) mothers = mothers.slice(0, room);
    const t = this.time;
    const first = this.count;
    this.ensureCapacity(this.count + mothers.length);
    const A0 = this.sA0, A1 = this.sA1, A2 = this.sA2;
    let mMin = Infinity, mMax = -1;
    for (const m of mothers) {
      const d = this.count++;
      const mo = m * 4, o = d * 4;
      const pal = Math.round(A1[mo]) & 15;
      A0[o] = A0[mo]; A0[o + 1] = A0[mo + 1]; A0[o + 2] = A0[mo + 2]; A0[o + 3] = Math.random();
      A1[o] = pal | (auto ? FLAG_AUTO : 0); A1[o + 1] = m; A1[o + 2] = t; A1[o + 3] = Math.random();
      const dm = A2[mo + 3], dd = Math.random() * Math.PI * 2;
      let ox = A2[mo] + (Math.cos(dm) - Math.cos(dd)) * 0.004 * t;
      let oy = A2[mo + 1] + (Math.sin(dm) - Math.sin(dd)) * 0.004 * t;
      ox -= Math.floor(ox); oy -= Math.floor(oy);
      A2[o] = ox; A2[o + 1] = oy; A2[o + 2] = A2[mo + 2]; A2[o + 3] = dd;
      A1[mo] = pal | FLAG_MOTHER | (auto ? FLAG_AUTO : 0); A1[mo + 1] = d; A1[mo + 2] = t;
      if (m < mMin) mMin = m;
      if (m > mMax) mMax = m;
    }
    this.bornStart = Math.min(this.bornStart, first);
    this.uploadAttrIndexRange(mMin, mMax + 1);
    this.uploadAttrIndexRange(first, this.count);
    return mothers.length;
  }

  // Removes the newest cell (a cancelled daughter) and lets her mother's membrane relax again.
  removeDaughter(mother) {
    this.count--;
    const mo = mother * 4;
    this.sA1[mo] = (Math.round(this.sA1[mo]) & 15) | FLAG_RELEASED;
    this.sA1[mo + 1] = -1;
    this.sA1[mo + 2] = this.time;
    this.uploadAttrIndexRange(mother, mother + 1);
  }

  // ------------------------------------------------------------------ CPU container

  stepContainer(dt) {
    this.contOld = this.contPose();
    this.contPoses.length = 0;
    // The membrane grows smoothly only if the colony outgrows it.
    if (this.count > this.capacity * 0.97) {
      this.capacity = Math.ceil(this.count * 1.25);
      this.memBTarget = membraneRadius(this.capacity, this.shape.aspect);
    }
    if (this.memB !== this.memBTarget) {
      this.memB += (this.memBTarget - this.memB) * (1 - Math.exp(-dt / 0.6));
      if (Math.abs(this.memB - this.memBTarget) < 1e-6 * this.memBTarget) this.memB = this.memBTarget;
      this.updateMembrane();
    }
    // The colony expands outward smoothly with its population, so new cells find room everywhere.
    const target = this.naturalRadius(this.count);
    const n = Math.max(1, Math.round(CFG.iterations));
    if (target > this.colonyR) {
      const R1 = this.colonyR + (target - this.colonyR) * (1 - Math.exp(-dt / CFG.expandTime));
      this.expandK = R1 / this.colonyR;
      this.colonyR = R1;
    } else {
      this.expandK = 1;
      this.colonyR = target;
    }
    this.expandSub = Math.pow(this.expandK, 1 / n);
    const c = this.cont;
    if (!c) return;
    const sdt = dt / n;
    const R = this.colonyR, fade = this.pullFade();
    for (let k = 0; k < n; k++) {
      const t = this.time + (k + 1) * sdt;
      [c.x, c.y] = this.expandPos(c.x, c.y, this.expandSub);
      const x0 = c.x, y0 = c.y, th0 = c.th;
      const s = c.seed;
      const h = (q) => hashJS(s, q);
      const ang = 2 * Math.PI * h(1) + (h(5) - 0.5) * 0.25 * t + CFG.turnRate * (
        Math.sin((0.10 + 0.07 * h(2)) * t + 2 * Math.PI * h(6)) +
        0.55 * Math.sin((0.21 + 0.12 * h(3)) * t + 2 * Math.PI * h(7)) +
        0.3 * Math.sin((0.43 + 0.2 * h(4)) * t + 2 * Math.PI * h(8)));
      const spd = CFG.wanderSpeed * (0.72 + 0.17 * Math.sin((0.17 + 0.1 * h(9)) * t + 2 * Math.PI * h(10)) +
        0.11 * Math.sin((0.37 + 0.15 * h(10)) * t + 2 * Math.PI * h(9)));
      let vdx = Math.cos(ang) * spd, vdy = Math.sin(ang) * spd;
      const r = Math.hypot(c.x / (c.x >= 0 ? this.memAf : this.memAb), c.y / this.memB) * this.memB;
      const r0 = 0.25 * CFG.colonySize * R, r1 = CFG.colonySize * R;
      const lp = Math.hypot(c.x, c.y);
      if (lp > 1e-4) {
        const pull = CFG.wanderSpeed * Math.max(r - r0, 0) / Math.max(r1 - r0, 1e-3) * fade;
        vdx -= c.x / lp * pull; vdy -= c.y / lp * pull;
      }
      const ks = 1 - Math.exp(-CFG.steering * sdt), kd = Math.exp(-CFG.linDamping * sdt);
      c.vx = (c.vx + (vdx - c.vx) * ks) * kd;
      c.vy = (c.vy + (vdy - c.vy) * ks) * kd;
      const sp = Math.hypot(c.vx, c.vy);
      let torque = CFG.wanderTorque * (0.6 * Math.sin((0.23 + 0.2 * h(11)) * t + 2 * Math.PI * h(12)) +
        0.4 * Math.sin((0.61 + 0.3 * h(13)) * t + 2 * Math.PI * h(11))) - CFG.angDamping * c.om;
      if (sp > 1e-4) torque += CFG.alignStrength * Math.min(sp / Math.max(CFG.wanderSpeed, 1e-3), 1) * Math.sin(Math.atan2(c.vy, c.vx) - c.th);
      c.om += torque * sdt;
      c.x += c.vx * sdt; c.y += c.vy * sdt; c.th += c.om * sdt;
      // Kept inside the membrane like any other cell.
      const ext = c.size * c.aspect * (1 + Math.abs(c.egg));
      const [md, nx, ny] = sdEggCPU(c.x, c.y, this.memAf, this.memAb, this.memB);
      const lim = -CFG.membraneKeep * this.memB - ext;
      if (md > lim) { c.x -= nx * (md - lim); c.y -= ny * (md - lim); }
      c.vx = (c.x - x0) / sdt; c.vy = (c.y - y0) / sdt;
      const vl = Math.hypot(c.vx, c.vy);
      if (vl > CFG.maxSpeed) { c.vx *= CFG.maxSpeed / vl; c.vy *= CFG.maxSpeed / vl; }
      c.om = Math.max(-CFG.maxSpin, Math.min(CFG.maxSpin, wrapAngle(c.th - th0) / sdt));
      c.th = wrapAngle(c.th);
      this.contPoses.push([c.x, c.y, c.th, c.vx, c.vy, c.om]);
    }
    this.contNew = this.contPose();
  }

  pullFade() { return 1 - smoothstep(0.35, 1.0, this.count / this.capacity); }

  // Homologous expansion about the colony centre, fading out toward the membrane so nothing is driven
  // into it. Mirrors expandPos() in the solver.
  expandPos(x, y, k) {
    if (k === 1) return [x, y];
    const rho = Math.hypot(x / (x >= 0 ? this.memAf : this.memAb), y / this.memB);
    const f = 1 + (k - 1) * (1 - smoothstep(CFG.expandTaper[0], CFG.expandTaper[1], rho));
    return [x * f, y * f];
  }

  // ------------------------------------------------------------------ GPU simulation

  gridParams() {
    const cell = 2 * maxCellReach() + 0.3;
    const pad = cell;
    const ox = -this.memAb - pad, oy = -this.memB - pad;
    const w = Math.ceil((this.memAf + this.memAb + 2 * pad) / cell);
    const h = Math.ceil((2 * this.memB + 2 * pad) / cell);
    return { cell, ox, oy, w, h };
  }

  buildGrid(gp) {
    const gl = this.gl, grid = this.app.grid;
    grid.ensure(gp.w, gp.h);
    gl.clearColor(-1, -1, -1, -1);
    for (const f of grid.fbos) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.colorMask(true, true, true, true);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.viewport(0, 0, gp.w, gp.h);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.clearDepth(1);
    const p = this.app.progs.grid.use();
    p.tex('uS0', this.state[0]);
    p.set('uGridOrigin', [gp.ox, gp.oy]).set('uGridCell', gp.cell).set('uGridSize', [gp.w, gp.h]);
    gl.bindVertexArray(GLU.emptyVAO);
    const layers = Math.min(12, CFG.gridLayers);
    for (let k = 0; k < layers; k++) {
      const ti = k % 3, ch = Math.floor(k / 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, grid.fbos[ti]);
      gl.colorMask(ch === 0, ch === 1, ch === 2, ch === 3);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      p.set('uLayer', k);
      p.units = 1;
      // Layer k-1 always lives in a different texture than layer k, so there is no feedback loop.
      p.tex('uPrev', k > 0 ? grid.tex[(k - 1) % 3] : this.state[0]);
      p.set('uPrevChan', k > 0 ? Math.floor((k - 1) / 3) : 0);
      gl.drawArrays(gl.POINTS, 0, this.count);
    }
    gl.colorMask(true, true, true, true);
    gl.disable(gl.DEPTH_TEST);
  }

  // Births, grid, then position-based substeps. relax = remove overlaps only (before the first frame).
  simulate(dt, relax, relaxIters) {
    const gl = this.gl, app = this.app;
    const rowsUsed = Math.ceil(this.count / TEX_W);
    if (this.bornStart < this.count) {
      const p = app.progs.birth.use();
      this.state.forEach((t, k) => p.tex('uS' + k, t));
      p.tex('uA0', this.attrs[0]).tex('uA1', this.attrs[1]);
      p.set('uCount', this.count).set('uBornStart', this.bornStart);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[1 - this.cur]);
      gl.viewport(0, 0, TEX_W, rowsUsed);
      GLU.drawFullscreen();
      this.cur = 1 - this.cur;
    }
    this.bornStart = Infinity;
    const gp = this.gridParams();
    this.buildGrid(gp);
    const iters = relax ? relaxIters : Math.max(1, Math.round(CFG.iterations));
    const sdt = dt / iters;
    const p = app.progs.solver.use();
    setTunables(p);
    p.set('uMaxStretch', CFG.maxStretch);
    p.set('uLayers', Math.min(12, CFG.gridLayers));
    p.set('uGridOrigin', [gp.ox, gp.oy]).set('uGridCell', gp.cell).set('uGridSize', [gp.w, gp.h]);
    p.set('uCount', this.count).set('uRelax', relax ? 1 : 0);
    p.set('uMem', [this.memB, this.memAf, this.memAb, CFG.membraneKeep]);
    p.set('uColony', [this.colonyR || this.naturalRadius(this.count), CFG.colonySize, this.pullFade(), 0]);
    p.set('uExpandTaper', CFG.expandTaper);
    const ksub = relax ? 1 : this.expandSub;
    p.set('uExpand', ksub);
    p.set('uCancel', this.cancel ? [this.cancel.mother, 1] : [-1, 0]);
    p.set('uCancelSep', this.cancel ? [this.cancel.sep, this.cancel.merge] : [0, 0]);
    p.set('uDt', sdt);
    const grid = app.grid;
    for (let k = 0; k < iters; k++) {
      p.units = 0;
      this.state.forEach((t, q) => p.tex('uS' + q, t));
      this.attrs.forEach((t, q) => p.tex('uA' + q, t));
      grid.tex.forEach((t, q) => p.tex('uG' + q, t));
      p.set('uTime', this.time + (relax ? 0 : (k + 1) * sdt));
      p.set('uGridK', Math.pow(ksub, k + 1));
      const cp = this.cont && ((relax || !this.contPoses.length) ? [this.cont.x, this.cont.y, this.cont.th, 0, 0, 0]
        : this.contPoses[Math.min(k, this.contPoses.length - 1)]);
      if (cp) {
        p.set('uCont', [cp[0], cp[1], cp[2], this.flex]);
        p.set('uContVel', [cp[3], cp[4], cp[5], 0]);
      } else {
        p.set('uCont', [0, 0, 0, 1]).set('uContVel', [0, 0, 0, 0]);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[1 - this.cur]);
      gl.viewport(0, 0, TEX_W, rowsUsed);
      GLU.drawFullscreen();
      this.cur = 1 - this.cur;
    }
    if (!relax) this.time += dt;
  }
}

// Conservative overlap test for initial placement: each egg as a chain of inscribed circles.
function eggCircles(c) {
  const A = c.size * c.aspect, af = A * (1 + c.egg), ab = A * (1 - c.egg), b = c.size;
  const xf = af - b * b / af, xb = ab - b * b / ab;
  const out = [];
  const cs = Math.cos(c.th), sn = Math.sin(c.th);
  for (let k = 0; k <= 12; k++) {
    const x = -xb + (xf + xb) * k / 12;
    const a = x >= 0 ? af : ab;
    const r = b * Math.sqrt(Math.max(0, 1 - x * x / (a * a - b * b)));
    out.push([c.x + cs * x, c.y + sn * x, r * 1.06 + 0.04]);
  }
  c.reach = Math.max(af, ab) * 1.06 + 0.04;
  return out;
}

function eggsOverlap(c, o) {
  if (!o.circles) o.circles = eggCircles(o);
  if (Math.hypot(c.x - o.x, c.y - o.y) > c.reach + o.reach) return false;
  for (const p of c.circles) {
    for (const q of o.circles) {
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < p[2] + q[2]) return true;
    }
  }
  return false;
}
