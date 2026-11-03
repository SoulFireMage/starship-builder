#!/usr/bin/env node
// Browser UI regression test (needs Playwright + Chromium):  node tools/ui-test.mjs
// Drives the real page and checks that controls actually change the genome
// and the compiled ship, including the "second slider did nothing" bug.
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const port = 8100 + Math.floor(Math.random() * 800);
const srv = await serve(port);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/?preset=katiya`);
await page.waitForFunction(() => window.drydock && window.drydock.telemetry, null, { timeout: 90000 });

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; };
const G = () => page.evaluate(() => window.drydock.genome);
const idle = () => page.evaluate(() => window.drydock.idle());
const open = (sel) => page.evaluate((s) => { document.querySelector(s).closest('details').open = true; }, sel);
// set the Nth range input inside a section, firing input + change like a drag
const drag = (section, nth, frac) => page.evaluate(({ section, nth, frac }) => {
  const r = document.querySelectorAll(`${section} input[type=range]:not(:disabled)`)[nth];
  r.dispatchEvent(new Event('pointerdown'));
  r.value = +r.min + (r.max - r.min) * frac;
  r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change'));
  return r.getAttribute('aria-label');
}, { section, nth, frac });
const click = async (section, label) => {
  await page.evaluate(({ section, label }) => {
    const b = [...document.querySelectorAll(`${section} button`)].find((x) => x.textContent.trim() === label);
    if (!b) throw new Error(`no button ${label}`); if (b.disabled) throw new Error(`button ${label} disabled: ${b.title}`); b.click();
  }, { section, label });
  await idle();
};

console.log('sliders keep applying after the first release');
await open('#sec-style');
const g0 = await G();
await drag('#sec-style', 0, 0.8); await idle();          // length
const g1 = await G();
ok(g1.length !== g0.length, 'first slider changed the genome');
await drag('#sec-style', 1, 0.9); await idle();          // tumblehome, the one that used to go stale
const g2 = await G();
ok(g2.hull.tumble !== g1.hull.tumble, 'second slider changed the genome');
await drag('#sec-style', 2, 0.1); await idle();
ok((await G()).style.bend !== g2.style.bend, 'third slider changed the genome');
const v1 = (await page.evaluate(() => window.drydock.telemetry)).hullVolumeM3;
await open('#sec-hull'); await drag('#sec-hull', 1, 0.9); await idle();
ok((await page.evaluate(() => window.drydock.telemetry)).hullVolumeM3 !== v1, 'hull station slider changed the compiled ship');

console.log('wings and fins');
await open('#sec-wings');
while ((await G()).wings.length) await click('#sec-wings', 'Remove');
ok((await G()).wings.length === 0, 'can remove every wing');
await click('#sec-wings', '+ Wing pair');
await click('#sec-wings', '+ Wing pair');
await click('#sec-wings', '+ Wing pair');
await click('#sec-wings', '+ Fin');
await click('#sec-wings', 'Duplicate');
let g = await G();
ok(g.wings.length === 5, `5 wing entries after adding (got ${g.wings.length})`);
ok(g.wings.filter((w) => w.mirror && Math.abs(w.dihedral) < 55).length === 3, 'three of them are mirrored wing pairs');
const tel = await page.evaluate(() => window.drydock.telemetry);
ok(tel.parts.wingSurfaces === 8, `telemetry counts 8 wing surfaces (got ${tel.parts.wingSurfaces})`);
ok(tel.components === 1, 'still one connected body');
await drag('#sec-wings', 4, 0.9); await idle();          // sweep on the selected (duplicated fin)
ok(JSON.stringify((await G()).wings) !== JSON.stringify(g.wings), 'wing slider applies to the selected wing');

console.log('nacelles follow their wing');
await page.evaluate(() => { document.querySelector('#sec-wings select').value = '0'; document.querySelector('#sec-wings select').dispatchEvent(new Event('change')); });
await open('#sec-nacelles');
while ((await G()).nacelles.length) await click('#sec-nacelles', 'Remove');
await click('#sec-nacelles', '+ Wing pod');
g = await G();
ok(g.nacelles.length === 1 && g.nacelles[0].mount === 'wing' && g.nacelles[0].wing === 0, 'wing pod mounted on wing 1');
await click('#sec-wings', 'Remove');                     // removes wing 0
g = await G();
ok(g.nacelles[0].mount === 'hull', 'removing its wing re-homes the pod to the hull');

console.log('undo');
const before = JSON.stringify(await G());
await page.click('#btn-undo'); await idle();
ok(JSON.stringify(await G()) !== before && (await G()).wings.length === g.wings.length + 1, 'undo brings back the removed wing in one step');

console.log('export bar');
ok(await page.isVisible('#export-bar #btn-dl-stl'), 'STL button visible on desktop without scrolling');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const box = await page.locator('#export-bar').boundingBox();
ok(box && box.y < 844 + 200, `export bar sits right under the viewport on mobile (y=${box && Math.round(box.y)})`);
ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 390, 'no horizontal scroll on mobile');

console.log('version');
const { readFileSync } = await import('node:fs');
const want = JSON.parse(readFileSync(new URL('../version.json', import.meta.url), 'utf8')).version;
ok((await page.textContent('#version')) === `v${want}`, `footer shows v${want}`);
ok(await page.isHidden('#update-banner'), 'no update banner when up to date');
const p2 = await browser.newPage();
await p2.route('**/version.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: '99.0.0' }) }));
await p2.goto(`http://localhost:${port}/`);
await p2.waitForSelector('#update-banner:not([hidden])', { timeout: 30000 }).catch(() => {});
ok(await p2.isVisible('#update-banner'), 'update banner appears when the server has a newer version');
await p2.close();

ok(errors.length === 0, `no page errors ${errors.join('; ')}`);
await browser.close(); srv.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
