'use strict';
// GLSL ES 3.00 shader sources, assembled from shared chunks.

const SH = {};

SH.header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

// Hashing, rotations and small helpers.
SH.math = `
const float PI = 3.14159265359;
const float TAU = 6.28318530718;

uint hashU(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float hash1(float seed, float k) {
  uint h = hashU(floatBitsToUint(seed) ^ hashU(uint(k) * 0x9E3779B9u + 0x632BE5ABu));
  return float(h >> 8u) * (1.0 / 16777216.0);
}
float urand(inout uint h) {
  h = hashU(h + 0x9E3779B9u);
  return float(h >> 8u) * (1.0 / 16777216.0);
}
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
vec2 perp(vec2 v) { return vec2(-v.y, v.x); }
float cross2(vec2 a, vec2 b) { return a.x * b.y - a.y * b.x; }
float wrapAng(float a) { return a - TAU * floor((a + PI) / TAU); }
float angDiff(float a, float b) { return wrapAng(a - b); }
float smin(float a, float b, float k) {
  if (k <= 1e-6) return min(a, b);
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h);
}
`;

// Shape model: area-preserving stretch exp(D), refit along principal axes, exact egg distances.
SH.shape = `
mat2 expSym(vec2 D) {
  float l = length(D);
  float ch = cosh(l);
  float sh = l > 1e-6 ? sinh(l) / l : 1.0;
  return mat2(ch + sh * D.x, sh * D.y, sh * D.y, ch - sh * D.x);
}

struct Egg { vec2 c; vec2 ax; float af; float ab; float b; };

// Stretches the base ellipse by exp(D) (body frame), refits it along its principal axes and keeps the
// egg asymmetry on the long axis, fading it out as the shape becomes round.
Egg makeEgg(vec2 c, float th, vec2 D, float size, float aspect, float egg, out mat2 toMat) {
  float A = size * aspect, B = size;
  mat2 F = expSym(D);
  mat2 S = F * mat2(A * A, 0.0, 0.0, B * B) * F;
  float x = S[0][0], y = S[0][1], z = S[1][1];
  float m = 0.5 * (x + z);
  float df = sqrt(0.25 * (x - z) * (x - z) + y * y);
  float s1 = sqrt(m + df), s2 = sqrt(max(m - df, 1e-10));
  vec2 e1 = vec2(1.0, 0.0);
  if (df > 1e-6 * m) { float ph = 0.5 * atan(2.0 * y, x - z); e1 = vec2(cos(ph), sin(ph)); }
  if (dot(e1, F[0]) < 0.0) e1 = -e1;
  float ep = egg * clamp((1.0 - s2 / s1) / 0.2, 0.0, 1.0);
  mat2 R = rot2(th);
  Egg E;
  E.c = c;
  E.ax = R * e1;
  E.af = s1 * (1.0 + ep);
  E.ab = s1 * (1.0 - ep);
  E.b = s2;
  toMat = expSym(-D) * transpose(R);
  return E;
}

// Aspect ratio of the refitted shape for a given deformation.
float stretchedAspect(vec2 D, float aspect) {
  mat2 F = expSym(D);
  mat2 S = F * mat2(aspect * aspect, 0.0, 0.0, 1.0) * F;
  float x = S[0][0], y = S[0][1], z = S[1][1];
  float m = 0.5 * (x + z);
  float df = sqrt(0.25 * (x - z) * (x - z) + y * y);
  return sqrt((m + df) / max(m - df, 1e-10));
}

// Exact signed distance to an egg (two half-ellipses sharing the minor axis), with outward normal.
// p is in the egg frame: x along the long axis, front half at x >= 0.
vec3 sdEggN(vec2 p, float af, float ab, float b) {
  float a = p.x >= 0.0 ? af : ab;
  vec2 sg = vec2(p.x >= 0.0 ? 1.0 : -1.0, p.y >= 0.0 ? 1.0 : -1.0);
  vec2 q = abs(p);
  if (a - b < 1e-4 * b) {
    float l = length(q);
    return vec3(l - b, (l > 1e-9 ? q / l : vec2(0.0, 1.0)) * sg);
  }
  vec2 e = vec2(a, b);
  vec2 w = e * (q - e);
  vec2 cs = normalize(w.x < w.y ? vec2(0.01, 1.0) : vec2(1.0, 0.01));
  for (int i = 0; i < 4; i++) {
    vec2 u = e * cs;
    vec2 v = e * vec2(-cs.y, cs.x);
    float aa = dot(q - u, v);
    float cc = dot(q - u, u) + dot(v, v);
    if (cc < 1e-9 * a * a) break;
    float bb = sqrt(max(cc * cc - aa * aa, 0.0));
    cs = vec2(cs.x * bb - cs.y * aa, cs.y * bb + cs.x * aa) / cc;
  }
  cs = normalize(max(cs, vec2(0.0)) + 1e-9);
  vec2 cp = e * cs;
  float d = length(q - cp);
  if (dot(q / e, q / e) < 1.0) d = -d;
  return vec3(d, normalize(cs / e) * sg);
}
float sdEgg(vec2 p, float af, float ab, float b) { return sdEggN(p, af, ab, b).x; }

vec2 toEggFrame(vec2 pw, Egg E) { vec2 r = pw - E.c; return vec2(dot(r, E.ax), dot(r, perp(E.ax))); }
float eggDist(vec2 pw, Egg E) { return sdEgg(toEggFrame(pw, E), E.af, E.ab, E.b); }
vec3 eggDistN(vec2 pw, Egg E) {
  vec3 r = sdEggN(toEggFrame(pw, E), E.af, E.ab, E.b);
  return vec3(r.x, r.y * E.ax + r.z * perp(E.ax));
}

// Radius of the circle inscribed in the egg, centred on its long axis at offset x.
float inscR(float x, Egg E) {
  float a = x >= 0.0 ? E.af : E.ab;
  float k = a * a - E.b * E.b;
  if (k < 1e-6) return E.b;
  return E.b * sqrt(max(1.0 - x * x / k, 0.0));
}
float axisEnd(float a, float b) { return a > b ? a - b * b / a : 0.0; }
float sepAt(float x, Egg Ei, Egg Ej) { return eggDist(Ei.c + Ei.ax * x, Ej) - inscR(x, Ei); }

// Separation between two eggs: minimum over the inscribed circles of Ei of the distance from the circle's
// centre to Ej minus its radius. Convex along the axis: golden-section search plus an endpoint check.
vec2 eggSeparation(Egg Ei, Egg Ej) {
  float xa = -axisEnd(Ei.ab, Ei.b), xb = axisEnd(Ei.af, Ei.b);
  float lo = xa, hi = xb;
  const float G = 0.6180339887;
  float x1 = hi - G * (hi - lo), x2 = lo + G * (hi - lo);
  float f1 = sepAt(x1, Ei, Ej), f2 = sepAt(x2, Ei, Ej);
  for (int k = 0; k < 7; k++) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - G * (hi - lo); f1 = sepAt(x1, Ei, Ej); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + G * (hi - lo); f2 = sepAt(x2, Ei, Ej); }
  }
  vec2 best = f1 < f2 ? vec2(x1, f1) : vec2(x2, f2);
  float fa = sepAt(xa, Ei, Ej);
  if (fa < best.y) best = vec2(xa, fa);
  float fb = sepAt(xb, Ei, Ej);
  if (fb < best.y) best = vec2(xb, fb);
  return best;
}
`;

// Ripple waves with 2, 3 and 4 lobes; per-wave speed, direction and slow breathing.
SH.ripple = `
uniform float uRippleStrength, uRippleSpeed;
vec2 rippleWave(float seed, float t, float k, float w) {
  float h1 = hash1(seed, 11.0 + k), h2 = hash1(seed, 21.0 + k), h3 = hash1(seed, 31.0 + k);
  float h4 = hash1(seed, 41.0 + k), h5 = hash1(seed, 51.0 + k);
  float spd = uRippleSpeed * (0.12 + 0.26 * h1) * (h2 < 0.5 ? -1.0 : 1.0);
  float br = 0.6 + 0.4 * sin(t * (0.05 + 0.11 * h4) * (0.4 + 0.6 * uRippleSpeed) + TAU * h5);
  return vec2(TAU * h3 + spd * t, w * br);
}
void rippleParams(float seed, float t, out vec3 ph, out vec3 amp) {
  vec2 a = rippleWave(seed, t, 0.0, 0.5);
  vec2 b = rippleWave(seed, t, 1.0, 0.31);
  vec2 c = rippleWave(seed, t, 2.0, 0.19);
  ph = vec3(a.x, b.x, c.x);
  amp = vec3(a.y, b.y, c.y);
}
float rippleAt(float ang, vec3 ph, vec3 amp) {
  return amp.x * sin(2.0 * ang + ph.x) + amp.y * sin(3.0 * ang + ph.y) + amp.z * sin(4.0 * ang + ph.z);
}
`;

// Division state, derived from static attributes and time. Requires uA1 to be declared.
SH.division = `
uniform int uCount;
uniform ivec2 uCancel;
uniform vec2 uCancelSep;
uniform float uPullApartSpeed, uSplitGap, uTautTime, uBridgeTime, uAutoSplitTime;

vec4 fetch(sampler2D s, int i) { return texelFetch(s, ivec2(i & 511, i >> 9), 0); }

struct Div {
  int partner; bool mother; bool live; bool constrained; bool cancel;
  float target; float full; float f; float tau; float bridge; float merge; float te; float dur;
};

Div divInfo(int i, vec4 a0, vec4 a1, float t) {
  Div D;
  D.partner = -1; D.mother = false; D.live = false; D.constrained = false; D.cancel = false;
  D.target = 0.0; D.full = 1.0; D.f = 0.0; D.tau = 0.0; D.bridge = 0.0; D.merge = 0.0; D.te = 1e6; D.dur = 1.0;
  int fl = int(a1.x + 0.5);
  if ((fl & 128) != 0) { D.tau = 1.0 - smoothstep(0.0, uTautTime, t - a1.z); return D; }
  int p = int(floor(a1.y + 0.5));
  if (p < 0 || p >= uCount) return D;
  vec4 pa1 = fetch(uA1, p);
  if (int(floor(pa1.y + 0.5)) != i) return D;
  D.partner = p;
  D.mother = (fl & 32) != 0;
  D.full = (2.0 * a0.y + uSplitGap) * a0.x;
  D.te = t - a1.z;
  bool isAuto = (fl & 64) != 0;
  D.dur = isAuto ? uAutoSplitTime : D.full / max(uPullApartSpeed, 0.05);
  int m = D.mother ? i : p;
  if (uCancel.y != 0 && uCancel.x == m) {
    D.cancel = true; D.target = uCancelSep.x; D.merge = uCancelSep.y;
    D.constrained = true; D.live = true; D.bridge = 1.0;
    D.tau = smoothstep(0.0, uTautTime, D.te);
    D.f = D.target / D.full;
    return D;
  }
  float x = clamp(D.te / D.dur, 0.0, 1.0);
  D.target = isAuto ? D.full * x * x * (3.0 - 2.0 * x) : min(D.full, uPullApartSpeed * max(D.te, 0.0));
  D.f = D.target / D.full;
  D.constrained = D.te < D.dur;
  D.live = D.te < D.dur + uBridgeTime;
  D.tau = D.te < D.dur ? smoothstep(0.0, uTautTime, D.te) : 1.0 - smoothstep(0.0, uTautTime, D.te - D.dur);
  D.bridge = 1.0 - smoothstep(0.0, uBridgeTime, D.te - D.dur);
  return D;
}
`;

SH.wander = `
uniform float uWanderSpeed, uTurnRate;
// Heading and speed from a per-cell sum of slow sines at unrelated frequencies.
vec2 wanderVel(float seed, float t) {
  float h0 = hash1(seed, 1.0), h1 = hash1(seed, 2.0), h2 = hash1(seed, 3.0), h3 = hash1(seed, 4.0);
  float h4 = hash1(seed, 5.0), h5 = hash1(seed, 6.0), h6 = hash1(seed, 7.0), h7 = hash1(seed, 8.0);
  float h8 = hash1(seed, 9.0), h9 = hash1(seed, 10.0);
  float f1 = 0.10 + 0.07 * h1, f2 = 0.21 + 0.12 * h2, f3 = 0.43 + 0.2 * h3;
  float drift = (h4 - 0.5) * 0.25;
  float ang = TAU * h0 + drift * t + uTurnRate * (1.0 * sin(f1 * t + TAU * h5)
            + 0.55 * sin(f2 * t + TAU * h6) + 0.3 * sin(f3 * t + TAU * h7));
  float g1 = 0.17 + 0.1 * h8, g2 = 0.37 + 0.15 * h9;
  float spd = uWanderSpeed * (0.72 + 0.17 * sin(g1 * t + TAU * h9) + 0.11 * sin(g2 * t + TAU * h8));
  return spd * vec2(cos(ang), sin(ang));
}
float wanderTorqueAt(float seed, float t) {
  float h1 = hash1(seed, 61.0), h2 = hash1(seed, 62.0), h3 = hash1(seed, 63.0);
  return 0.6 * sin((0.23 + 0.2 * h1) * t + TAU * h2) + 0.4 * sin((0.61 + 0.3 * h3) * t + TAU * h1);
}
`;

SH.fullscreenVS = SH.header + `
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Simulation

// Copies state; texels in [uBornStart, uCount) take their mother's state (daughters being born).
SH.birthFS = SH.header + `
uniform sampler2D uS0, uS1, uS2, uS3, uA0, uA1;
uniform int uCount, uBornStart;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
vec4 fetch(sampler2D s, int i) { return texelFetch(s, ivec2(i & 511, i >> 9), 0); }
void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int i = fc.y * 512 + fc.x;
  if (i >= uCount) { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0); o3 = vec4(0.0); return; }
  int src = i;
  if (i >= uBornStart) src = int(floor(fetch(uA1, i).y + 0.5));
  vec4 s0 = fetch(uS0, src), s1 = fetch(uS1, src), s2 = fetch(uS2, src), s3 = fetch(uS3, src);
  if (src != i) {
    float sz = fetch(uA0, src).x;
    s0.xy -= vec2(cos(s1.x), sin(s1.x)) * 1e-3 * sz;
  }
  o0 = s0; o1 = s1; o2 = s2; o3 = s3;
}
`;

// Depth-peeled uniform grid: layer k keeps, per grid cell, the k-th smallest cell index.
SH.gridVS = SH.header + `
uniform sampler2D uS0, uPrev;
uniform int uLayer, uPrevChan;
uniform vec2 uGridOrigin;
uniform float uGridCell;
uniform ivec2 uGridSize;
flat out float vIdx;
void main() {
  int i = gl_VertexID;
  vec2 p = texelFetch(uS0, ivec2(i & 511, i >> 9), 0).xy;
  ivec2 g = clamp(ivec2(floor((p - uGridOrigin) / uGridCell)), ivec2(0), uGridSize - 1);
  float prev = -1.0;
  if (uLayer > 0) {
    vec4 pv = texelFetch(uPrev, g, 0);
    prev = uPrevChan == 0 ? pv.x : uPrevChan == 1 ? pv.y : uPrevChan == 2 ? pv.z : pv.w;
  }
  vIdx = float(i);
  float z = float(i) * (1.0 / 524288.0) - 1.0;
  if (float(i) <= prev + 0.5) z = 2.0;
  gl_Position = vec4((vec2(g) + 0.5) / vec2(uGridSize) * 2.0 - 1.0, z, 1.0);
  gl_PointSize = 1.0;
}
`;
SH.gridFS = SH.header + `
flat in float vIdx;
out vec4 o;
void main() { o = vec4(vIdx); }
`;

// One position-based substep: steering, colony pull, alignment torque, deformation spring, prediction,
// contacts between the exact deformed shapes, membrane containment, the held-division constraint and
// velocities derived from the position change.
SH.solverFS = SH.header + `
uniform sampler2D uS0, uS1, uS2, uS3, uA0, uA1, uA2, uG0, uG1, uG2;
uniform float uDt, uTime;
uniform vec2 uGridOrigin;
uniform float uGridCell;
uniform ivec2 uGridSize;
uniform int uLayers;
uniform vec4 uCont;      // container: x, y, angle, flex
uniform vec4 uContVel;   // container: vx, vy, angular velocity
uniform vec4 uMem;       // membrane semi-minor B, front semi-major, back semi-major, keep-inside fraction
uniform vec4 uColony;    // natural radius, colony size, pull fade
uniform float uExpand;   // homologous colony expansion for this substep
uniform float uGridK;    // expansion applied since the grid was built (maps back to grid space)
uniform vec2 uExpandTaper;
uniform int uRelax;
uniform float uSteering, uLinDamping, uAlignStrength, uWanderTorque, uAngDamping, uContactSpin, uRelaxation;
uniform float uStretchStrength, uStretchHalfSpeed, uMaxStretch, uMaxAspect, uWobbleFreq, uWobbleDamping;
uniform float uSquashSoftness, uImpactSquish, uLagFreq, uLagDamping, uLagStrength, uLagMax, uMaxSpeed, uMaxSpin;
uniform float uSplitStiffness, uSplitDamping, uSplitKick;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
` + SH.math + SH.shape + SH.ripple + SH.division + SH.wander + `

// Colony expansion about its centre, fading out toward the membrane. Mirrors World.expandPos().
float expandFactor(vec2 p, float k) {
  float rho = length(vec2(p.x / (p.x >= 0.0 ? uMem.y : uMem.z), p.y / uMem.x));
  return 1.0 + (k - 1.0) * (1.0 - smoothstep(uExpandTaper.x, uExpandTaper.y, rho));
}
vec2 expandPos(vec2 p) { return uExpand == 1.0 ? p : p * expandFactor(p, uExpand); }

float rippleSeedOf(Div dv, vec4 a1) {
  if (dv.partner >= 0 && !dv.mother && dv.te < uTautTime) return fetch(uA1, dv.partner).w;
  return a1.w;
}

void main() {
  ivec2 fc = ivec2(gl_FragCoord.xy);
  int i = fc.y * 512 + fc.x;
  if (i >= uCount) { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0); o3 = vec4(0.0); return; }
  vec4 s0 = texelFetch(uS0, fc, 0), s1 = texelFetch(uS1, fc, 0), s2 = texelFetch(uS2, fc, 0), s3 = texelFetch(uS3, fc, 0);
  vec4 a0 = texelFetch(uA0, fc, 0), a1 = texelFetch(uA1, fc, 0);
  float dt = max(uDt, 1e-5), t = uTime;
  int fl = int(a1.x + 0.5);
  bool isCont = (fl & 16) != 0;
  float flex = isCont ? uCont.w : 1.0;
  vec2 p = s0.xy, v = s0.zw;
  float th = s1.x, om = s1.y;
  vec2 D = s1.zw, Dv = s2.xy, L = s2.zw, Lv = s3.xy;
  float lr = s3.z, lrv = s3.w;
  float size = a0.x, aspect = a0.y, egg = a0.z;
  float mass = size * size * aspect;
  float inertia = mass * size * size * (aspect * aspect + 1.0) * 0.25;
  Div dv = divInfo(i, a0, a1, t);
  float tau = dv.tau;
  vec2 vOld = v;
  float omOld = om;
  float side = dv.mother ? 1.0 : -1.0;
  vec4 ps0 = vec4(0.0), ps1 = vec4(0.0), ps2 = vec4(0.0);
  if (dv.partner >= 0) { ps0 = fetch(uS0, dv.partner); ps1 = fetch(uS1, dv.partner); ps2 = fetch(uS2, dv.partner); }
  bool relax = uRelax != 0;

  // Steering, colony pull and torques.
  if (isCont) {
    v = uContVel.xy; om = uContVel.z;
  } else if (!relax) {
    float seed = a0.w;
    if (dv.constrained && !dv.mother) seed = fetch(uA0, dv.partner).w;
    vec2 vd = wanderVel(seed, t);
    // Distance in the membrane's own shape: the natural colony is the membrane scaled down.
    float r = length(vec2(p.x / (p.x >= 0.0 ? uMem.y : uMem.z), p.y / uMem.x)) * uMem.x;
    float R = uColony.x, r0 = 0.25 * uColony.y * R, r1 = uColony.y * R;
    float lp = length(p);
    if (lp > 1e-4) vd -= p / lp * (uWanderSpeed * max(r - r0, 0.0) / max(r1 - r0, 1e-3) * uColony.z);
    v += (vd - v) * (1.0 - exp(-uSteering * dt));
    v *= exp(-uLinDamping * dt);
    float sp = length(v);
    float torque = uWanderTorque * wanderTorqueAt(seed, t) - uAngDamping * om;
    if (sp > 1e-4) torque += uAlignStrength * min(sp / max(uWanderSpeed, 1e-3), 1.0) * sin(atan(v.y, v.x) - th);
    om += torque * dt;
    if (dv.constrained) {
      float thm = dv.mother ? th : ps1.x;
      vec2 e = vec2(cos(thm), sin(thm));
      vec2 rel = dv.mother ? p - ps0.xy : ps0.xy - p;
      vec2 vrel = dv.mother ? v - ps0.zw : ps0.zw - v;
      float acc = uSplitStiffness * (dv.target - dot(rel, e)) - uSplitDamping * dot(vrel, e);
      v += side * 0.5 * acc * dt * e;
    }
    if (dv.partner >= 0 && !dv.cancel && dv.te >= dv.dur && dv.te - dt < dv.dur) {
      float thm = dv.mother ? th : ps1.x;
      v += side * 0.5 * uSplitKick * vec2(cos(thm), sin(thm));
    }
  }

  // Deformation spring toward a stretch along the direction of travel.
  if (!relax) {
    float sp = length(v);
    vec2 Dt = vec2(0.0);
    if (sp > 1e-4) {
      float lam = log(1.0 + uStretchStrength * sp / (sp + uStretchHalfSpeed));
      float psi = atan(v.y, v.x) - th;
      Dt = lam * vec2(cos(2.0 * psi), sin(2.0 * psi));
    }
    Dt *= 1.0 - tau;
    float wf = uWobbleFreq, z = uWobbleDamping + 2.5 * tau;
    Dv += (-wf * wf * (D - Dt) - 2.0 * z * wf * Dv) * dt;
  } else {
    Dv = vec2(0.0);
  }

  // Prediction.
  vec2 pe = expandPos(p);
  vec2 pp = isCont ? uCont.xy : pe + v * dt;
  float thp = isCont ? uCont.z : th + om * dt;
  vec2 Dp = D + Dv * dt;

  mat2 toMatI;
  Egg Ei = makeEgg(pp, thp, Dp * flex, size, aspect, egg, toMatI);
  vec3 phI, amI;
  rippleParams(rippleSeedOf(dv, a1), t, phI, amI);
  float ampI = size * uRippleStrength * (1.0 - tau) * flex;
  float reachI = max(Ei.af, Ei.ab) + size * uRippleStrength;

  // Contacts (Jacobi), neighbours predicted forward within the step.
  vec2 dP = vec2(0.0), dD = vec2(0.0), kickD = vec2(0.0);
  float dTh = 0.0, nC = 0.0;
  float wpI = isCont ? 0.0 : 1.0 / mass;
  float wtI = isCont ? 0.0 : uContactSpin / inertia;
  float wkI = uSquashSoftness * (1.0 - tau) * flex;
  mat2 toBodyI = transpose(rot2(thp));
  vec2 pg = uGridK == 1.0 ? pp : pp / expandFactor(pp, uGridK);
  ivec2 gc = ivec2(floor((pg - uGridOrigin) / uGridCell));
  for (int gy = -1; gy <= 1; gy++) {
    for (int gx = -1; gx <= 1; gx++) {
      ivec2 g = gc + ivec2(gx, gy);
      if (g.x < 0 || g.y < 0 || g.x >= uGridSize.x || g.y >= uGridSize.y) continue;
      vec4 L0 = texelFetch(uG0, g, 0), L1 = texelFetch(uG1, g, 0), L2 = texelFetch(uG2, g, 0);
      float lay[12] = float[12](L0.x, L1.x, L2.x, L0.y, L1.y, L2.y, L0.z, L1.z, L2.z, L0.w, L1.w, L2.w);
      for (int k = 0; k < 12; k++) {
        if (k >= uLayers) break;
        float jf = lay[k];
        if (jf < 0.0) break;
        int j = int(jf + 0.5);
        if (j == i || j >= uCount) continue;
        if (dv.live && j == dv.partner) continue;
        vec4 j0 = fetch(uS0, j);
        vec4 ja0 = fetch(uA0, j);
        vec4 ja1 = fetch(uA1, j);
        bool jCont = (int(ja1.x + 0.5) & 16) != 0;
        vec2 pj = jCont ? uCont.xy : expandPos(j0.xy) + j0.zw * dt;
        float dist = length(pj - pp);
        if (dist > reachI + ja0.x * 2.1) continue;
        vec4 j1 = fetch(uS1, j);
        vec4 j2 = fetch(uS2, j);
        float flexJ = jCont ? uCont.w : 1.0;
        float thj = jCont ? uCont.z : j1.x + j1.y * dt;
        vec2 Dj = (j1.zw + j2.xy * dt) * flexJ;
        mat2 toMatJ;
        Egg Ej = makeEgg(pj, thj, Dj, ja0.x, ja0.y, ja0.z, toMatJ);
        if (dist > reachI + max(Ej.af, Ej.ab) + ja0.x * uRippleStrength) continue;
        vec2 sx = eggSeparation(Ei, Ej);
        // Ripples move an outline by at most size * strength: clearly apart, skip the rest.
        if (sx.y > (size + ja0.x) * uRippleStrength) continue;
        vec2 m = Ei.c + Ei.ax * sx.x;
        float rI = inscR(sx.x, Ei);
        vec3 dj = eggDistN(m, Ej);
        vec2 n = -dj.yz;
        vec2 cpI = m + n * rI;
        vec2 cpJ = m + n * dj.x;
        Div dvj = divInfo(j, ja0, ja1, t);
        vec3 phJ, amJ;
        rippleParams(rippleSeedOf(dvj, ja1), t, phJ, amJ);
        vec2 uj = toMatJ * (cpJ - pj);
        float ripJ = ja0.x * uRippleStrength * (1.0 - dvj.tau) * flexJ * rippleAt(atan(uj.y, uj.x), phJ, amJ);
        vec2 ui = toMatI * (cpI - pp);
        float ripI = ampI * rippleAt(atan(ui.y, ui.x), phI, amI);
        float sep = sx.y - ripI - ripJ;
        if (sep >= 0.0) continue;
        float massJ = ja0.x * ja0.x * ja0.y;
        float inJ = massJ * ja0.x * ja0.x * (ja0.y * ja0.y + 1.0) * 0.25;
        float wpJ = jCont ? 0.0 : 1.0 / massJ;
        float wtJ = jCont ? 0.0 : uContactSpin / inJ;
        float wkJ = uSquashSoftness * (1.0 - dvj.tau) * flexJ;
        vec2 rIv = cpI - pp, rJv = cpJ - pj;
        float cI = cross2(rIv, n), cJ = cross2(rJv, n);
        float gI = max(dot(n, rIv), 0.0), gJ = max(-dot(n, rJv), 0.0);
        float W = wpI + wtI * cI * cI + wkI * gI * gI + wpJ + wtJ * cJ * cJ + wkJ * gJ * gJ;
        if (W < 1e-8) continue;
        float lam = -sep / W;
        dP -= n * wpI * lam;
        dTh -= wtI * cI * lam;
        vec2 nb = toBodyI * n;
        vec2 N2 = vec2(nb.x * nb.x - nb.y * nb.y, 2.0 * nb.x * nb.y);
        dD -= wkI * gI * lam * N2;
        vec2 vj = jCont ? uContVel.xy : j0.zw;
        float vc = dot(v - vj, n);
        if (vc > 0.0 && !relax) kickD -= uImpactSquish * vc / size * N2 * (1.0 - tau) * flex;
        nC += 1.0;
      }
    }
  }
  if (nC > 0.0) {
    float rf = uRelaxation / sqrt(nC);
    pp += dP * rf;
    thp += dTh * rf;
    Dp += dD * rf;
    kickD *= rf;
  }

  // Containment: cells are kept a fraction of the membrane radius inside it.
  if (!isCont) {
    vec3 md = sdEggN(pp, uMem.y, uMem.z, uMem.x);
    float lim = -uMem.w * uMem.x - max(Ei.af, Ei.ab);
    if (md.x > lim) pp -= md.yz * (md.x - lim);
  }

  // Held division: keep the pair on the mother's long axis, sharing angle and deformation.
  if (dv.constrained && !isCont) {
    vec2 pj = expandPos(ps0.xy) + ps0.zw * dt;
    float thj = ps1.x + ps1.y * dt;
    float thm = dv.mother ? thp : thj;
    vec2 e = vec2(cos(thm), sin(thm));
    vec2 rel = dv.mother ? pp - pj : pj - pp;
    pp -= side * 0.5 * dot(rel, perp(e)) * perp(e);
    thp += 0.5 * angDiff(thj, thp);
    Dp = mix(Dp, ps1.zw + ps2.xy * dt, 0.5);
  }

  // Deformation limits: largest stretch factor and longest aspect.
  float lmax = log(uMaxStretch);
  float dl = length(Dp);
  if (dl > lmax) Dp *= lmax / dl;
  if (stretchedAspect(Dp, aspect) > uMaxAspect) {
    float lo = 0.0, hi = 1.0;
    for (int k = 0; k < 6; k++) {
      float mid = 0.5 * (lo + hi);
      if (stretchedAspect(Dp * mid, aspect) > uMaxAspect) hi = mid; else lo = mid;
    }
    Dp *= lo;
  }

  // Velocities from the position change.
  vec2 vn;
  float omn;
  if (isCont) { pp = uCont.xy; thp = uCont.z; vn = uContVel.xy; omn = uContVel.z; }
  else if (relax) { vn = vec2(0.0); omn = 0.0; }
  else {
    vn = (pp - pe) / dt;
    float vl = length(vn);
    if (vl > uMaxSpeed) vn *= uMaxSpeed / vl;
    omn = clamp(angDiff(thp, th) / dt, -uMaxSpin, uMaxSpin);
  }
  vec2 Dvn = relax ? vec2(0.0) : (Dp - D) / dt + kickD;
  float dvl = length(Dvn);
  if (dvl > 8.0) Dvn *= 8.0 / dvl;
  if (relax) Dp = vec2(0.0);

  // Contents lag behind the body's acceleration through their own soft spring.
  if (!relax) {
    vec2 accB = transpose(rot2(thp)) * ((vn - vOld) / dt);
    float aacc = (omn - omOld) / dt;
    float lw = uLagFreq, lz = uLagDamping;
    Lv += (-lw * lw * L - 2.0 * lz * lw * Lv - 0.5 * uLagStrength * accB) * dt;
    float lvl = length(Lv);
    if (lvl > 3.0 * size) Lv *= 3.0 * size / lvl;
    L += Lv * dt;
    float lm = uLagMax * size, ll = length(L);
    if (ll > lm) { vec2 nl = L / ll; L = nl * lm; Lv -= nl * max(dot(Lv, nl), 0.0); }
    lrv += (-lw * lw * lr - 2.0 * lz * lw * lrv - 0.5 * uLagStrength * aacc) * dt;
    lrv = clamp(lrv, -4.0, 4.0);
    lr = clamp(lr + lrv * dt, -0.5, 0.5);
  } else {
    L = vec2(0.0); Lv = vec2(0.0); lr = 0.0; lrv = 0.0;
  }

  o0 = vec4(pp, vn);
  o1 = vec4(wrapAng(thp), omn, Dp);
  o2 = vec4(Dvn, L);
  o3 = vec4(Lv, lr, lrv);
}
`;

// ---------------------------------------------------------------------------------------------
// Rendering

// Shared shading: palettes and the marbled interior.
SH.shading = `
uniform sampler2D uNoise;
uniform vec3 uPalC[54];
uniform vec4 uMarb[6];
uniform float uOutlineWidth, uMembraneOutlineWeight, uHaloSize, uHaloStrength, uRimWidth, uRimStrength;
uniform float uInteriorStrength, uInteriorScale, uInteriorBulge;
uniform vec2 uMagFade;   // weight of the coarse and the fine marbling layers at this zoom

vec3 PC(int p, int k) { return uPalC[p * 9 + k]; }

float marbleAt(int pal, vec2 tc) {
  vec4 n0 = texture(uNoise, tc);
  vec4 n1 = texture(uNoise, tc + (n0.gb - 0.5) * 0.16);
  vec4 mp = uMarb[pal];
  float m = mix(n1.r, n1.a, mp.z);
  return smoothstep(mp.x, mp.y, m) * mp.w;
}

// Body colour from normalised radius and material coordinates (in radii). Contents lag and lens bulge
// displace the middle of the texture while the rim stays put.
vec3 shadeInterior(int pal, float rho, vec2 um, vec2 lag, float lagRot, vec2 texOff, float texRot, float inner) {
  float r2 = min(rho * rho, 1.0);
  vec3 base = mix(PC(pal, 1), PC(pal, 0), r2);
  float fall = 1.0 - r2;
  vec2 ul = rot2(lagRot * fall) * (um - lag * fall);
  vec2 tc = rot2(texRot) * (ul * (1.0 - uInteriorBulge * fall)) * uInteriorScale + texOff;
  float mk = 0.0;
  if (inner < 1.0) {
    if (uMagFade.x > 0.0) mk += uMagFade.x * marbleAt(pal, tc);
    if (uMagFade.y > 0.0) mk += uMagFade.y * marbleAt(pal, tc * 4.0 + vec2(0.37, 0.71));
  }
  mk *= (1.0 - smoothstep(0.55, 0.97, rho)) * (1.0 - inner) * uInteriorStrength;
  return mix(base, PC(pal, 5), clamp(mk, 0.0, 1.0));
}

// Rim band and crisp outline on top of the interior colour. d and widths in world units, px = pixel size.
vec3 rimAndOutline(int pal, vec3 col, float d, float size, float px, float inner) {
  float depth = max(-d, 0.0);
  col = mix(col, PC(pal, 2), clamp(uRimStrength * 0.85 * exp(-depth / max(uRimWidth * size, 1e-6)), 0.0, 1.0));
  float ow = uOutlineWidth * size * mix(1.0, uMembraneOutlineWeight, inner);
  float owp = max(ow, px);
  float od = abs(d + owp * 0.5) - owp * 0.5;
  float ocov = clamp(0.5 - od / px, 0.0, 1.0) * min(1.0, ow / px);
  return mix(col, PC(pal, 3), ocov);
}

float haloF(float d, float hs) { float x = clamp(d / max(hs, 1e-6), 0.0, 1.0); return (1.0 - x) * (1.0 - x); }

vec3 dotColor(int pal, float inner) {
  vec3 c = mix(PC(pal, 1), PC(pal, 0), 0.6);
  c = mix(c, PC(pal, 5), 0.12 * uInteriorStrength * (1.0 - inner));
  c = mix(c, PC(pal, 2), 0.22);
  c = mix(c, PC(pal, 3), 0.06);
  return mix(c, mix(PC(pal, 6), PC(pal, 7), 0.7), inner);
}
`;

// Instanced, oriented quad per cell (the mother of a dividing pair covers both halves).
SH.cellVS = SH.header + `
uniform sampler2D uS0, uS1, uS2, uS3, uA0, uA1, uA2;
uniform int uSkip;
uniform vec2 uOrigin;
uniform vec2 uRS;
uniform vec2 uViewport;
uniform float uPx, uTime;
uniform int uPass;
uniform vec4 uPickXf;
uniform float uContFlex, uContInner, uHaloSize;
flat out vec4 vA0, vA1, vA2, vA3, vA4, vA5, vB0, vB1, vB2, vB3, vB4, vB5, vInfo;
out vec2 vRel;
` + SH.math + SH.shape + SH.ripple + SH.division + `

void setupHalf(vec4 s0, vec4 s1, vec4 s2, vec4 s3, vec4 a0, vec4 a2, float tau, float flex, float rseed, vec2 refC,
               out vec4 h0, out vec4 h1, out vec4 h2, out vec4 h3, out vec4 h4, out vec4 h5, out Egg E) {
  mat2 toMat;
  E = makeEgg(s0.xy, s1.x, s1.zw * flex, a0.x, a0.y, a0.z, toMat);
  h0 = vec4(E.c - refC, E.ax);
  h1 = vec4(E.af, E.ab, E.b, a2.z);
  h2 = vec4(toMat[0], toMat[1]);
  vec3 ph, am;
  rippleParams(rseed, uTime, ph, am);
  h3 = vec4(ph, s3.z * flex);
  h4 = vec4(am * a0.x * uRippleStrength * (1.0 - tau) * flex, a0.x);
  h5 = vec4(a2.xy + vec2(cos(a2.w), sin(a2.w)) * 0.004 * uTime, s2.zw * flex / a0.x);
}

void main() {
  int i = gl_InstanceID;
  int vid = gl_VertexID;
  vec2 corner = vec2(float(vid & 1) * 2.0 - 1.0, float((vid >> 1) & 1) * 2.0 - 1.0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vA0 = vec4(0.0); vA1 = vec4(0.0); vA2 = vec4(0.0); vA3 = vec4(0.0); vA4 = vec4(0.0); vA5 = vec4(0.0);
  vB0 = vec4(0.0); vB1 = vec4(0.0); vB2 = vec4(0.0); vB3 = vec4(0.0); vB4 = vec4(0.0); vB5 = vec4(0.0);
  vInfo = vec4(0.0); vRel = vec2(0.0);
  if (i >= uCount || i == uSkip) return;
  vec4 s0 = fetch(uS0, i), a0 = fetch(uA0, i), a1 = fetch(uA1, i);
  float t = uTime;
  Div dv = divInfo(i, a0, a1, t);
  bool pair = dv.live && dv.partner >= 0;
  if (pair && !dv.mother) return;
  int fl = int(a1.x + 0.5);
  bool isCont = (fl & 16) != 0;
  float flex = isCont ? uContFlex : 1.0;

  // Cull off-screen instances before any heavy work, with a conservative reach.
  float reach = a0.x * (2.1 + uHaloSize) + (pair ? dv.full + a0.x * 2.1 : 0.0) + 3.0 * uPx;
  vec2 c0 = s0.xy - uOrigin;
  vec2 cs0 = vec2(uRS.x * c0.x - uRS.y * c0.y, uRS.y * c0.x + uRS.x * c0.y);
  if (any(greaterThan(abs(cs0) - reach / uPx, uViewport * 0.5))) return;

  // Far away: a soft, area-preserving dot needs only the centre and the area.
  if (a0.x / uPx < 0.75 && uPass != 2) {
    float A = a0.x * a0.y * (pair ? 1.4142 : 1.0);
    vA0 = vec4(0.0, isCont ? uContInner : 0.0, 1.0, 0.0);
    vA1 = vec4(A, A, a0.x * (pair ? 1.4142 : 1.0), 0.0);
    vA4 = vec4(0.0, 0.0, 0.0, a0.x);
    vRel = corner * (2.6 * uPx);
    vec2 dd = s0.xy + vRel - uOrigin;
    vec2 spd = vec2(uRS.x * dd.x - uRS.y * dd.y, uRS.y * dd.x + uRS.x * dd.y);
    gl_Position = vec4(spd / (uViewport * 0.5), 0.0, 1.0);
    vInfo = vec4(float((fl & 15) | (fl & 16)), 2.0, 0.0, 0.0);
    return;
  }

  vec4 s1 = fetch(uS1, i), s2 = fetch(uS2, i), s3 = fetch(uS3, i), a2 = fetch(uA2, i);
  Egg EA;
  setupHalf(s0, s1, s2, s3, a0, a2, dv.tau, flex, a1.w, s0.xy, vA0, vA1, vA2, vA3, vA4, vA5, EA);
  vec2 ax = EA.ax;
  float x0 = -EA.ab, x1 = EA.af, yh = EA.b;
  float mode = 0.0;
  if (pair) {
    int j = dv.partner;
    vec4 q0 = fetch(uS0, j), q1 = fetch(uS1, j), q2 = fetch(uS2, j), q3 = fetch(uS3, j);
    vec4 qa0 = fetch(uA0, j), qa1 = fetch(uA1, j), qa2 = fetch(uA2, j);
    float rseedB = dv.te < uTautTime ? a1.w : qa1.w;
    Egg EB;
    setupHalf(q0, q1, q2, q3, qa0, qa2, dv.tau, 1.0, rseedB, s0.xy, vB0, vB1, vB2, vB3, vB4, vB5, EB);
    vec2 ob = EB.c - EA.c;
    float along = dot(ob, ax), lat = dot(ob, perp(ax));
    float rb = max(max(EB.af, EB.ab), EB.b);
    x0 = min(x0, along - rb); x1 = max(x1, along + rb); yh = max(yh, abs(lat) + rb);
    mode = 1.0;
  }
  vA0.xy = vec2(dv.merge, isCont ? uContInner : 0.0);
  vB1.w = float(i);
  float margin = (uPass == 0 ? uHaloSize * a0.x : 0.0) + a0.x * uRippleStrength * 1.2 + 2.0 * uPx;
  x0 -= margin; x1 += margin; yh += margin;
  if (EA.b / uPx < 1.5) {
    float m = 2.6 * uPx;
    x0 = min(x0, -m); x1 = max(x1, m); yh = max(yh, m);
  }
  vec2 rel = ax * mix(x0, x1, corner.x * 0.5 + 0.5) + perp(ax) * (corner.y * yh);
  vec2 cc = EA.c + ax * (0.5 * (x0 + x1)) - uOrigin;
  vec2 csp = vec2(uRS.x * cc.x - uRS.y * cc.y, uRS.y * cc.x + uRS.x * cc.y);
  float rad = length(vec2(0.5 * (x1 - x0), yh)) / uPx;
  if (any(greaterThan(abs(csp) - rad, uViewport * 0.5))) return;
  vec2 d = EA.c + rel - uOrigin;
  vec2 sp = vec2(uRS.x * d.x - uRS.y * d.y, uRS.y * d.x + uRS.x * d.y);
  vec2 clip = sp / (uViewport * 0.5);
  if (uPass == 2) clip = clip * uPickXf.xy + uPickXf.zw;
  gl_Position = vec4(clip, 0.0, 1.0);
  vRel = rel;
  vInfo = vec4(float((fl & 15) | (fl & 16)), mode, dv.f, dv.bridge);
}
`;

SH.cellFS = SH.header + `
uniform float uPx, uTime, uOpacity;
uniform int uPass;
flat in vec4 vA0, vA1, vA2, vA3, vA4, vA5, vB0, vB1, vB2, vB3, vB4, vB5, vInfo;
in vec2 vRel;
out vec4 o;
` + SH.math + SH.shape + SH.ripple + SH.shading + `

// Signed distance to one half of the drawing (one cell), ripple included; also material coords and radius.
float halfDist(vec2 r, vec4 h0, vec4 h1, vec4 h2, vec4 h3, vec4 h4, out vec2 um, out float rho) {
  vec2 ax = h0.zw;
  vec2 q = vec2(dot(r, ax), dot(r, perp(ax)));
  float d = sdEgg(q, h1.x, h1.y, h1.z);
  rho = length(vec2(q.x / (q.x >= 0.0 ? h1.x : h1.y), q.y / h1.z));
  um = mat2(h2.xy, h2.zw) * r;
  d -= rippleAt(atan(um.y, um.x), h3.xyz, h4.xyz);
  um /= h4.w;
  return d;
}

void main() {
  int flags = int(vInfo.x + 0.5);
  int pal = flags & 15;
  bool pair = vInfo.y > 0.5 && vInfo.y < 1.5;
  float size = vA4.w;
  float px = uPx;
  float inner = vA0.y;
  float r2px = dot(vRel, vRel) / (px * px);
  float areaPx = 3.14159 * 0.5 * (vA1.x + vA1.y) * vA1.z / (px * px) * (pair ? 2.0 : 1.0);
  if (vInfo.y > 1.5) {
    // Far away: dot only.
    if (uPass == 0) {
      float hpx = uHaloSize * size / px;
      float ringPx = 3.14159 * ((vA1.x / px + hpx) * (vA1.z / px + hpx)) - areaPx;
      o = vec4(PC(pal, 4) * (ringPx * 0.33 * exp(-r2px / 2.0) / 6.2832) * uHaloStrength * uOpacity, 0.0);
      return;
    }
    float a = min(1.0, areaPx * exp(-r2px / (2.0 * 0.56)) / (6.2832 * 0.56));
    if (a <= 0.002) discard;
    o = vec4(dotColor(pal, inner) * a, a) * uOpacity;
    return;
  }
  vec2 umA, umB = vec2(0.0);
  float rhoA, rhoB = 0.0;
  float dA = halfDist(vRel, vA0, vA1, vA2, vA3, vA4, umA, rhoA);
  float d = dA, dB = 1e5, wA = 1.0;
  if (pair) {
    dB = halfDist(vRel - vB0.xy, vB0, vB1, vB2, vB3, vB4, umB, rhoB);
    float f = vInfo.z, bridge = vInfo.w;
    float s = length(vB0.xy);
    float am = 0.5 * (vA1.x + vA1.y);
    float notch = vA1.z * (1.0 - sqrt(max(0.0, 1.0 - s * s / (4.0 * am * am))));
    float ke = max(4.0 * notch * (1.0 - smoothstep(0.1, 0.55, f)), 0.35 * size * smoothstep(0.04, 0.3, f));
    d = smin(dA, dB, ke * bridge);
    if (bridge > 0.0) {
      // The bridge thins as the halves separate, then pinches off while it fades.
      float wcap = size * (mix(0.55, 0.12, smoothstep(0.45, 1.0, f)) * bridge - 0.16 * (1.0 - bridge));
      d = smin(d, sdSegment(vRel, vec2(0.0), vB0.xy) - wcap, size * 0.25 * bridge);
    }
    d = mix(d, dA, vA0.x);
    wA = clamp(0.5 + (dB - dA) / (0.6 * size), 0.0, 1.0);
  }

  // Sub-pixel cells become soft, area-preserving dots.
  float pxR = vA1.z / px;
  float dotMix = smoothstep(1.4, 0.8, pxR);

  if (uPass == 0) {
    float hs = uHaloSize * size;
    float h = haloF(d, hs);
    if (pair) h = mix(mix(haloF(dA, hs) + haloF(dB, hs), h, vInfo.w), haloF(dA, hs), vA0.x);
    if (dotMix > 0.0) {
      float hpx = hs / px;
      float ringPx = 3.14159 * ((0.5 * (vA1.x + vA1.y) / px + hpx) * (vA1.z / px + hpx)) - areaPx;
      float hd = ringPx * 0.33 * exp(-r2px / 2.0) / 6.2832;
      h = mix(h, hd, dotMix);
    }
    o = vec4(PC(pal, 4) * h * uHaloStrength * uOpacity, 0.0);
    return;
  }

  if (uPass == 2) {
    if (d > 0.0 && r2px > 1.0) discard;
    o = vec4(vB1.w + 1.0);
    return;
  }

  float cov = clamp(0.5 - d / px, 0.0, 1.0);
  vec3 col = vec3(0.0);
  if (cov > 0.0 && dotMix < 1.0) {
    float tr = vA1.w;
    col = shadeInterior(pal, rhoA, umA, vA5.zw, vA3.w, vA5.xy, tr, inner);
    float rho = rhoA;
    if (pair) {
      vec3 colB = shadeInterior(pal, rhoB, umB, vB5.zw, vB3.w, vB5.xy, tr, inner);
      col = mix(colB, col, wA);
      rho = mix(rhoB, rhoA, wA);
    }
    if (inner > 0.0) col = mix(col, mix(PC(pal, 6), PC(pal, 7), pow(clamp(rho, 0.0, 1.0), 2.5)), inner);
    col = rimAndOutline(pal, col, d, size, px, inner);
  }
  vec4 full = vec4(col * cov, cov);
  if (dotMix > 0.0) {
    float a = min(1.0, areaPx * exp(-r2px / (2.0 * 0.56)) / (6.2832 * 0.56));
    full = mix(full, vec4(dotColor(pal, inner) * a, a), dotMix);
  }
  if (full.a <= 0.0) discard;
  o = full * uOpacity;
}
`;

// A container cell drawn on its own in its exact double-precision frame (also the backdrop).
SH.containerFS = SH.header + `
uniform vec2 uU0;
uniform vec4 uJ;
uniform vec2 uViewport;
uniform vec3 uEgg;
uniform int uPalI, uPass;
uniform float uInner, uOpacity, uPxL, uScale, uTime;
uniform vec4 uTexP;
out vec4 o;
` + SH.math + SH.shape + SH.shading + `
void main() {
  vec2 fp = gl_FragCoord.xy - uViewport * 0.5;
  vec2 u = uU0 + mat2(uJ.xy, uJ.zw) * fp;
  float d = sdEgg(u, uEgg.x, uEgg.y, uEgg.z);
  int pal = uPalI;
  if (uPass == 0) {
    float h = haloF(d, uHaloSize);
    if (h <= 0.0) discard;
    o = vec4(PC(pal, 4) * h * uHaloStrength * uOpacity, 0.0);
    return;
  }
  float cov = clamp(0.5 - d / uPxL, 0.0, 1.0);
  if (cov <= 0.0) discard;
  float rho = length(vec2(u.x / (u.x >= 0.0 ? uEgg.x : uEgg.y), u.y / uEgg.z));
  vec3 col = shadeInterior(pal, rho, u, vec2(0.0), 0.0, uTexP.xy, uTexP.z, uInner);
  vec3 bg = mix(PC(pal, 6), PC(pal, 7), pow(clamp(rho, 0.0, 1.0), 2.5));
  float cl = textureLod(uNoise, u * (uScale / 220.0) + vec2(0.31, 0.17), 4.0).r;
  bg *= clamp(1.0 + 0.8 * (cl - 0.5), 0.88, 1.12);
  col = mix(col, bg, uInner);
  col = rimAndOutline(pal, col, d, 1.0, uPxL, uInner);
  o = vec4(col * cov, cov) * uOpacity;
}
`;

// Procedural particles: a hash per tile of world space, parallax by scaling about the view centre.
SH.particleVS = SH.header + `
uniform ivec2 uTile0;
uniform int uTilesX, uPerTile, uKind;
uniform float uTileSize, uProb, uRMin, uRMax, uFade, uSeed, uPx, uTime;
uniform vec2 uOrigin, uRS, uViewport;
uniform vec3 uMem;
out vec2 vQ;
flat out vec4 vP;
` + SH.math + `
void main() {
  int inst = gl_InstanceID;
  int tI = inst / uPerTile, k = inst - tI * uPerTile;
  ivec2 tile = uTile0 + ivec2(tI % uTilesX, tI / uTilesX);
  uint h = hashU(uint(tile.x) * 73856093u ^ hashU(uint(tile.y) * 19349663u ^ uint(k * 2 + uKind) * 83492791u) ^ floatBitsToUint(uSeed));
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ = vec2(0.0); vP = vec4(0.0);
  if (urand(h) > uProb) return;
  vec2 pos = (vec2(tile) + vec2(urand(h), urand(h))) * uTileSize;
  float a1 = urand(h), a2 = urand(h), a3 = urand(h), a4 = urand(h);
  pos += vec2(sin(uTime * (0.03 + 0.05 * a1) + TAU * a2), cos(uTime * (0.025 + 0.05 * a3) + TAU * a4)) * uTileSize * 0.35;
  float depth = (urand(h) * 2.0 - 1.0) * 0.3;
  float rad = mix(uRMin, uRMax, urand(h));
  float rhoM = length(vec2(pos.x / (pos.x >= 0.0 ? uMem.y : uMem.z), pos.y / uMem.x));
  float a = uFade * (1.0 - smoothstep(0.84, 0.93, rhoM));
  a *= 0.6 + 0.4 * sin(uTime * (0.5 + 1.1 * urand(h)) + TAU * urand(h));
  if (a <= 0.002) return;
  vec2 dd = pos - uOrigin;
  vec2 sp = vec2(uRS.x * dd.x - uRS.y * dd.y, uRS.y * dd.x + uRS.x * dd.y) * (1.0 + depth);
  float rpx = rad / uPx * (1.0 + depth);
  float ext = uKind == 0 ? max(rpx * 5.0, 2.5) : max(rpx * 2.2, 2.5);
  if (any(greaterThan(abs(sp) - ext, uViewport * 0.5))) return;
  vec2 corner = vec2(float(gl_VertexID & 1) * 2.0 - 1.0, float((gl_VertexID >> 1) & 1) * 2.0 - 1.0);
  vQ = corner * ext;
  vP = vec4(rpx, a, ext, 0.0);
  gl_Position = vec4((sp + vQ) / (uViewport * 0.5), 0.0, 1.0);
}
`;
SH.particleFS = SH.header + `
uniform vec3 uColor;
uniform float uOpacity;
uniform int uKind;
in vec2 vQ;
flat in vec4 vP;
out vec4 o;
void main() {
  float r = length(vQ);
  float rp = max(vP.x, 0.35);
  float v;
  if (uKind == 0) {
    // Sharp when tiny; magnified specks soften instead of becoming hard discs.
    float edge = max(0.5, rp * 0.35);
    float core = clamp((rp - r) / edge + 0.5, 0.0, 1.0) * min(1.0, vP.x * 2.0 + 0.25);
    float glow = exp(-r * r / (rp * rp * 6.0)) * 0.28;
    v = (core * 0.85 + glow) * 3.0 / (3.0 + max(rp - 3.0, 0.0));
  } else {
    float x = r / rp;
    v = exp(-x * x * 1.6) * 0.32 + exp(-x * x * 0.4) * 0.06;
  }
  v *= vP.y * uOpacity;
  if (v <= 0.0005) discard;
  o = vec4(uColor * v, 0.0);
}
`;

// Seamlessly tiling noise: R domain-warped fbm clouds, G/B warp fields, A ridged veins.
SH.noiseFS = SH.header + `
uniform float uSize;
out vec4 o;
` + SH.math + `
vec2 grad(ivec2 p, int period) {
  p = (p + ivec2(period * 1024)) % period;
  uint h = hashU(uint(p.x) * 1664525u + hashU(uint(p.y) * 22695477u + 12345u));
  float a = float(h >> 8u) * (TAU / 16777216.0);
  return vec2(cos(a), sin(a));
}
float pnoise(vec2 x, int P) {
  vec2 fl = floor(x);
  ivec2 i = ivec2(fl);
  vec2 f = x - fl;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(grad(i, P), f);
  float b = dot(grad(i + ivec2(1, 0), P), f - vec2(1.0, 0.0));
  float c = dot(grad(i + ivec2(0, 1), P), f - vec2(0.0, 1.0));
  float d = dot(grad(i + ivec2(1, 1), P), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 x, int P, int oct) {
  float s = 0.0, amp = 0.5, norm = 0.0;
  for (int k = 0; k < 7; k++) {
    if (k >= oct) break;
    s += amp * pnoise(x, P);
    norm += amp;
    x *= 2.0; P *= 2; amp *= 0.5;
  }
  return s / norm;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 x = uv * 4.0;
  float w1 = fbm(x + vec2(1.7, 9.2), 4, 5);
  float w2 = fbm(x + vec2(8.3, 2.8), 4, 5);
  vec2 wp = vec2(w1, w2);
  float cloud = fbm(x + 1.8 * wp, 4, 6);
  float cloud2 = fbm(x * 2.0 + 2.5 * wp + vec2(3.1, 4.7), 8, 4);
  float c = 0.5 + 1.15 * (0.7 * cloud + 0.3 * cloud2);
  vec2 xv = uv * 6.0 + 1.1 * wp;
  float r1 = 1.0 - abs(pnoise(xv, 6));
  float r2 = 1.0 - abs(pnoise(xv * 2.0 + vec2(5.2, 1.3), 12));
  float r3 = 1.0 - abs(fbm(uv * 3.0 + 0.8 * wp + vec2(2.2, 7.7), 3, 3) * 1.6);
  float veins = pow(r1, 9.0) * 0.6 + pow(r2, 12.0) * 0.4;
  veins = clamp(veins * 1.25 + 0.55 * pow(clamp(r3, 0.0, 1.0), 6.0) + 0.25 * (c - 0.5), 0.0, 1.0);
  o = vec4(clamp(c, 0.0, 1.0), clamp(0.5 + w1 * 1.4, 0.0, 1.0), clamp(0.5 + w2 * 1.4, 0.0, 1.0), veins);
}
`;
