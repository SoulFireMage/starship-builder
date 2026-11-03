// compiler.js — Ship Genome → watertight manifold → plain mesh data + telemetry.
//
//   compileStarship(wasm, genome, { cutaway }) → {
//     genome,            // normalised copy of the input
//     mesh, glass,       // { positions, normals, indices } typed arrays (plain JS)
//     decor,             // engine glow points, pilot eye, look direction
//     deck,              // 2D deck-plan polygons from Manifold.slice()
//     telemetry,         // JSON an agent can read to self-check the design
//   }
//
// Pure function of (wasm, genome, opts). No DOM, no Three.js, and every WASM
// object it creates is freed before returning, so the caller never owns
// manifold memory — unless opts.manifold is set, in which case the final ship
// (and glass) Manifolds are also returned and the caller owns those two.
// Runs unchanged in Node (tools/), the browser worker, and ManifoldCAD.
//
// Pipeline (see AGENT_SPEC.md §3):
//   1. Spline-lofted hull, airfoil wings, revolved-profile nacelles, pylons
//   2. Union → carve exterior details (nozzles, intakes)
//   3. Refine, then style warp (bend, droop, ribs, terracing) — refine FIRST
//   4. Bridge placed by the warp's local rigid approximation; cavity carved
//      Euclidean so the deck stays flat; canopy frames + separate glass
//   5. Telemetry (status, genus, components, ray-cast sightline, proportions)
//   6. Scope.free()

import { Scope, monotoneCubic, superRing, airfoilRing, loft, lerp, clamp, smoothstep } from './geom.js';
import { normalize, GENES } from './genome.js';

const DEG = Math.PI / 180;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

export function compileStarship(wasm, genomeIn, opts = {}) {
  const t0 = now();
  const g = normalize(genomeIn);
  const { Manifold } = wasm;
  const S = new Scope();
  const k = (m) => S.k(m);
  const timings = {}; let tm = now();
  const mark = (label, m) => { if (m && opts.profile) m.status(); const t = now(); timings[label] = Math.round(t - tm); tm = t; };
  try {
    const L = g.length, halfL = L / 2;
    const q = opts.quality === 'draft' ? 0.6 : 1;   // ring-density multiplier
    const qi = (n) => Math.max(8, Math.round(n * q));
    const warnings = [];

    // ---------------------------------------------------------------- hull
    const ts = g.hull.stations.map((s) => s.t);
    const ch = {};
    for (const key of ['w', 'top', 'bot', 'z', 'n']) ch[key] = monotoneCubic(ts, g.hull.stations.map((s) => s[key]));
    const hullAt = (t) => ({
      y: -halfL + t * L, hw: (ch.w(t) * L) / 2, top: ch.top(t) * L, bot: ch.bot(t) * L, zc: ch.z(t) * L, n: ch.n(t),
    });
    const tOfY = (y) => clamp((y + halfL) / L, 0, 1);
    const hullTopZ = (y) => { const h = hullAt(tOfY(y)); return h.zc + h.top; };

    const NR = qi(72);
    const hullRings = [];
    for (let i = 0; i < NR; i++) {
      const u = i / NR;
      const t = 0.5 - 0.5 * Math.cos(Math.PI * u);           // dense at stern and bow
      const h = hullAt(t);
      hullRings.push(superRing({ y: h.y, zc: h.zc, hw: Math.max(0.02, h.hw), top: Math.max(0.02, h.top), bot: Math.max(0.02, h.bot), n: h.n, tumble: g.hull.tumble, segments: qi(56) }));
    }
    const hull = k(loft(wasm, hullRings, { endApex: [0, halfL, hullAt(1).zc] }));

    const solids = [hull];
    const cutters = [];
    const engineGlow = [];

    // --------------------------------------------------- stern main engines
    {
      const h = hullAt(0);
      const kE = g.engines.count;
      if (kE > 0) {
        const hh = Math.min(h.top, h.bot);
        // largest bell radius that fits the stern section, then the gene picks a fraction of it
        let r = Math.min(hh * 0.95, (h.hw * 1.7) / kE / 2);
        const inside = (x, rr) => Math.pow((Math.abs(x) + rr) / h.hw, h.n) + Math.pow(rr / hh, h.n) <= 0.92;
        const spacing = () => (kE === 1 ? 0 : Math.min(2.25 * r, (h.hw * 1.7 - 2 * r) / (kE - 1)));
        let guard = 0;
        while (guard++ < 40 && !inside(((kE - 1) / 2) * spacing(), r)) r *= 0.92;
        r *= g.engines.radius / GENES.engines.radius[1];
        const sp = spacing();
        for (let j = 0; j < kE; j++) {
          const x = (j - (kE - 1) / 2) * sp;
          const depth = r * 1.4;
          // protruding bell (cone, wide at the exit) then hollow it out
          const lip = Math.max(0.12 * r, 0.08), root = Math.max(0.4, r * 0.8);      // printable wall, deep root
          const bell = k(k(k(Manifold.cylinder(r * 0.6 + root, r * 0.95 + lip * 1.4, r * 0.95 + lip, 40)).rotate([-90, 0, 0])).translate([x, h.y - r * 0.6, h.zc]));
          solids.push(bell);
          const throat = k(k(k(Manifold.cylinder(depth + r * 0.6 + 0.5, r * 0.95, r * 0.62, 40)).rotate([-90, 0, 0])).translate([x, h.y - r * 0.6 - 0.5, h.zc]));
          cutters.push(throat);
          engineGlow.push({ pos: [x, h.y + depth * 0.92, h.zc], r: r * 0.66, dir: [0, -1, 0] });
        }
      }
    }

    // ---------------------------------------------------------------- wings
    const wingFrames = [];
    let wingCount = 0;
    for (const w of g.wings) {
      const h = hullAt(w.t);
      const z0 = h.zc + (w.z > 0 ? w.z * h.top : w.z * h.bot) * 0.85;
      // the root may not run past the stern face (it would end up inside the nozzles)
      const c0 = Math.max(0.04 * L, Math.min(w.chord * L, 2 * (h.y + halfL - 0.01 * L)));
      const span = w.span * L, c1 = c0 * w.taper;
      const d = w.dihedral * DEG;
      const spanDir = [Math.cos(d), 0, Math.sin(d)], up = [-Math.sin(d), 0, Math.cos(d)];
      const tanSw = Math.tan(clamp(w.sweep, -60, 75) * DEG);
      const frame = (s) => {
        const tip = s > 0.82 ? Math.sqrt(Math.max(0, 1 - ((s - 0.82) / 0.18) ** 2)) : 1; // rounded tip planform
        const c = Math.max(lerp(c0, c1, s) * (0.25 + 0.75 * tip), 0.04);
        let le = [0, h.y + c0 * 0.5, z0];
        le = add3(le, mul3(spanDir, s * span));
        le[1] += -tanSw * s * span - w.crescent * span * s * s + (lerp(c0, c1, s) - c) * -0.5;
        le = add3(le, mul3(up, w.gull * span * Math.sin(Math.PI * s)));
        return { le, c, up, thickScale: 0.35 + 0.65 * tip };
      };
      const K = qi(24), rings = [];
      for (let i = 0; i < K; i++) {
        const s = Math.sin((Math.PI / 2) * (i / (K - 1)));
        const f = frame(s);
        rings.push(airfoilRing({ le: f.le, chord: f.c, thick: w.thick * f.thickScale, up, samples: qi(18) }));
      }
      const right = k(loft(wasm, rings));
      solids.push(right);
      wingCount++;
      if (w.mirror) { solids.push(k(right.mirror([1, 0, 0]))); wingCount++; }
      wingFrames.push({ w, frame, span });
    }

    // ------------------------------------------------------------- nacelles
    let nacelleCount = 0;
    for (const n of g.nacelles) {
      const R = n.radius * L, len = n.length * L;
      let center, anchor, mirror = true;
      if (n.mount === 'wing' && wingFrames[n.wing]) {
        const wf = wingFrames[n.wing];
        const s = clamp(n.at, 0.08, 1);
        const f = wf.frame(s);
        const mid = [f.le[0], f.le[1] - f.c * 0.45, f.le[2]];
        const off = n.offset * L;
        const stand = off === 0 ? 0 : off + Math.sign(off) * R * 0.85;
        center = add3(mid, mul3(f.up, stand));
        center[1] = mid[1] + len * 0.08;
        anchor = mid;
      } else {
        const h = hullAt(clamp(n.at, 0.02, 0.95));
        const phi = n.angle * DEG, c = Math.cos(phi), s = Math.sin(phi);
        const surf = [h.hw * c, h.y, h.zc + (s > 0 ? h.top : h.bot) * s];
        const dir = [c, 0, s];
        center = add3(surf, mul3(dir, R + Math.max(-0.8 * R, n.offset * L)));   // negative = sunk into the hull
        anchor = [surf[0] * 0.4, h.y, h.zc + (surf[2] - h.zc) * 0.4];
        if (Math.abs(c) < 0.08) { mirror = false; center[0] = 0; anchor[0] = 0; }
      }
      const prof = monotoneCubic([0, 0.12, 0.38, 0.78, 1], [n.exhaust, 0.97, 1, 0.96, n.intake]);
      const rings = [];
      const NRn = qi(30);
      for (let i = 0; i < NRn; i++) {
        const u = i / (NRn - 1);
        const r = R * prof(u);
        rings.push(superRing({ y: center[1] - len / 2 + u * len, zc: center[2], hw: r, top: r, bot: r, n: 2, segments: qi(36) })
          .map((p) => [p[0] + center[0], p[1], p[2]]));
      }
      const pod = k(loft(wasm, rings));
      const parts = [pod];
      // pylon: hull of two flattened capsules, anchor → pod
      const dist = Math.hypot(center[0] - anchor[0], center[2] - anchor[2]);
      if (dist > R * 0.6) {
        const th = Math.max(0.12, R * 0.32), pl = len * 0.32;
        const a = k(k(Manifold.sphere(1, 16)).scale([th, pl / 2, th]));
        const p1 = k(a.translate(anchor)), p2 = k(a.translate([center[0], center[1] - len * 0.05, center[2]]));
        parts.push(k(Manifold.hull([p1, p2])));
      }
      // carve intake and exhaust
      const intake = k(k(k(Manifold.cylinder(len * 0.09 + 0.5, R * n.intake * 0.78, R * n.intake * 0.7, 32)).rotate([-90, 0, 0]))
        .translate([center[0], center[1] + len / 2 - len * 0.09, center[2]]));
      const exhaust = k(k(k(Manifold.cylinder(len * 0.14 + 0.5, R * n.exhaust * 0.86, R * n.exhaust * 0.55, 32)).rotate([-90, 0, 0]))
        .translate([center[0], center[1] - len / 2 - 0.5, center[2]]));
      const glow = { pos: [center[0], center[1] - len / 2 + len * 0.12, center[2]], r: R * n.exhaust * 0.6, dir: [0, -1, 0] };
      const assembled = k(k(Manifold.union(parts)).subtract(k(Manifold.union([intake, exhaust]))));
      solids.push(assembled); nacelleCount++;
      engineGlow.push(glow);
      if (mirror) {
        solids.push(k(assembled.mirror([1, 0, 0]))); nacelleCount++;
        engineGlow.push({ ...glow, pos: [-glow.pos[0], glow.pos[1], glow.pos[2]] });
      }
    }

    // ------------------------------------------- union + exterior detailing
    mark('parts');
    let ext = k(Manifold.union(solids));
    if (cutters.length) ext = k(ext.subtract(k(Manifold.union(cutters))));
    mark('union', ext);

    // ------------------------------------------------- style warp (Stage 2)
    const st = g.style;
    const ribLen = st.ribWave * L, ribA = st.ribAmp * L, stepH = st.terraceStep * L;
    const W = (p) => {
      let [x, y, z] = p;
      const h = hullAt(tOfY(y));
      if (ribA > 0) {
        const ez = z - h.zc, r = Math.hypot(x, ez);
        const fade = smoothstep((y + halfL) / (L * 0.08)) * smoothstep((halfL - y) / (L * 0.12));
        const hullR = Math.max(h.hw, h.top, h.bot);               // ribs belong to the hull, not to pods/wings
        const own = 1 - smoothstep((r - hullR * 1.05) / Math.max(0.3, hullR * 0.35));
        const a = ribA * Math.sin((2 * Math.PI * y) / ribLen) * fade * own * Math.min(1, r / (L * 0.02));
        if (r > 1e-6) { x += (a * x) / r; z += (a * ez) / r; }
      }
      if (st.terrace > 0) {
        const wgt = st.terrace * (1 - smoothstep((Math.abs(x) - h.hw * 0.9) / Math.max(0.5, h.hw * 0.4)));
        const q = z / stepH, f = q - Math.floor(q);
        const T = (Math.floor(q) + smoothstep(smoothstep(f))) * stepH;
        z += wgt * (T - z);
      }
      if (st.droop !== 0) {
        const ax = Math.max(0, Math.abs(x) - h.hw * 0.8);
        z -= (st.droop * ax * ax) / L;
      }
      if (st.bend !== 0) { const ty = y / halfL; z += st.bend * L * ty * ty; }
      return [x, y, z];
    };
    const warping = ribA > 0 || st.terrace > 0 || st.droop !== 0 || st.bend !== 0;
    if (warping) {
      // Refine BEFORE warp: a warp only moves existing vertices, so long
      // triangles would alias the ribs/terraces away. (AGENT_SPEC §3 Stage 2)
      let edge = L / 45;
      if (ribA > 0) edge = Math.min(edge, ribLen / 6);
      if (st.terrace > 0) edge = Math.min(edge, stepH / 2.5);
      edge = Math.max(edge, L / 260) * (opts.quality === 'draft' ? 1.8 : 1);
      ext = k(ext.refineToLength(edge));
      const warpFn = (verts, count) => {
        for (let i = 0; i < count; i++) {
          const o = i * 3;
          const q = W([verts[o], verts[o + 1], verts[o + 2]]);
          verts[o] = q[0]; verts[o + 1] = q[1]; verts[o + 2] = q[2];
        }
      };
      ext = k(typeof ext.warpBatch === 'function' ? ext.warpBatch(warpFn) : ext.warp((v) => { const q = W(v); v[0] = q[0]; v[1] = q[1]; v[2] = q[2]; }));
      // collapse the refinement wherever the warp left the surface flat
      // tolerance stays well under the thinnest feature (airfoils are ≥ 6 cm thick)
      ext = k(ext.simplify(Math.min(0.015, L * (opts.quality === 'draft' ? 0.0012 : 0.0004))));
    }
    mark('warp', ext);
    for (const e of engineGlow) e.pos = W(e.pos);

    // ------------------------------------------ bridge + cavity (Stage 3)
    // The bridge is built on the *measured* warped hull, not on the genome's
    // unwarped hull: ray-cast the real dorsal surface at each canopy station
    // and sit the canopy on it. The cavity itself is never warped, so the deck
    // is dead level (AGENT_SPEC §3: warp the exterior, carve Euclidean rooms).
    const b = g.bridge;
    const hb = hullAt(b.t);
    const yC = hb.y;
    const spineW = (y) => W([0, y, hullAt(tOfY(y)).zc])[2];
    const topCache = new Map();
    const topW = (y) => {
      const key = Math.round(y * 1000);
      if (topCache.has(key)) return topCache.get(key);
      const z0 = spineW(y);
      const hits = typeof ext.rayCast === 'function' ? ext.rayCast([0, y, z0], [0, y, z0 + L]) : [];
      const z = hits.length ? hits[0].position[2] : W([0, y, hullTopZ(y)])[2];
      topCache.set(key, z);
      return z;
    };
    const cL = clamp(b.size * L * 0.12, 2.5, L * 0.28);
    const cW = Math.max(1.0, Math.min(hb.hw * 2 * 0.62, cL * 0.48));
    const wall = Math.max(0.1, cW * 0.035);
    // Cockpits are human-scale whatever the ship's size: grow the canopy until
    // there is ≥ 2 m from deck to glass, rather than emitting a cramped bridge.
    const baseZ = topW(yC), minDeck = spineW(yC) - hb.bot * 0.45;
    let cH = cW * 0.42 * b.height;
    for (let i = 0; i < 3; i++) {
      const deck = Math.max(baseZ + cH * 0.5 - 1.25, minDeck);
      cH = Math.max(cH, deck + 2.05 + wall - baseZ);
    }
    const embed = cH * 0.3 + (st.terrace > 0 ? stepH * 0.5 : 0) + ribA;
    const prof = (u) => Math.pow(Math.sin(Math.PI * Math.pow(u, 1.45)), 0.62);
    const canopyRings = (shrink) => {
      const rings = [];
      for (let i = 1; i < 30; i++) {
        const u = i / 30, p = prof(u), y = yC - cL / 2 + u * cL;
        const base = topW(y) - embed;
        const local = hullAt(tOfY(y));                          // hug the hull where it narrows
        const hwMax = Math.max(0.05, local.hw * 0.62);
        rings.push(superRing({ y, zc: base, hw: Math.max(0.01, Math.min((cW / 2) * p, hwMax) - shrink), top: Math.max(0.01, (cH + embed) * p - shrink), bot: Math.max(0.01, cH * 0.6 + embed - shrink), n: 2.3, segments: 40 }));
      }
      return rings;
    };
    const apex = (u) => { const y = yC - cL / 2 + u * cL; return [0, y, topW(y) - embed]; };

    const outer = k(loft(wasm, canopyRings(0), { startApex: apex(0), endApex: apex(1) }));
    const inner0 = k(loft(wasm, canopyRings(wall), { startApex: apex(0.04), endApex: apex(0.96) }));

    let eyeZ = baseZ + cH * 0.5;
    let deckZ = eyeZ - 1.25;
    if (deckZ < minDeck) { deckZ = minDeck; eyeZ = Math.min(deckZ + 1.25, baseZ + cH * 0.75); }
    const headroom = baseZ + cH - wall - deckZ;
    if (headroom < 1.95) warnings.push('BRIDGE_CRAMPED: deck-to-canopy headroom under 1.9 m (raise bridge.height/size or ship length)');

    // the room below the canopy, kept well inside the (measured) hull skin
    const roomRings = [];
    const ry0 = yC - cL * 0.36, ry1 = yC + cL * 0.28;
    for (let i = 0; i < 12; i++) {
      const y = lerp(ry0, ry1, i / 11), h = hullAt(tOfY(y));
      const hwEff = h.hw * (1 - g.hull.tumble * 0.7);           // tumblehome narrows the upper half
      const hw = Math.max(0.3, Math.min(cW * 0.5 - wall, hwEff * 0.45));
      // the section curves away from the centreline: keep the roof's *edge* inside the skin
      const edgeDrop = h.top * (1 - Math.pow(Math.max(0, 1 - Math.pow(hw / Math.max(0.01, hwEff), h.n)), 1 / h.n));
      const roof = Math.max(0.3, topW(y) - edgeDrop - deckZ - wall * 2 - ribA);
      roomRings.push(superRing({ y, zc: deckZ, hw, top: roof, bot: 0.3, n: 4, segments: 32 }));
    }
    const room0 = k(loft(wasm, roomRings));
    const cavity = k(k(Manifold.union([inner0, room0])).trimByPlane([0, 0, 1], deckZ));
    const shell = k(outer.subtract(cavity));

    let framesM = null;
    if (b.struts > 0) {
      const bar = Math.max(0.09, cW * 0.03);
      const bars = [k(k(Manifold.cube([bar, cL * 1.4, cH * 4], true)).translate([0, yC, baseZ]))];
      for (let j = 0; j < b.struts; j++) {
        const y = yC - cL / 2 + (cL * (j + 1)) / (b.struts + 1);
        bars.push(k(k(Manifold.cube([cW * 2, bar, cH * 4], true)).translate([0, y, baseZ])));
      }
      framesM = k(k(Manifold.union(bars)).intersect(shell));
    }
    // ship = exterior + frames, minus the habitable cavity
    let ship = k(k(Manifold.union(framesM ? [ext, framesM] : [ext])).subtract(cavity));
    let glass = k(shell.subtract(ext));
    if (framesM) glass = k(glass.subtract(framesM));

    const pilotEye = [0, yC - cL * 0.12, eyeZ];
    const lookDir = [0, 10, -0.6];
    const ln = Math.hypot(...lookDir); for (let i = 0; i < 3; i++) lookDir[i] /= ln;

    if (opts.cutaway) {
      const cut = k(k(Manifold.cube([L, cL * 1.6, L], true)).translate([0, yC, eyeZ + 0.4 + L / 2]));
      ship = k(ship.subtract(cut));
      glass = k(glass.subtract(cut));
    }

    mark('bridge');
    // -------------------------------------------------- telemetry (Stage 4)
    const status = ship.status();
    mark('carve');
    if (status !== 'NoError' || ship.isEmpty()) throw new Error(`Manifold status ${status}`);
    // Booleans on near-coincident surfaces can leave zero-volume slivers.
    // Those are numerical debris, not design: drop them, count real bodies.
    const parts = ship.decompose().map((p) => k(p));
    if (opts.debugParts) opts.debugParts(parts.map((p) => ({ vol: p.volume(), box: p.boundingBox() })));
    const totalVol = parts.reduce((a, p) => a + Math.max(0, p.volume()), 0);
    const isDebris = (p) => {
      const v = p.volume(), bb = p.boundingBox();
      const thin = Math.min(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
      return v < 1e-3 || v < totalVol * 2e-6 || (v < Math.max(0.02, totalVol * 2e-6) && thin < 0.3);
    };
    // negative-volume components are sealed internal voids, not separate parts
    const voids = parts.filter((p) => p.volume() < -1e-3);
    const real = parts.filter((p) => p.volume() >= -1e-3 && !isDebris(p));
    const debrisRemoved = parts.length - real.length - voids.length;
    if (debrisRemoved > 0) ship = k(Manifold.compose([...real, ...voids]));
    const components = real.length;
    if (components > 1) warnings.push(`DISCONNECTED: ${components} separate bodies (a part is floating free)`);
    const box = ship.boundingBox();
    const dims = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];

    mark('decompose');
    const proj = k(ship.project());
    const planformFill = proj.area() / Math.max(1e-6, dims[0] * dims[1]);

    // sightline: a 7×5 fan of rays from the pilot's eye, cast against the ship
    // *without* canopy frames (struts are deliberate; we're asking whether the
    // bow and spine block the horizon — AGENT_SPEC §3 Stage 4)
    const sightBody = framesM ? k(ext.subtract(cavity)) : ship;
    let clear = 0, total = 0;
    const reach = L * 1.6;
    for (let yi = -3; yi <= 3; yi++) {
      for (let pi = -2; pi <= 2; pi++) {
        const yaw = yi * 6 * DEG, pit = pi * 4 * DEG;
        const base = [lookDir[0], lookDir[1], lookDir[2]];
        const dir = [
          base[0] * Math.cos(yaw) + base[1] * Math.sin(yaw),
          -base[0] * Math.sin(yaw) + base[1] * Math.cos(yaw),
          base[2] + Math.sin(pit),
        ];
        const end = add3(pilotEye, mul3(dir, reach));
        const hits = typeof sightBody.rayCast === 'function' ? sightBody.rayCast(pilotEye, end) : [];
        total++; if (hits.length === 0) clear++;
      }
    }
    const clearPct = Math.round((1000 * clear) / total) / 10;
    if (clearPct < 75) warnings.push(`BOW_OCCLUSION: only ${clearPct}% of the forward sight-fan is clear`);

    mark('sightline');
    const sl = k(ship.slice(pilotEye[2] - 0.6));
    const deck = sl.toPolygons().map((ring) => ring.map((p) => [p[0], p[1]]));

    const meshOut = extract(k(ship.calculateNormals(0, 50)));
    const glassOut = glass.isEmpty() ? null : extract(k(glass.calculateNormals(0, 80)));
    mark('extract');

    const telemetry = {
      schema: 'starship-telemetry/2',
      name: g.meta.name,
      status: status === 'NoError' ? 'MANIFOLD_OK' : status,
      buildTimeMs: Math.round(now() - t0),
      dimensionsM: { length: r1(dims[1]), beam: r1(dims[0]), height: r1(dims[2]) },
      hullVolumeM3: r1(ship.volume()),
      surfaceAreaM2: r1(ship.surfaceArea()),
      genus: ship.genus(),
      components,
      debrisRemoved,
      sealedVoids: voids.length,
      triangles: ship.numTri(),
      proportions: { beamToLength: r3(dims[0] / dims[1]), heightToLength: r3(dims[2] / dims[1]), planformFill: r3(planformFill) },
      parts: { hullStations: g.hull.stations.length, wingSurfaces: wingCount, nacelles: nacelleCount, mainEngines: g.engines.count, canopyStruts: b.struts },
      bridge: {
        pilotEyeXYZ: pilotEye.map(r2), deckHeadroomM: r2(headroom), canopyLengthM: r2(cL),
        forwardSightlineClearPct: clearPct, sightlineRays: total,
        habitableVolumeM3: r1(cavity.volume()),
      },
      warnings,
      timingsMs: timings,
    };

    // printable: one welded solid (hull + whole canopy skin), for STL export
    const printMesh = opts.printable ? extract(k(k(shell.isEmpty() ? ship : ship.add(shell)).calculateNormals(0, 50))) : null;
    const out = { genome: g, printMesh, mesh: meshOut, glass: glassOut, decor: { engines: engineGlow, pilotEye, lookDir }, deck, telemetry };
    if (opts.manifold) {
      // Hand live manifolds to the caller (e.g. a ManifoldCAD script); they are
      // released from the scope, so the caller owns and must delete them.
      const own = (m) => { const i = S.items.indexOf(m); if (i >= 0) S.items.splice(i, 1); return m; };
      out.manifold = own(ship);
      out.glassManifold = glass.isEmpty() ? null : own(glass);
      // the whole canopy skin (glass + frames): overlaps hull and frames by
      // volume, so union welds it into one printable body (the glass alone
      // only touches them along shared faces)
      out.canopyManifold = shell.isEmpty() ? null : own(shell);
    }
    return out;
  } finally {
    S.free();
  }
}

const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;

function extract(m) {
  const mesh = m.getMesh();
  const np = mesh.numProp, nv = mesh.vertProperties.length / np;
  const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    for (let j = 0; j < 3; j++) {
      positions[i * 3 + j] = mesh.vertProperties[i * np + j];
      normals[i * 3 + j] = np >= 6 ? mesh.vertProperties[i * np + 3 + j] : 0;
    }
  }
  return { positions, normals, indices: new Uint32Array(mesh.triVerts) };
}
