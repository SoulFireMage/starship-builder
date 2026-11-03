#!/usr/bin/env node
// Headless test suite for the compiler and genome operators.
//   npm test            (or: node tools/test.mjs [--walks 12] [--steps 25])
//
// Checks:
//  1. every preset compiles watertight, as one connected body, warning-free
//  2. WASM hygiene: every Manifold/CrossSection created is deleted (leak = 0)
//  3. random genomes and long mutation walks always compile (robustness of the
//     "any genome in range is a valid ship" contract) and mostly stay clean
//  4. determinism + encode/decode round trip
import Module from 'manifold-3d';
import { compileStarship } from '../src/compiler.js';
import { PRESETS, normalize, mutate, crossover, randomGenome, encodeGenome, decodeGenome } from '../src/genome.js';

const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? +argv[i + 1] : d; };
const WALKS = opt('walks', 8), STEPS = opt('steps', 12), RANDOMS = opt('randoms', 16);

const wasm = await Module();
wasm.setup();

// --- leak instrumentation: wrap every binding that can return a WASM object
// Identity-based: a Set of live handles, so wrappers that call internal
// `_Method`s can't double count and internal temporaries can't go negative.
const liveSet = new Set();
const isObj = (v) => v instanceof wasm.Manifold || v instanceof wasm.CrossSection;
const count = (r) => { if (isObj(r)) liveSet.add(r); else if (Array.isArray(r)) r.forEach(count); return r; };
// wasm.Manifold is a JS wrapper class: instance methods live on the embind
// prototype of real instances, so patch that (found from a sample instance).
const sampleM = wasm.Manifold.cube(1), sampleC = wasm.CrossSection.square(1);
const targets = [wasm.Manifold, wasm.CrossSection, Object.getPrototypeOf(sampleM), Object.getPrototypeOf(sampleC), wasm.Manifold.prototype, wasm.CrossSection.prototype];
sampleM.delete(); sampleC.delete();
{
  for (const target of new Set(targets)) {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (['constructor', 'delete', 'prototype', 'length', 'name', 'isDeleted', 'clone', 'isAliasOf', 'deleteLater'].includes(key)) continue;
      const d = Object.getOwnPropertyDescriptor(target, key);
      if (!d || typeof d.value !== 'function') continue;
      const f = d.value;
      target[key] = function (...a) { return count(f.apply(this, a)); };
    }
  }
}
// `delete` lives on embind's shared ClassHandle prototype, not on Manifold's
{
  let proto = wasm.Manifold.cube(1);
  const probe = proto;
  while (proto && !Object.getOwnPropertyNames(proto).includes('delete')) proto = Object.getPrototypeOf(proto);
  const del = proto.delete;
  proto.delete = function () { liveSet.delete(this); return del.call(this); };
  probe.delete();
  liveSet.clear();
}

let failures = 0;
{ // the detector must be able to see a deliberate leak
  const c = wasm.Manifold.cube(1), t = c.translate([1, 0, 0]);
  if (liveSet.size !== 2) { console.log('leak detector broken: saw', liveSet.size); process.exit(2); }
  c.delete(); t.delete();
  if (liveSet.size !== 0) { console.log('leak detector broken'); process.exit(2); }
}
const ok = (cond, msg) => { if (!cond) { failures++; console.log('  ✗ ' + msg); } return cond; };
const compile = (g, o) => {
  const before = liveSet.size;
  const r = compileStarship(wasm, g, o);
  ok(liveSet.size === before, `leak: ${liveSet.size - before} WASM objects left alive compiling "${r.genome.meta.name}"`);
  liveSet.clear();
  return r;
};

console.log('1. presets');
for (const [key, g] of Object.entries(PRESETS)) {
  for (const quality of ['final', 'draft']) {
    const r = compile(g, { quality });
    const t = r.telemetry;
    ok(t.status === 'MANIFOLD_OK', `${key}/${quality}: status ${t.status}`);
    ok(t.components === 1, `${key}/${quality}: ${t.components} bodies`);
    if (quality === 'final') ok(t.warnings.length === 0, `${key}: warnings ${JSON.stringify(t.warnings)}`);
    ok(r.mesh.indices.length > 0 && r.mesh.positions.length > 0, `${key}: empty mesh`);
    if (quality === 'final') console.log(`  ${key.padEnd(8)} ${String(t.buildTimeMs).padStart(5)} ms  ${String(t.triangles).padStart(6)} tris  genus ${t.genus}  sightline ${t.bridge.forwardSightlineClearPct}%`);
  }
  compile(g, { cutaway: true });
}

console.log('2. robustness: random genomes + mutation walks');
const tally = { compiled: 0, failed: 0, clean: 0, warn: {} };
const judge = (g, label) => {
  try {
    const t = compile(g, { quality: 'draft' }).telemetry;
    tally.compiled++;
    if (!t.warnings.length) tally.clean++;
    for (const w of t.warnings) { const kk = w.split(':')[0]; tally.warn[kk] = (tally.warn[kk] || 0) + 1; }
    if (process.env.DUMP && t.warnings.some((w) => w.startsWith(process.env.DUMP))) console.log(label, JSON.stringify(g));
  } catch (err) {
    tally.failed++;
    ok(false, `${label} failed to compile: ${err.message}\n    genome: ${JSON.stringify(g)}`);
  }
};
for (let i = 0; i < RANDOMS; i++) judge(randomGenome(1000 + i), `random ${1000 + i}`);
const keys = Object.keys(PRESETS);
for (let w = 0; w < WALKS; w++) {
  let g = PRESETS[keys[w % keys.length]];
  for (let s = 0; s < STEPS; s++) {
    g = s % 5 === 4 ? crossover(g, PRESETS[keys[(w + s) % keys.length]], { seed: w * 100 + s }) : mutate(g, { seed: w * 1000 + s, strength: 1.5 });
    judge(g, `walk ${w} step ${s}`);
  }
}
const total = tally.compiled + tally.failed;
console.log(`  ${tally.compiled}/${total} compiled, ${tally.clean} warning-free (${Math.round((100 * tally.clean) / Math.max(1, tally.compiled))}%)`, tally.warn);
ok(tally.failed === 0, 'every genome in range must compile');
ok(tally.clean / Math.max(1, tally.compiled) > 0.5, 'most evolved genomes should be warning-free');

console.log('3. determinism & encoding');
const a = mutate(PRESETS.heron, { seed: 42 }), b = mutate(PRESETS.heron, { seed: 42 });
ok(JSON.stringify(a) === JSON.stringify(b), 'mutate is deterministic for a seed');
const n1 = normalize(a);
ok(JSON.stringify(normalize(n1)) === JSON.stringify(n1), 'normalize is idempotent');
const rt = decodeGenome(encodeGenome(a));
ok(Math.abs(rt.length - a.length) < 1e-3 && rt.wings.length === a.wings.length, 'encode/decode round trip');

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
