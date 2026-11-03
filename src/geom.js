// geom.js — pure geometry helpers shared by the compiler.
// No DOM, no Three.js: runs identically in the browser and in Node.

/**
 * WASM lifetime scope. manifold-3d objects live in WebAssembly memory that the
 * JS garbage collector cannot see, so every Manifold / CrossSection we create
 * is registered here and freed in one go with `free()`.
 *
 *   const S = new Scope();
 *   const a = S.k(Manifold.cube(1));        // tracked
 *   const b = S.k(a.translate([1, 0, 0]));  // every intermediate is tracked too
 *   S.free();                               // deletes a and b
 */
export class Scope {
  constructor() { this.items = []; }
  k(obj) { this.items.push(obj); return obj; }
  free() {
    for (const o of this.items) { try { o.delete(); } catch (_) { /* already gone */ } }
    this.items.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Monotone cubic (Fritsch–Carlson) interpolant through (xs[i], ys[i]).
 * Smooth like a spline, but never overshoots the data: a hull that narrows
 * between two stations can't bulge past either of them, and widths can't go
 * negative. That property is what lets random genomes stay well-formed.
 */
export function monotoneCubic(xs, ys) {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const d = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
         + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const spow = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);

// ---------------------------------------------------------------------------
// Cross-section rings
// ---------------------------------------------------------------------------

/**
 * Superellipse ring in the XZ plane at a given Y.
 *   n = 2 → ellipse, n < 2 → diamond / chined, n > 2 → slab-sided.
 * `top`/`bot` give separate dorsal height and ventral depth; `tumble` pinches
 * the upper half inward (tumblehome), which reads as "designed" rather than
 * "tube".
 */
export function superRing({ y, zc, hw, top, bot, n, tumble = 0, segments = 48 }) {
  const ring = [];
  const e = 2 / Math.max(0.6, n);
  for (let i = 0; i < segments; i++) {
    const th = (i / segments) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    const up = s > 0;
    const x = hw * spow(c, e) * (up ? 1 - tumble * Math.pow(s, 2) : 1);
    const z = zc + (up ? top : bot) * spow(s, e);
    ring.push([x, y, z]);
  }
  return ring;
}

/**
 * Symmetric NACA-00xx airfoil ring. Chord runs along -Y from the leading
 * edge; thickness along the supplied `up` vector; the section sits at `le`.
 * Returns points ordered: trailing edge → over the top → leading edge → under.
 */
export function airfoilRing({ le, chord, thick, up, chordDir = [0, -1, 0], samples = 18 }) {
  const yt = (x) => 5 * thick * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
  const minHalf = Math.max(0.004 * chord, 0.03);   // ≥ 6 cm thick everywhere: survives simplify(), friendlier to print
  const xs = [];
  for (let i = 0; i <= samples; i++) xs.push(0.5 - 0.5 * Math.cos(Math.PI * i / samples)); // cosine spacing
  const pt = (x, sgn) => {
    const h = Math.max(minHalf, yt(x) * chord) * sgn;
    return [
      le[0] + chordDir[0] * x * chord + up[0] * h,
      le[1] + chordDir[1] * x * chord + up[1] * h,
      le[2] + chordDir[2] * x * chord + up[2] * h,
    ];
  };
  const ring = [];
  for (let i = samples; i >= 1; i--) ring.push(pt(xs[i], +1));   // TE → LE over the top
  ring.push(pt(0, 0));                                              // leading edge
  for (let i = 1; i <= samples; i++) ring.push(pt(xs[i], -1));     // LE → TE underneath
  return ring;
}

// ---------------------------------------------------------------------------
// Loft: rings → watertight Manifold
// ---------------------------------------------------------------------------

/**
 * Skin a sequence of rings (each the same vertex count, consistently ordered)
 * into a closed solid. Each end is either a flat fan cap or collapses to an
 * apex point. The mesh is handed to Manifold.ofMesh, which *validates* that it
 * is an oriented 2-manifold — so this is not "unverified triangle soup": if
 * the loft were broken, construction would fail loudly instead of rendering.
 *
 * Orientation is fixed automatically by signed volume, so callers don't need
 * to care which way their rings wind.
 */
export function loft(wasm, rings, { startApex = null, endApex = null } = {}) {
  const { Manifold, Mesh } = wasm;
  const M = rings[0].length, N = rings.length;
  const verts = [];
  for (const r of rings) for (const p of r) verts.push(p[0], p[1], p[2]);
  const tris = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * M, b = (i + 1) * M;
    for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M;
      tris.push(a + j, b + j, b + j1, a + j, b + j1, a + j1);
    }
  }
  const cap = (ringIdx, apex, flip) => {
    let c;
    if (apex) { c = verts.length / 3; verts.push(apex[0], apex[1], apex[2]); }
    else {
      // centroid fan (rings here are star-shaped about their centroid)
      let cx = 0, cy = 0, cz = 0;
      for (const p of rings[ringIdx]) { cx += p[0]; cy += p[1]; cz += p[2]; }
      c = verts.length / 3; verts.push(cx / M, cy / M, cz / M);
    }
    const base = ringIdx * M;
    for (let j = 0; j < M; j++) {
      const j1 = (j + 1) % M;
      if (flip) tris.push(c, base + j1, base + j); else tris.push(c, base + j, base + j1);
    }
  };
  cap(0, startApex, false);
  cap(N - 1, endApex, true);

  // signed volume → fix orientation so normals point outward
  let vol = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    vol += verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1])
         - verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c])
         + verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c]);
  }
  if (vol < 0) for (let t = 0; t < tris.length; t += 3) { const s = tris[t + 1]; tris[t + 1] = tris[t + 2]; tris[t + 2] = s; }

  const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(tris) });
  mesh.merge();
  const m = Manifold.ofMesh(mesh);
  if (typeof mesh.delete === 'function') mesh.delete();
  return m;
}

// ---------------------------------------------------------------------------
// Seeded RNG (deterministic evolution: same seed, same offspring)
// ---------------------------------------------------------------------------
export function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.gauss = () => {
    const u = Math.max(1e-12, next()), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}
