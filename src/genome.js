// genome.js — the Ship Genome (schema v2): ranges, presets, validation and
// evolution operators (mutate / crossover / random). Pure data, no geometry.
//
// Design rule: every gene is a *proportion or angle*, not raw geometry.
// Lengths are fractions of overall ship length; parts are attached *relative
// to the hull* (position along it, height on it). So any value inside its
// range compiles to a connected, plausibly-proportioned ship — the compiler
// owns beauty, the genome owns variety.

import { rng, clamp } from './geom.js?v=2.4.0';

export const SCHEMA = 'starship-genome/2';

/** Gene ranges: [min, max, mutationSigma]. Used for clamping, mutation, UI. */
export const GENES = {
  length: [30, 140, 6],
  hull: {
    tumble: [0, 0.45, 0.06],
    station: {
      t: [0, 1, 0.03],
      w: [0.004, 0.36, 0.025],     // full beam  / length
      top: [0.002, 0.14, 0.012],   // dorsal height above spine / length
      bot: [0.002, 0.12, 0.010],   // ventral depth below spine / length
      z: [-0.08, 0.08, 0.008],     // spine height / length
      n: [1.2, 6, 0.35],           // superellipse exponent: <2 chined, >2 slab-sided
    },
  },
  style: {
    bend: [-0.06, 0.06, 0.01],     // banana curve of the whole spine (/length)
    droop: [-0.6, 0.6, 0.08],      // wing anhedral(+)/gull-up(−) curvature
    ribAmp: [0, 0.012, 0.002],     // rib fluting depth (/length)
    ribWave: [0.02, 0.12, 0.01],   // rib wavelength (/length)
    terrace: [0, 1, 0.12],         // soft-stepped armour terracing
    terraceStep: [0.01, 0.05, 0.005],
  },
  wing: {
    t: [0.05, 0.9, 0.04],          // root position along hull (0 stern → 1 bow)
    z: [-0.9, 0.9, 0.12],          // root height on hull (−1 belly → +1 spine top)
    span: [0.04, 0.6, 0.04],       // half-span / length
    chord: [0.04, 0.6, 0.04],      // root chord / length
    taper: [0.08, 1, 0.08],
    sweep: [-20, 70, 5],           // degrees
    dihedral: [-40, 90, 6],        // degrees (90 = vertical fin)
    gull: [-0.25, 0.25, 0.04],     // mid-span kink along the wing normal (/span)
    crescent: [-0.3, 0.5, 0.06],   // curved sweep (tips swing aft)
    thick: [0.04, 0.22, 0.015],    // thickness / chord
  },
  nacelle: {
    at: [0, 1, 0.06],              // hull: t along hull; wing: span fraction
    angle: [-150, 150, 12],        // hull mount: degrees around hull (0 = beam, 90 = dorsal)
    offset: [-0.06, 0.06, 0.006],  // stand-off from the mount (/length)
    length: [0.12, 0.6, 0.03],
    radius: [0.012, 0.07, 0.005],
    intake: [0.4, 1, 0.06],        // intake radius ratio
    exhaust: [0.4, 1, 0.06],
  },
  engines: { count: [0, 4, 1], radius: [0.2, 0.9, 0.06] },
  bridge: { t: [0.45, 0.92, 0.03], size: [0.5, 1.8, 0.1], height: [0.5, 1.6, 0.08], struts: [0, 5, 1] },
};

export const LIMITS = { stations: [3, 9], wings: [0, 8], nacelles: [0, 4] };

// ---------------------------------------------------------------------------
// Presets (hand-tuned starting points; all ordinary genomes)
// ---------------------------------------------------------------------------
const st = (t, w, top, bot, z, n) => ({ t, w, top, bot, z, n });

export const PRESETS = {
  katiya: {
    schema: SCHEMA,
    meta: { name: 'Katiya-Class Scout', author: 'claude', lineage: [] },
    length: 64,
    hull: {
      tumble: 0.18,
      stations: [st(0, 0.11, 0.05, 0.04, 0.01, 2.2), st(0.3, 0.16, 0.07, 0.05, 0.0, 2.1),
                 st(0.62, 0.15, 0.065, 0.045, 0.004, 2.0), st(0.88, 0.07, 0.035, 0.022, -0.012, 1.9),
                 st(1, 0.006, 0.003, 0.003, -0.03, 2)],
    },
    style: { bend: -0.018, droop: 0.28, ribAmp: 0.0016, ribWave: 0.045, terrace: 0, terraceStep: 0.02 },
    wings: [
      { t: 0.34, z: -0.1, span: 0.36, chord: 0.36, taper: 0.22, sweep: 38, dihedral: -4, gull: 0.08, crescent: 0.22, thick: 0.11, mirror: true },
      { t: 0.18, z: 0.55, span: 0.11, chord: 0.18, taper: 0.35, sweep: 48, dihedral: 62, gull: 0, crescent: 0.15, thick: 0.1, mirror: true },
    ],
    nacelles: [
      { mount: 'wing', wing: 0, at: 0.62, angle: 0, offset: -0.012, length: 0.3, radius: 0.026, intake: 0.75, exhaust: 0.8 },
    ],
    engines: { count: 2, radius: 0.55 },
    bridge: { t: 0.72, size: 1.0, height: 1.0, struts: 3 },
    palette: { primary: '#2b3f37', secondary: '#16201c', accent: '#7fe0c2', glow: '#38ffd2' },
  },

  heron: {
    schema: SCHEMA,
    meta: { name: 'Heron Interceptor', author: 'claude', lineage: [] },
    length: 52,
    hull: {
      tumble: 0.32,
      stations: [st(0, 0.13, 0.04, 0.03, 0.006, 1.6), st(0.35, 0.15, 0.05, 0.03, 0.002, 1.5),
                 st(0.7, 0.08, 0.04, 0.02, 0.0, 1.45), st(1, 0.004, 0.002, 0.002, -0.006, 1.5)],
    },
    style: { bend: -0.006, droop: -0.08, ribAmp: 0, ribWave: 0.05, terrace: 0, terraceStep: 0.02 },
    wings: [
      { t: 0.22, z: 0.0, span: 0.34, chord: 0.46, taper: 0.12, sweep: 52, dihedral: -2, gull: 0, crescent: 0.32, thick: 0.06, mirror: true },
      { t: 0.12, z: 0.7, span: 0.12, chord: 0.2, taper: 0.3, sweep: 55, dihedral: 68, gull: 0, crescent: 0.1, thick: 0.07, mirror: true },
      { t: 0.68, z: 0.0, span: 0.08, chord: 0.1, taper: 0.3, sweep: 50, dihedral: 0, gull: 0, crescent: 0, thick: 0.07, mirror: true },
    ],
    nacelles: [],
    engines: { count: 2, radius: 0.6 },
    bridge: { t: 0.66, size: 0.9, height: 1.05, struts: 2 },
    palette: { primary: '#d9dee6', secondary: '#4b5563', accent: '#e23b3b', glow: '#7cc8ff' },
  },

  bastion: {
    schema: SCHEMA,
    meta: { name: 'Bastion Frigate', author: 'claude', lineage: [] },
    length: 96,
    hull: {
      tumble: 0.25,
      stations: [st(0, 0.17, 0.07, 0.05, 0.01, 4.5), st(0.25, 0.2, 0.08, 0.06, 0.01, 5),
                 st(0.65, 0.17, 0.07, 0.05, 0.0, 5), st(0.92, 0.1, 0.05, 0.035, -0.004, 4),
                 st(1, 0.05, 0.025, 0.02, -0.006, 3.5)],
    },
    style: { bend: 0, droop: 0, ribAmp: 0, ribWave: 0.05, terrace: 0.75, terraceStep: 0.022 },
    wings: [
      { t: 0.3, z: -0.3, span: 0.16, chord: 0.24, taper: 0.6, sweep: 20, dihedral: -10, gull: 0, crescent: 0, thick: 0.16, mirror: true },
      { t: 0.12, z: 0.8, span: 0.08, chord: 0.16, taper: 0.55, sweep: 35, dihedral: 90, gull: 0, crescent: 0, thick: 0.16, mirror: false },
    ],
    nacelles: [
      { mount: 'hull', at: 0.18, angle: 25, offset: 0.012, length: 0.34, radius: 0.04, intake: 0.85, exhaust: 0.9 },
      { mount: 'hull', at: 0.22, angle: -35, offset: 0.008, length: 0.26, radius: 0.03, intake: 0.85, exhaust: 0.9 },
    ],
    engines: { count: 3, radius: 0.55 },
    bridge: { t: 0.8, size: 0.8, height: 0.8, struts: 4 },
    palette: { primary: '#5b6068', secondary: '#2c3036', accent: '#f0b429', glow: '#ff9d3c' },
  },

  lantern: {
    schema: SCHEMA,
    meta: { name: 'Lantern Explorer', author: 'claude', lineage: [] },
    length: 110,
    hull: {
      tumble: 0.05,
      stations: [st(0, 0.07, 0.035, 0.035, 0.0, 2), st(0.2, 0.1, 0.05, 0.05, 0.0, 2),
                 st(0.5, 0.06, 0.03, 0.03, 0.0, 2), st(0.78, 0.16, 0.08, 0.07, 0.006, 2.1),
                 st(0.95, 0.12, 0.06, 0.05, 0.004, 2), st(1, 0.03, 0.015, 0.015, 0.0, 2)],
    },
    style: { bend: 0.01, droop: -0.15, ribAmp: 0, ribWave: 0.03, terrace: 0, terraceStep: 0.02 },
    wings: [
      { t: 0.16, z: 0.0, span: 0.2, chord: 0.18, taper: 0.5, sweep: 30, dihedral: 15, gull: 0.1, crescent: 0.1, thick: 0.1, mirror: true },
    ],
    nacelles: [
      { mount: 'wing', wing: 0, at: 0.98, angle: 0, offset: 0.0, length: 0.42, radius: 0.03, intake: 0.7, exhaust: 0.75 },
    ],
    engines: { count: 1, radius: 0.7 },
    bridge: { t: 0.86, size: 1.3, height: 1.1, struts: 5 },
    palette: { primary: '#e8e2d4', secondary: '#7a6a55', accent: '#3b82c4', glow: '#a5f3ff' },
  },
};

// ---------------------------------------------------------------------------
// Validation / normalisation
// ---------------------------------------------------------------------------
const clampTo = (v, r) => clamp(Number.isFinite(+v) ? +v : (r[0] + r[1]) / 2, r[0], r[1]);
const clampObj = (obj, spec) => {
  const out = { ...obj };
  for (const k of Object.keys(spec)) if (Array.isArray(spec[k])) out[k] = clampTo(obj?.[k], spec[k]);
  return out;
};

/** Returns a deep-copied genome with every gene clamped and structure repaired. */
export function normalize(g) {
  const base = PRESETS.katiya;
  g = JSON.parse(JSON.stringify(g || base));
  const out = {
    schema: SCHEMA,
    meta: { name: 'Unnamed', author: 'unknown', lineage: [], ...(g.meta || {}) },
    length: clampTo(g.length ?? base.length, GENES.length),
    hull: { tumble: clampTo(g.hull?.tumble ?? 0.1, GENES.hull.tumble), stations: [] },
    style: clampObj({ ...base.style, ...(g.style || {}) }, GENES.style),
    wings: (g.wings || []).slice(0, LIMITS.wings[1]).map((w) => ({
      ...clampObj(w, GENES.wing), mirror: w.mirror !== false,
    })),
    nacelles: (g.nacelles || []).slice(0, LIMITS.nacelles[1]).map((n) => ({
      ...clampObj(n, GENES.nacelle),
      mount: n.mount === 'wing' ? 'wing' : 'hull',
      wing: Math.max(0, Math.floor(n.wing || 0)),
    })),
    engines: clampObj({ count: 2, radius: 0.5, ...(g.engines || {}) }, GENES.engines),
    bridge: clampObj({ ...base.bridge, ...(g.bridge || {}) }, GENES.bridge),
    palette: { ...base.palette, ...(g.palette || {}) },
  };
  out.engines.count = Math.round(out.engines.count);
  out.bridge.struts = Math.round(out.bridge.struts);
  // a wing-mounted nacelle must reference an existing, mirrored, non-vertical wing
  out.nacelles = out.nacelles.map((n) => {
    if (n.mount !== 'wing') return n;
    const w = out.wings[n.wing];
    if (!w || !w.mirror || Math.abs(w.dihedral) > 60) return { ...n, mount: 'hull', at: clamp(n.at, 0.1, 0.5) };
    return n;
  });

  let sts = (g.hull?.stations || base.hull.stations).map((s) => clampObj(s, GENES.hull.station));
  sts.sort((a, b) => a.t - b.t);
  // stations must span the whole length and be distinct
  sts[0].t = 0; sts[sts.length - 1].t = 1;
  for (let i = 1; i < sts.length; i++) if (sts[i].t - sts[i - 1].t < 0.04) sts[i].t = Math.min(1, sts[i - 1].t + 0.04);
  sts = sts.filter((s, i) => i === 0 || s.t > sts[i - 1].t || i === sts.length - 1);
  // only the bow tip may go needle-thin; interior sections keep real structure
  for (let i = 0; i < sts.length - 1; i++) {
    sts[i].w = Math.max(sts[i].w, 0.03);
    sts[i].top = Math.max(sts[i].top, 0.01);
    sts[i].bot = Math.max(sts[i].bot, 0.008);
  }
  while (sts.length < LIMITS.stations[0]) sts.splice(1, 0, { ...sts[0], t: 0.5 });
  sts.sort((a, b) => a.t - b.t);
  out.hull.stations = sts.slice(0, LIMITS.stations[1]);
  return out;
}

// ---------------------------------------------------------------------------
// Evolution operators
// ---------------------------------------------------------------------------
const mutObj = (obj, spec, R, rate) => {
  const out = { ...obj };
  for (const k of Object.keys(spec)) {
    if (!Array.isArray(spec[k]) || typeof obj[k] !== 'number') continue;
    if (R() < rate) out[k] = clamp(obj[k] + R.gauss() * spec[k][2], spec[k][0], spec[k][1]);
  }
  return out;
};

/**
 * Point mutation of continuous genes, plus rare structural mutations
 * (add/remove a hull station, wing or nacelle). `strength` scales sigma.
 */
export function mutate(genome, { seed = Date.now(), rate = 0.35, strength = 1 } = {}) {
  const R = rng(seed);
  const gauss = R.gauss; R.gauss = () => gauss() * strength;
  const g = normalize(genome);
  g.length = mutObj({ length: g.length }, { length: GENES.length }, R, rate * 0.5).length;
  g.hull.tumble = mutObj(g.hull, { tumble: GENES.hull.tumble }, R, rate).tumble;
  g.hull.stations = g.hull.stations.map((s, i, a) => {
    const m = mutObj(s, GENES.hull.station, R, rate);
    if (i === 0 || i === a.length - 1) m.t = s.t;
    return m;
  });
  g.style = mutObj(g.style, GENES.style, R, rate * 0.6);
  g.wings = g.wings.map((w) => ({ ...mutObj(w, GENES.wing, R, rate), mirror: w.mirror }));
  g.nacelles = g.nacelles.map((n) => ({ ...mutObj(n, GENES.nacelle, R, rate), mount: n.mount, wing: n.wing }));
  g.engines = mutObj(g.engines, GENES.engines, R, rate * 0.5);
  g.bridge = mutObj(g.bridge, GENES.bridge, R, rate * 0.5);

  // structural mutations (rare)
  const sr = 0.06 * strength;
  if (R() < sr && g.hull.stations.length < LIMITS.stations[1]) {
    const i = 1 + Math.floor(R() * (g.hull.stations.length - 1));
    const a = g.hull.stations[i - 1], b = g.hull.stations[i];
    const mid = {}; for (const k of Object.keys(a)) mid[k] = (a[k] + b[k]) / 2;
    g.hull.stations.splice(i, 0, mutObj(mid, GENES.hull.station, R, 1));
  }
  if (R() < sr && g.hull.stations.length > LIMITS.stations[0]) g.hull.stations.splice(1 + Math.floor(R() * (g.hull.stations.length - 2)), 1);
  if (R() < sr && g.wings.length < LIMITS.wings[1]) g.wings.push(randomWing(R));
  if (R() < sr * 0.7 && g.wings.length > 1) g.wings.splice(1 + Math.floor(R() * (g.wings.length - 1)), 1);
  if (R() < sr && g.nacelles.length < LIMITS.nacelles[1]) g.nacelles.push(randomNacelle(R, g.wings.length));
  if (R() < sr * 0.7 && g.nacelles.length > 0) g.nacelles.splice(Math.floor(R() * g.nacelles.length), 1);
  if (R() < 0.04 * strength) shiftPalette(g.palette, R);

  g.meta = { ...g.meta, lineage: [...(g.meta.lineage || []), `mutate:${seed >>> 0}`].slice(-24) };
  return normalize(g);
}

/** Uniform crossover by gene block; arrays crossed element-wise. */
export function crossover(a, b, { seed = Date.now() } = {}) {
  const R = rng(seed);
  a = normalize(a); b = normalize(b);
  const pick = (x, y) => (R() < 0.5 ? x : y);
  const mixObj = (x, y) => { const o = {}; for (const k of Object.keys(x)) o[k] = (k in y && R() < 0.5) ? y[k] : x[k]; return o; };
  const mixArr = (x, y) => {
    const n = pick(x.length, y.length), out = [];
    for (let i = 0; i < n; i++) out.push(x[i] && y[i] ? mixObj(x[i], y[i]) : (x[i] || y[i]));
    return out;
  };
  const hullSrc = pick(a.hull, b.hull);
  const g = {
    schema: SCHEMA,
    meta: { name: `${a.meta.name} × ${b.meta.name}`, author: a.meta.author, lineage: [...(a.meta.lineage || []), `cross:${b.meta.name}`].slice(-24) },
    length: (a.length + b.length) / 2,
    hull: { tumble: pick(a.hull.tumble, b.hull.tumble), stations: hullSrc.stations },
    style: mixObj(a.style, b.style),
    wings: mixArr(a.wings, b.wings),
    nacelles: mixArr(a.nacelles, b.nacelles),
    engines: mixObj(a.engines, b.engines),
    bridge: mixObj(a.bridge, b.bridge),
    palette: pick(a.palette, b.palette),
  };
  // blend hull stations when both have the same count (keeps silhouettes coherent)
  if (a.hull.stations.length === b.hull.stations.length) {
    const f = R();
    g.hull.stations = a.hull.stations.map((s, i) => {
      const o = {}; for (const k of Object.keys(s)) o[k] = s[k] * (1 - f) + b.hull.stations[i][k] * f; return o;
    });
  }
  return normalize(g);
}

function randomWing(R) {
  const r = (k) => { const [lo, hi] = GENES.wing[k]; return lo + R() * (hi - lo); };
  const vertical = R() < 0.25;
  return {
    t: r('t'), z: vertical ? 0.6 + R() * 0.3 : r('z') * 0.6, span: 0.06 + R() * (vertical ? 0.1 : 0.35),
    chord: 0.1 + R() * 0.3, taper: r('taper'), sweep: 10 + R() * 50, dihedral: vertical ? 55 + R() * 35 : -15 + R() * 30,
    gull: r('gull') * 0.5, crescent: r('crescent') * 0.6, thick: 0.06 + R() * 0.08, mirror: !(vertical && R() < 0.4),
  };
}
function randomNacelle(R, nWings) {
  const onWing = nWings > 0 && R() < 0.5;
  return {
    mount: onWing ? 'wing' : 'hull', wing: 0, at: onWing ? 0.3 + R() * 0.7 : 0.1 + R() * 0.4,
    angle: -60 + R() * 120, offset: -0.01 + R() * 0.03, length: 0.18 + R() * 0.25, radius: 0.018 + R() * 0.03,
    intake: 0.6 + R() * 0.35, exhaust: 0.6 + R() * 0.35,
  };
}
function shiftPalette(p, R) {
  const rot = (hex, d) => {
    const n = parseInt(hex.slice(1), 16);
    let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, dd = mx - mn;
    let h = 0, s = 0;
    if (dd) {
      s = dd / (1 - Math.abs(2 * l - 1));
      h = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
    }
    h = (h * 60 + d + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return '#' + [r1, g1, b1].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
  };
  const d = (R() - 0.5) * 90;
  p.accent = rot(p.accent, d); p.glow = rot(p.glow, d * 0.5);
}

/** A fresh random ship. Built from a random preset, heavily mutated, so it starts sane. */
export function randomGenome(seed = Date.now()) {
  const R = rng(seed);
  const keys = Object.keys(PRESETS);
  let g = crossover(PRESETS[R.pick(keys)], PRESETS[R.pick(keys)], { seed: seed + 1 });
  g = mutate(g, { seed: seed + 2, rate: 0.8, strength: 2 });
  g.meta = { name: `Seed ${seed >>> 0}`, author: 'random', lineage: [`random:${seed >>> 0}`] };
  return g;
}

// ---------------------------------------------------------------------------
// Sharing: compact URL-safe encoding
// ---------------------------------------------------------------------------
const round = (k, v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v);
export function encodeGenome(g) {
  const json = JSON.stringify(g, round);
  const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(json))) : Buffer.from(json).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeGenome(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const json = typeof atob === 'function' ? decodeURIComponent(escape(atob(b64))) : Buffer.from(b64, 'base64').toString();
  return normalize(JSON.parse(json));
}
