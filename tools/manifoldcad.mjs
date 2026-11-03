#!/usr/bin/env node
// Write a self-contained ManifoldCAD script for a preset or genome file.
//   node tools/manifoldcad.mjs katiya > katiya.mjs
//   node tools/manifoldcad.mjs my-ship.json --mm 200 > my-ship.mjs
//   npx manifold-cad katiya.mjs katiya.3mf      # then print / inspect
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS, normalize } from '../src/genome.js';
import { buildManifoldCadScript, SOURCE_FILES } from '../src/manifoldcad.js';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--')) || 'katiya';
const mmIdx = args.indexOf('--mm');
const genome = normalize(PRESETS[target] || JSON.parse(readFileSync(target, 'utf8')));
const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const sources = Object.fromEntries(SOURCE_FILES.map((f) => [f, readFileSync(join(src, f), 'utf8')]));
process.stdout.write(buildManifoldCadScript({ sources, genome, printLengthMm: mmIdx >= 0 ? +args[mmIdx + 1] : 150 }));
