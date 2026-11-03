#!/usr/bin/env node
// Render ships to PNG in headless Chromium — an agent's "eyes".
//   node tools/snapshot.mjs katiya heron           → snapshots/katiya.png …
//   node tools/snapshot.mjs my-ship.json --cockpit
// Prints each ship's telemetry JSON alongside the image path.
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';
import { PRESETS } from '../src/genome.js';

// Playwright is not a dependency (it's large); use whatever install is on the
// machine: `npm i -D playwright && npx playwright install chromium` if needed.
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const cockpit = args.includes('--cockpit');
const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) targets.push(...Object.keys(PRESETS));
mkdirSync('snapshots', { recursive: true });

const port = 8000 + Math.floor(Math.random() * 900);
const srv = await serve(port);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForFunction(() => window.drydock && window.drydock.telemetry, null, { timeout: 90000 });

for (const t of targets) {
  const genome = PRESETS[t] || JSON.parse(readFileSync(t, 'utf8'));
  const tel = await page.evaluate(async (g) => { await window.drydock.load(g); return window.drydock.telemetry; }, genome);
  await page.evaluate((c) => { window.drydock.view(c ? 'cockpit' : 'orbit'); }, cockpit);
  await page.waitForTimeout(600);
  const name = (PRESETS[t] ? t : t.replace(/.*\//, '').replace(/\.json$/, '')) + (cockpit ? '-cockpit' : '');
  const path = `snapshots/${name}.png`;
  await page.locator('#viewport').screenshot({ path });
  console.log(JSON.stringify({ image: path, telemetry: tel }));
}
await browser.close();
srv.close();
