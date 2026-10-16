'use strict';
// Tunable constants and palettes. Everything that shapes the feel lives here.
// Units: distances in cell radii, speeds in radii per second, "screen" = shorter side of the window.

const CFG = {
  // Populations and colony geometry
  popStart: 70,
  popOuter: 46,
  popFurther: 42,
  capacity: 100000,
  coverage: 0.36,
  maxPerWorld: 250000,
  sizeVar: 0.09,
  aspectMin: 1.3,
  aspectMax: 1.5,
  eggVar: 0.11,

  // Motion
  wanderSpeed: 2.2,
  turnRate: 1.6,
  steering: 2.2,
  linDamping: 0.15,
  alignStrength: 2.0,
  wanderTorque: 0.6,
  angDamping: 2.5,
  contactSpin: 0.35,
  colonySize: 3.0,
  iterations: 3,
  relaxation: 0.7,
  maxSpeed: 4.0,
  maxSpin: 1.8,
  membraneKeep: 0.06,
  expandTime: 0.3,
  expandTaper: [0.6, 0.95],

  // Soft body
  stretchStrength: 0.28,
  stretchHalfSpeed: 1.2,
  maxStretch: 1.38,
  maxAspect: 2.0,
  wobbleFreq: 5.5,
  wobbleDamping: 0.16,
  squashSoftness: 0.6,
  impactSquish: 0.55,
  lagFreq: 5.0,
  lagDamping: 0.45,
  lagStrength: 1.0,
  lagMax: 0.2,
  rippleStrength: 0.04,
  rippleSpeed: 1.0,

  // Look
  outlineWidth: 0.032,
  membraneOutlineWeight: 1.0,
  haloSize: 0.42,
  haloStrength: 0.2,
  rimWidth: 0.17,
  rimStrength: 0.8,
  interiorStrength: 0.9,
  interiorScale: 0.2,
  interiorBulge: 0.32,
  particleDensity: 1.0,
  innerFadeStart: 0.1,
  innerFadeEnd: 0.5,

  // Division
  holdDelay: 0.15,
  pullApartSpeed: 4.2,
  commitFraction: 0.55,
  splitStiffness: 250,
  splitDamping: 14,
  splitGap: 0.8,
  splitKick: 0.9,
  tautTime: 0.2,
  bridgeTime: 0.3,
  autoSplitTime: 1.2,

  // Camera and input
  wheelZoomStep: 0.0022,
  pinchZoomStep: 0.011,
  wheelEase: 0.09,
  pinchEase: 0.035,
  startViewRadii: 14,
  maxZoomScreens: 3,
  followAttach: 0.55,
  followDetach: 0.18,
  followBand: 0.25,
  switchUp: 0.42,
  switchDown: 0.75,
  switchUpOutside: 0.5,
  inertiaDecay: 0.12,

  // Performance
  maxDpr: 2,
  gridLayers: 10,
  slowFrame: 1 / 50,
  resStep: 0.15,
  resMin: 0.5,
  resProbeAfter: 8,
  stressFraction: 0.02,
  stressMin: 40,
  stressMax: 4000,
  noiseSize: 1024,
};

// Palettes: body colours, marbling and the colours seen from inside a container.
const PALETTES = [
  { name: 'Inner (magenta)', body: '#d23a9a', centre: '#a32a80', rim: '#ff8ad8', outline: '#ffeaf8', glow: '#ff4cc0',
    marble: '#4a0f42', insideBg: '#1c0620', insideBgEdge: '#6e1a5c', particle: '#ffb8ea',
    marbleLo: 0.40, marbleHi: 0.80, veins: 0.50, strength: 0.85 },
  { name: 'Outer (periwinkle)', body: '#8a93ea', centre: '#737cd8', rim: '#c6ccff', outline: '#f4f6ff', glow: '#8494ff',
    marble: '#e6e9ff', insideBg: '#151946', insideBgEdge: '#3b4396', particle: '#cbd3ff',
    marbleLo: 0.50, marbleHi: 0.90, veins: 0.22, strength: 0.62 },
  { name: 'Level 2 (aqua)', body: '#2fa3ad', centre: '#24828f', rim: '#86f2ec', outline: '#eafffd', glow: '#3cd9d3',
    marble: '#0c3d48', insideBg: '#080c2c', insideBgEdge: '#1d2870', particle: '#b6f0ff',
    marbleLo: 0.42, marbleHi: 0.84, veins: 0.45, strength: 0.80 },
  { name: 'Level 3 (amber)', body: '#d0923a', centre: '#aa7429', rim: '#ffd88f', outline: '#fff5e0', glow: '#ffb347',
    marble: '#4d2c0a', insideBg: '#071a1e', insideBgEdge: '#1a4b4e', particle: '#ffe0ae',
    marbleLo: 0.42, marbleHi: 0.84, veins: 0.45, strength: 0.80 },
  { name: 'Level 4 (green)', body: '#5fae4e', centre: '#478f3b', rim: '#bdf7a0', outline: '#f2ffe9', glow: '#7ee06c',
    marble: '#183f13', insideBg: '#1e1106', insideBgEdge: '#5a3a14', particle: '#d6ffc6',
    marbleLo: 0.42, marbleHi: 0.84, veins: 0.45, strength: 0.80 },
  { name: 'Level 5 (rose)', body: '#b8425a', centre: '#933347', rim: '#ffa0b2', outline: '#fff0f3', glow: '#ff5e78',
    marble: '#3c0b16', insideBg: '#0b1a10', insideBgEdge: '#21502c', particle: '#ffd0da',
    marbleLo: 0.42, marbleHi: 0.84, veins: 0.45, strength: 0.80 },
];

// Order of colours in the packed palette uniform (9 per palette).
const PALETTE_KEYS = ['body', 'centre', 'rim', 'outline', 'glow', 'marble', 'insideBg', 'insideBgEdge', 'particle'];

// Level 0 magenta, level 1 periwinkle, then aqua, amber, green, rose repeating.
function paletteForLevel(level) {
  return level < 2 ? level : 2 + ((level - 2) % 4);
}

function populationForLevel(level) {
  if (level === 0) return CFG.popStart;
  if (level === 1) return CFG.popOuter;
  return CFG.popFurther;
}

// Membrane semi-minor radius that holds n cells at the target area coverage.
function membraneRadius(n, aspect) {
  return Math.sqrt(n * 1.3 / (CFG.coverage * aspect));
}

// Live sliders shown in the tuning panel: [key, label, min, max, step].
const TUNING_GROUPS = [
  { name: 'Cells', items: [
    ['outlineWidth', 'outline width', 0.005, 0.1, 0.001],
    ['membraneOutlineWeight', 'membrane outline weight', 0.2, 3, 0.05],
    ['haloSize', 'halo size', 0, 1.2, 0.01],
    ['haloStrength', 'halo strength', 0, 1.5, 0.01],
    ['rimWidth', 'rim width', 0.02, 0.6, 0.01],
    ['rimStrength', 'rim strength', 0, 1.5, 0.01],
    ['rippleStrength', 'ripple strength', 0, 0.15, 0.002],
    ['rippleSpeed', 'ripple speed', 0, 4, 0.05],
    ['stretchStrength', 'stretch strength', 0, 0.6, 0.01],
    ['wobbleFreq', 'wobble frequency', 1, 15, 0.1],
    ['wobbleDamping', 'wobble damping', 0.02, 1.5, 0.01],
    ['squashSoftness', 'squash softness', 0, 2, 0.01],
    ['impactSquish', 'impact squish', 0, 2, 0.01],
    ['interiorStrength', 'interior strength', 0, 1.5, 0.01],
    ['interiorScale', 'interior scale', 0.05, 0.8, 0.005],
    ['interiorBulge', 'interior bulge', 0, 0.8, 0.01],
    ['lagStrength', 'contents lag strength', 0, 3, 0.05],
    ['lagFreq', 'contents lag frequency', 1, 15, 0.1],
    ['lagDamping', 'contents lag damping', 0.05, 1.5, 0.01],
  ]},
  { name: 'Motion', items: [
    ['wanderSpeed', 'wander speed', 0, 6, 0.05],
    ['turnRate', 'turn rate', 0, 4, 0.05],
    ['colonySize', 'colony size', 1, 8, 0.05],
    ['steering', 'steering', 0.2, 8, 0.05],
    ['linDamping', 'linear damping', 0, 2, 0.01],
    ['alignStrength', 'alignment strength', 0, 8, 0.05],
    ['contactSpin', 'contact spin', 0, 1, 0.01],
    ['iterations', 'solver iterations', 1, 8, 1],
    ['relaxation', 'relaxation', 0.1, 1.5, 0.01],
  ]},
  { name: 'Division', items: [
    ['pullApartSpeed', 'pull-apart speed', 0.5, 12, 0.1],
    ['splitStiffness', 'spring stiffness', 20, 800, 5],
    ['splitDamping', 'damping', 0, 60, 0.5],
    ['splitGap', 'gap', 0, 2, 0.02],
    ['splitKick', 'push-apart kick', 0, 4, 0.05],
  ]},
  { name: 'Scene', items: [
    ['particleDensity', 'particle density', 0, 3, 0.05],
    ['innerFadeStart', 'inner fade start', 0.02, 0.5, 0.01],
    ['innerFadeEnd', 'inner fade end', 0.1, 1.2, 0.01],
  ]},
];
