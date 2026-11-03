#!/usr/bin/env node
// Headless compile: prints telemetry JSON for a preset name or a genome file.
//   node tools/compile.mjs katiya
//   node tools/compile.mjs my-ship.json [--cutaway]
import { readFileSync } from 'node:fs';
import Module from 'manifold-3d';
import { compileStarship } from '../src/compiler.js';
import { PRESETS, normalize } from '../src/genome.js';

const arg = process.argv[2] || 'katiya';
const genome = PRESETS[arg] || normalize(JSON.parse(readFileSync(arg, 'utf8')));
const wasm = await Module(); wasm.setup();
const out = compileStarship(wasm, genome, { cutaway: process.argv.includes('--cutaway') });
console.log(JSON.stringify(out.telemetry, null, 2));
