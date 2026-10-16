'use strict';
// Camera and 2-D similarity transforms, all in double precision on the CPU.

// p' = [a -b; b a] p + t  (uniform scale sqrt(a²+b²), rotation atan2(b, a)).
class Sim2 {
  constructor(a = 1, b = 0, tx = 0, ty = 0) { this.a = a; this.b = b; this.tx = tx; this.ty = ty; }

  static fromPose(cx, cy, angle, scale) {
    return new Sim2(Math.cos(angle) * scale, Math.sin(angle) * scale, cx, cy);
  }

  apply(x, y) { return [this.a * x - this.b * y + this.tx, this.b * x + this.a * y + this.ty]; }
  applyLinear(x, y) { return [this.a * x - this.b * y, this.b * x + this.a * y]; }

  // this ∘ o
  mul(o) {
    return new Sim2(
      this.a * o.a - this.b * o.b,
      this.a * o.b + this.b * o.a,
      this.a * o.tx - this.b * o.ty + this.tx,
      this.b * o.tx + this.a * o.ty + this.ty);
  }

  inv() {
    const s2 = this.a * this.a + this.b * this.b;
    const a = this.a / s2, b = -this.b / s2;
    return new Sim2(a, b, -(a * this.tx - b * this.ty), -(b * this.tx + a * this.ty));
  }

  scale() { return Math.hypot(this.a, this.b); }
  angle() { return Math.atan2(this.b, this.a); }
}

// Fractional power of the motion old→new about the old centre: rotation, scale and translation scaled by f.
function partialMotion(cOldX, cOldY, cNewX, cNewY, dAngle, scaleRatio, f) {
  const ang = dAngle * f;
  const s = Math.pow(scaleRatio, f);
  const a = Math.cos(ang) * s, b = Math.sin(ang) * s;
  const px = cOldX + f * (cNewX - cOldX), py = cOldY + f * (cNewY - cOldY);
  return new Sim2(a, b, px - (a * cOldX - b * cOldY), py - (b * cOldX + a * cOldY));
}

function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Signed distance to an egg (two half-ellipses sharing the minor axis), axis-aligned, front at +x.
// Returns [distance, nx, ny] with the outward normal.
function sdEggCPU(px, py, af, ab, b) {
  const a = px >= 0 ? af : ab;
  const sx = px >= 0 ? 1 : -1, sy = py >= 0 ? 1 : -1;
  const qx = Math.abs(px), qy = Math.abs(py);
  if (a - b < 1e-9 * b) {
    const l = Math.hypot(qx, qy);
    return [l - b, l > 0 ? sx * qx / l : 0, l > 0 ? sy * qy / l : 1];
  }
  const wx = a * (qx - a), wy = b * (qy - b);
  let cx = wx < wy ? 0.01 : 1, cy = wx < wy ? 1 : 0.01;
  let l = Math.hypot(cx, cy); cx /= l; cy /= l;
  for (let i = 0; i < 8; i++) {
    const ux = a * cx, uy = b * cy;
    const vx = -a * cy, vy = b * cx;
    const aa = (qx - ux) * vx + (qy - uy) * vy;
    const cc = (qx - ux) * ux + (qy - uy) * uy + vx * vx + vy * vy;
    if (cc < 1e-12 * a * a) break;
    const bb = Math.sqrt(Math.max(cc * cc - aa * aa, 0));
    const ncx = (cx * bb - cy * aa) / cc, ncy = (cy * bb + cx * aa) / cc;
    cx = ncx; cy = ncy;
  }
  cx = Math.max(cx, 0); cy = Math.max(cy, 0);
  l = Math.hypot(cx, cy) || 1; cx /= l; cy /= l;
  let d = Math.hypot(qx - a * cx, qy - b * cy);
  if ((qx / a) * (qx / a) + (qy / b) * (qy / b) < 1) d = -d;
  let nx = cx / a, ny = cy / b;
  l = Math.hypot(nx, ny) || 1;
  return [d, sx * nx / l, sy * ny / l];
}

// The camera lives in exactly one world's frame: view centre, log of pixels per unit, screen rotation.
class Camera {
  constructor(world) {
    this.world = world;
    this.cx = 0; this.cy = 0;
    this.logScale = 0;
    this.rot = 0;
  }

  get scale() { return Math.exp(this.logScale); }

  // world → screen (device px, origin at the view centre, y up)
  toScreen() {
    const s = this.scale;
    const a = Math.cos(this.rot) * s, b = Math.sin(this.rot) * s;
    return new Sim2(a, b, -(a * this.cx - b * this.cy), -(b * this.cx + a * this.cy));
  }

  // screen → world
  pose() { return this.toScreen().inv(); }

  setFromPose(q) {
    const c = q.inv();
    this.logScale = Math.log(c.scale());
    this.rot = wrapAngle(c.angle());
    this.cx = q.tx; this.cy = q.ty;
  }

  screenToWorld(sx, sy) { return this.pose().apply(sx, sy); }

  // Pans by a screen-space delta in device px (content follows the pointer).
  pan(dx, dy) {
    const q = this.pose();
    const [wx, wy] = q.applyLinear(-dx, -dy);
    this.cx += wx; this.cy += wy;
  }

  // Zooms by dLog around the screen point (sx, sy), keeping that world point under it.
  zoomAt(dLog, sx, sy) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    const k = Math.exp(-dLog);
    this.logScale += dLog;
    this.cx = wx + (this.cx - wx) * k;
    this.cy = wy + (this.cy - wy) * k;
  }
}
