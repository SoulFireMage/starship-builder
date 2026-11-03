#!/usr/bin/env node
// Stamp a release version everywhere it must agree, so browsers can't run a
// stale cached script (the site's CDN caches .js for hours; each release
// changes every module URL via ?v=VERSION).
//
//   node tools/version.mjs            → bump the patch number (2.4.0 → 2.4.1)
//   node tools/version.mjs 2.5.0      → set an explicit version
//   node tools/version.mjs --check    → exit 1 if anything is out of sync (npm test runs this)
//
// Writes: src/version.js, version.json, every relative import/URL in src/*.js,
// and the app script tag in index.html.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(root, p);
const current = JSON.parse(readFileSync(rel('version.json'), 'utf8')).version;

// every relative module reference: './x.js' or './x.js?v=…' (imports, new URL, script src, fetch of sources)
const REF = /(\.\/(?:src\/)?[\w-]+\.js)(\?v=[\w.-]+)?(?=['"`])/g;
const files = [...readdirSync(rel('src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`), 'index.html'];

const arg = process.argv[2];
if (arg === '--check') {
  const bad = [];
  const vjs = readFileSync(rel('src/version.js'), 'utf8');
  if (!vjs.includes(`VERSION = '${current}'`)) bad.push('src/version.js');
  for (const f of files) {
    for (const m of readFileSync(rel(f), 'utf8').matchAll(REF)) if (m[2] !== `?v=${current}`) bad.push(`${f}: ${m[0]}`);
  }
  if (bad.length) { console.log(`version ${current} out of sync:\n  ${bad.join('\n  ')}\nrun: node tools/version.mjs ${current}`); process.exit(1); }
  console.log(`version ${current}: all module URLs in sync`);
  process.exit(0);
}

let next = arg;
if (!next) { const p = current.split('.').map(Number); p[2] += 1; next = p.join('.'); }
if (!/^\d+\.\d+\.\d+$/.test(next)) { console.error(`not a version: ${next}`); process.exit(2); }
const date = new Date().toISOString().slice(0, 10);

writeFileSync(rel('version.json'), JSON.stringify({ version: next, date }, null, 2) + '\n');
writeFileSync(rel('src/version.js'),
  `// version.js — written by tools/version.mjs; do not edit by hand.\nexport const VERSION = '${next}';\nexport const RELEASED = '${date}';\n`);
for (const f of files) {
  const src = readFileSync(rel(f), 'utf8');
  const out = src.replace(REF, (_, path) => `${path}?v=${next}`);
  if (out !== src) writeFileSync(rel(f), out);
}
console.log(`${current} → ${next} (${date})`);
