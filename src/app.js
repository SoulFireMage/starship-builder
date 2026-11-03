// app.js — UI wiring: genome state, sliders, history, nursery, export.
import { Viewport, ThumbRenderer } from './viewer.js';
import { PRESETS, GENES, LIMITS, normalize, mutate, crossover, randomGenome, encodeGenome, decodeGenome } from './genome.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ compile client
class Compiler {
  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.seq = 0; this.pending = new Map();
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id); this.pending.delete(e.data.id);
      if (!p) return;
      e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
    };
  }
  compile(genome, opts = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ id, genome, opts }); });
  }
}
const mainC = new Compiler();
const nurseryC = new Compiler();

// ------------------------------------------------------------ state
const view = new Viewport($('viewport'));
let genome = normalize(PRESETS.katiya);
let lastResult = null;
const past = [], future = [];
const sel = { station: 2, wing: 0, nacelle: 0 };
let cutaway = false;

// latest-wins scheduling: while one compile runs, keep only the newest request
let busy = false, queued = null;
function requestCompile(quality = 'final', reframe = false) {
  queued = { g: genome, quality, reframe };
  if (!busy) pump();
}
async function pump() {
  if (!queued) return;
  const job = queued; queued = null; busy = true;
  $('status').textContent = job.quality === 'draft' ? 'compiling (draft)…' : 'compiling…';
  try {
    const r = await mainC.compile(job.g, { quality: job.quality, cutaway });
    lastResult = r;
    view.show(r, { reframe: job.reframe });
    showTelemetry(r);
    $('status').textContent = `${r.telemetry.status} · ${r.telemetry.buildTimeMs} ms · ${r.telemetry.triangles.toLocaleString()} tris${job.quality === 'draft' ? ' (draft)' : ''}`;
    if (job.quality === 'final') syncUrl();
  } catch (err) {
    $('status').innerHTML = `<span style="color:var(--bad)">compile failed: ${err.message}</span>`;
  }
  busy = false;
  if (queued) pump();
}

function setGenome(g, { history = true, reframe = false, rebuildUI = true } = {}) {
  if (history) { past.push(genome); if (past.length > 60) past.shift(); future.length = 0; }
  genome = normalize(g);
  if (rebuildUI) buildUI();
  $('genome-json').value = JSON.stringify(genome, null, 2);
  $('hud-name').textContent = genome.meta.name;
  requestCompile('final', reframe);
}

// ------------------------------------------------------------ sliders
const nice = (v, r) => { const span = r[1] - r[0]; return span >= 20 ? v.toFixed(0) : span >= 2 ? v.toFixed(1) : span >= 0.2 ? v.toFixed(3) : v.toFixed(4); };
function slider(parent, label, obj, key, range, { integer = false, onChange } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'slider';
  const lbl = document.createElement('div'); lbl.className = 'lbl';
  const name = document.createElement('span'); name.textContent = label;
  const val = document.createElement('span');
  lbl.append(name, val);
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = range[0]; inp.max = range[1]; inp.step = integer ? 1 : (range[1] - range[0]) / 200;
  inp.value = obj[key]; inp.setAttribute('aria-label', label);
  const show = () => { val.textContent = integer ? String(obj[key]) : nice(+obj[key], range); };
  show();
  inp.addEventListener('input', () => {
    obj[key] = integer ? Math.round(+inp.value) : +inp.value;
    show(); onChange && onChange();
    $('genome-json').value = JSON.stringify(genome, null, 2);
    requestCompile('draft');
  });
  inp.addEventListener('pointerdown', () => { past.push(JSON.parse(JSON.stringify(genome))); future.length = 0; });
  inp.addEventListener('change', () => { genome = normalize(genome); requestCompile('final'); });
  wrap.append(lbl, inp);
  parent.append(wrap);
  return inp;
}

function picker(parent, items, current, labelFn, onPick, onAdd, onRemove) {
  const row = document.createElement('div'); row.className = 'row';
  const s = document.createElement('select');
  items.forEach((it, i) => { const o = document.createElement('option'); o.value = i; o.textContent = labelFn(it, i); s.append(o); });
  s.value = current; s.onchange = () => onPick(+s.value);
  row.append(s);
  if (onAdd) { const b = document.createElement('button'); b.className = 'small'; b.textContent = '+'; b.title = 'Add'; b.onclick = onAdd; row.append(b); }
  if (onRemove) { const b = document.createElement('button'); b.className = 'small'; b.textContent = '−'; b.title = 'Remove'; b.onclick = onRemove; row.append(b); }
  parent.append(row);
  return s;
}

const LABELS = {
  length: 'Length (m)', tumble: 'Tumblehome', bend: 'Spine bend', droop: 'Wing droop', ribAmp: 'Rib depth', ribWave: 'Rib spacing',
  terrace: 'Armour terracing', terraceStep: 'Terrace step', t: 'Position along hull', w: 'Beam', top: 'Dorsal height', bot: 'Ventral depth',
  z: 'Spine height', n: 'Section squareness', span: 'Span', chord: 'Root chord', taper: 'Taper', sweep: 'Sweep°', dihedral: 'Dihedral°',
  gull: 'Gull kink', crescent: 'Crescent', thick: 'Thickness', at: 'Mount position', angle: 'Angle around hull°', offset: 'Stand-off',
  radius: 'Radius', intake: 'Intake', exhaust: 'Exhaust', count: 'Main engines', size: 'Canopy size', height: 'Canopy height', struts: 'Canopy struts',
};
const lab = (k) => LABELS[k] || k;

function buildUI() {
  // style
  const s = $('sec-style'); s.innerHTML = '';
  slider(s, lab('length'), genome, 'length', GENES.length);
  slider(s, lab('tumble'), genome.hull, 'tumble', GENES.hull.tumble);
  for (const k of Object.keys(GENES.style)) slider(s, lab(k), genome.style, k, GENES.style[k]);

  // hull stations
  const h = $('sec-hull'); h.innerHTML = '';
  const sts = genome.hull.stations;
  sel.station = Math.min(sel.station, sts.length - 1);
  picker(h, sts, sel.station, (x, i) => `Station ${i + 1}  (t=${x.t.toFixed(2)})${i === 0 ? ' stern' : i === sts.length - 1 ? ' bow' : ''}`,
    (i) => { sel.station = i; buildUI(); },
    sts.length < LIMITS.stations[1] ? () => {
      const i = Math.max(1, sel.station + (sel.station === sts.length - 1 ? 0 : 1));
      const a = sts[i - 1], b = sts[i]; const m = {}; for (const k in a) m[k] = (a[k] + b[k]) / 2;
      const ng = JSON.parse(JSON.stringify(genome)); ng.hull.stations.splice(i, 0, m); sel.station = i; setGenome(ng);
    } : null,
    sts.length > LIMITS.stations[0] && sel.station > 0 && sel.station < sts.length - 1 ? () => {
      const ng = JSON.parse(JSON.stringify(genome)); ng.hull.stations.splice(sel.station, 1); setGenome(ng);
    } : null);
  const cur = sts[sel.station];
  for (const k of Object.keys(GENES.hull.station)) {
    if (k === 't' && (sel.station === 0 || sel.station === sts.length - 1)) continue;
    slider(h, lab(k), cur, k, GENES.hull.station[k]);
  }

  // wings
  const w = $('sec-wings'); w.innerHTML = '';
  const ws = genome.wings;
  sel.wing = Math.min(sel.wing, Math.max(0, ws.length - 1));
  picker(w, ws, sel.wing, (x, i) => `${Math.abs(x.dihedral) > 55 ? 'Fin' : 'Wing'} ${i + 1}${x.mirror ? ' (pair)' : ''}`,
    (i) => { sel.wing = i; buildUI(); },
    ws.length < LIMITS.wings[1] ? () => {
      const ng = JSON.parse(JSON.stringify(genome));
      ng.wings.push({ t: 0.25, z: 0.6, span: 0.1, chord: 0.15, taper: 0.4, sweep: 45, dihedral: 70, gull: 0, crescent: 0.1, thick: 0.08, mirror: true });
      sel.wing = ng.wings.length - 1; setGenome(ng);
    } : null,
    ws.length ? () => { const ng = JSON.parse(JSON.stringify(genome)); ng.wings.splice(sel.wing, 1); setGenome(ng); } : null);
  if (ws[sel.wing]) {
    const cw = ws[sel.wing];
    const lb = document.createElement('label'); lb.className = 'check';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = cw.mirror;
    cb.onchange = () => { const ng = JSON.parse(JSON.stringify(genome)); ng.wings[sel.wing].mirror = cb.checked; setGenome(ng); };
    lb.append(cb, document.createTextNode('Mirrored pair'));
    w.append(lb);
    for (const k of Object.keys(GENES.wing)) slider(w, lab(k), cw, k, GENES.wing[k]);
  }

  // nacelles
  const n = $('sec-nacelles'); n.innerHTML = '';
  const ns = genome.nacelles;
  sel.nacelle = Math.min(sel.nacelle, Math.max(0, ns.length - 1));
  picker(n, ns, sel.nacelle, (x, i) => `Nacelle ${i + 1} on ${x.mount === 'wing' ? 'wing ' + (x.wing + 1) : 'hull'}`,
    (i) => { sel.nacelle = i; buildUI(); },
    ns.length < LIMITS.nacelles[1] ? () => {
      const ng = JSON.parse(JSON.stringify(genome));
      ng.nacelles.push({ mount: 'hull', wing: 0, at: 0.2, angle: 0, offset: 0.01, length: 0.28, radius: 0.03, intake: 0.8, exhaust: 0.85 });
      sel.nacelle = ng.nacelles.length - 1; setGenome(ng);
    } : null,
    ns.length ? () => { const ng = JSON.parse(JSON.stringify(genome)); ng.nacelles.splice(sel.nacelle, 1); setGenome(ng); } : null);
  if (ns[sel.nacelle]) {
    const cn = ns[sel.nacelle];
    const ms = document.createElement('select');
    const opts = [['hull', 'Mounted on hull'], ...genome.wings.map((x, i) => [`wing:${i}`, `Mounted on wing ${i + 1}`])];
    for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; ms.append(o); }
    ms.value = cn.mount === 'wing' ? `wing:${cn.wing}` : 'hull';
    ms.onchange = () => {
      const ng = JSON.parse(JSON.stringify(genome)); const t = ng.nacelles[sel.nacelle];
      if (ms.value === 'hull') t.mount = 'hull'; else { t.mount = 'wing'; t.wing = +ms.value.split(':')[1]; }
      setGenome(ng);
    };
    n.append(ms);
    for (const k of Object.keys(GENES.nacelle)) {
      if (k === 'angle' && cn.mount === 'wing') continue;
      slider(n, lab(k), cn, k, GENES.nacelle[k]);
    }
  }

  // engines & bridge
  const b = $('sec-bridge'); b.innerHTML = '';
  slider(b, lab('count'), genome.engines, 'count', GENES.engines.count, { integer: true });
  slider(b, 'Engine size', genome.engines, 'radius', GENES.engines.radius);
  slider(b, 'Bridge position', genome.bridge, 't', GENES.bridge.t);
  slider(b, lab('size'), genome.bridge, 'size', GENES.bridge.size);
  slider(b, lab('height'), genome.bridge, 'height', GENES.bridge.height);
  slider(b, lab('struts'), genome.bridge, 'struts', GENES.bridge.struts, { integer: true });

  // palette
  const p = $('sec-palette'); p.innerHTML = '';
  for (const k of ['primary', 'secondary', 'accent', 'glow']) {
    const l = document.createElement('label'); l.textContent = k;
    const c = document.createElement('input'); c.type = 'color'; c.value = genome.palette[k];
    c.oninput = () => { genome.palette[k] = c.value; if (lastResult) { lastResult.genome.palette = { ...genome.palette }; view.show(lastResult); } };
    c.onchange = () => { $('genome-json').value = JSON.stringify(genome, null, 2); syncUrl(); };
    l.append(c); p.append(l);
  }
}

// ------------------------------------------------------------ telemetry panel
function showTelemetry(r) {
  const t = r.telemetry;
  const stat = (v, k) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  $('stats').innerHTML = [
    stat(`${t.dimensionsM.length} m`, 'length'), stat(`${t.dimensionsM.beam} m`, 'beam'),
    stat(`${Math.round(t.hullVolumeM3).toLocaleString()} m³`, 'volume'), stat(t.genus, 'genus (holes)'),
    stat(`${t.bridge.forwardSightlineClearPct}%`, 'pilot sightline'), stat(t.components, 'bodies'),
  ].join('');
  $('warnings').innerHTML = t.warnings.length ? t.warnings.map((w) => `<div>⚠ ${w}</div>`).join('') : '<div class="ok">✓ watertight, connected, clear sightline</div>';
  $('telemetry').textContent = JSON.stringify(t, null, 2);
  $('hud-meta').textContent = `${t.dimensionsM.length} m · ${t.parts.wingSurfaces} wing surfaces · ${t.parts.nacelles} nacelles · ${t.parts.mainEngines} main engines`;

  // deck plan
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, d = '';
  for (const ring of r.deck) {
    ring.forEach(([x, y], i) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${(-y).toFixed(2)} `; });
    d += 'Z ';
  }
  const eye = r.decor.pilotEye;
  if (!isFinite(minX)) { minX = -5; maxX = 5; minY = -5; maxY = 5; }
  const pad = 2, vw = maxX - minX + pad * 2, vh = maxY - minY + pad * 2;
  $('deck').innerHTML = `<svg viewBox="${minX - pad} ${-maxY - pad} ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">
    <path d="${d}" fill="rgba(94,234,212,.14)" stroke="#5eead4" stroke-width="${Math.max(vw, vh) / 300}" fill-rule="evenodd"/>
    <circle cx="${eye[0]}" cy="${-eye[1]}" r="${Math.max(vw, vh) / 90}" fill="#fbbf24"/></svg>`;
}

function syncUrl() {
  try { history.replaceState(null, '', '#g=' + encodeGenome(genome)); } catch (_) { /* file:// or sandboxed */ }
}

// ------------------------------------------------------------ nursery
const thumbs = new ThumbRenderer(320, 200);
let breedSeed = (Math.random() * 1e9) | 0;
async function breed() {
  $('nursery').classList.add('open');
  const kids = $('kids'); kids.innerHTML = '';
  const parent = genome, strength = +$('strength').value, gen = (parent.meta.generation || 0) + 1;
  const base = parent.meta.name.replace(/ · G\d+-[a-f]$/, '');
  const pkeys = Object.keys(PRESETS);
  const children = [];
  for (let i = 0; i < 6; i++) {
    const seed = breedSeed + i * 7919;
    let c = i < 5
      ? mutate(parent, { seed, strength: strength * (0.55 + 0.35 * i), rate: 0.35 + 0.08 * i })   // a = gentle … e = wild
      : mutate(crossover(parent, PRESETS[pkeys[(seed >>> 3) % pkeys.length]], { seed }), { seed: seed + 1, strength: strength * 0.5 });
    c.meta = { ...c.meta, name: `${base} · G${gen}-${'abcdef'[i]}`, generation: gen, author: 'drydock-nursery' };
    children.push(c);
    const card = document.createElement('div'); card.className = 'kid pending'; card.textContent = 'growing…';
    kids.append(card);
  }
  breedSeed += 104729;
  const token = breedSeed;
  for (let i = 0; i < children.length; i++) {
    let r;
    try { r = await nurseryC.compile(children[i], { quality: 'draft' }); } catch (err) { kids.children[i].textContent = 'stillborn'; continue; }
    if (token !== breedSeed) return; // a newer breed replaced this one
    const card = kids.children[i];
    card.className = 'kid'; card.innerHTML = '';
    const img = new Image(); img.src = thumbs.render(r); img.alt = children[i].meta.name;
    const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = children[i].meta.name.split(' · ').pop() + ['  gentle', '', '', '', '  wild', '  cross'][i];
    card.append(img, cap);
    if (r.telemetry.warnings.length) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = r.telemetry.warnings.length; b.title = r.telemetry.warnings.join('\n'); card.append(b); }
    card.onclick = () => { setGenome(children[i]); breed(); };
  }
}

// ------------------------------------------------------------ wiring
for (const [k, p] of Object.entries(PRESETS)) { const o = document.createElement('option'); o.value = k; o.textContent = p.meta.name; $('preset').append(o); }
$('preset').onchange = () => setGenome(PRESETS[$('preset').value], { reframe: true });
$('btn-mutate').onclick = () => setGenome(mutate(genome, { seed: (Math.random() * 1e9) | 0, strength: +$('strength').value }));
$('btn-random').onclick = () => setGenome(randomGenome((Math.random() * 1e9) | 0), { reframe: true });
$('btn-breed').onclick = breed;
$('btn-rebreed').onclick = breed;
$('btn-close').onclick = () => $('nursery').classList.remove('open');
$('btn-undo').onclick = () => { if (!past.length) return; future.push(genome); setGenome(past.pop(), { history: false }); };
$('btn-redo').onclick = () => { if (!future.length) return; past.push(genome); setGenome(future.pop(), { history: false }); };

const modeBtns = () => { $('btn-orbit').classList.toggle('on', view.mode === 'orbit'); $('btn-cockpit').classList.toggle('on', view.mode === 'cockpit'); };
$('btn-orbit').onclick = () => { view.orbit(); modeBtns(); };
$('btn-cockpit').onclick = () => { view.cockpit(); modeBtns(); };
$('btn-spin').onclick = () => { const on = !$('btn-spin').classList.contains('on'); $('btn-spin').classList.toggle('on', on); view.setAutoRotate(on); };
$('btn-cut').onclick = () => { cutaway = !cutaway; $('btn-cut').classList.toggle('on', cutaway); requestCompile('final'); };
const download = (name, blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const slug = () => genome.meta.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
$('btn-shot').onclick = () => { const a = document.createElement('a'); a.href = view.snapshot(); a.download = `${slug()}.png`; a.click(); };
$('btn-apply').onclick = () => {
  try { setGenome(JSON.parse($('genome-json').value), { reframe: true }); }
  catch (err) { $('status').innerHTML = `<span style="color:var(--bad)">bad JSON: ${err.message}</span>`; }
};
$('btn-link').onclick = async () => {
  syncUrl();
  try { await navigator.clipboard.writeText(location.href); $('status').textContent = 'link copied'; } catch (_) { $('status').textContent = 'copy the address bar to share'; }
};
$('btn-dl-json').onclick = () => download(`${slug()}.genome.json`, new Blob([JSON.stringify(genome, null, 2)], { type: 'application/json' }));
$('btn-dl-stl').onclick = () => { if (lastResult) download(`${slug()}.stl`, toSTL(lastResult.mesh)); };

function toSTL(m) {
  const nt = m.indices.length / 3, buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf);
  dv.setUint32(80, nt, true);
  let o = 84;
  const P = m.positions, I = m.indices;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    for (const v of [nx / l, ny / l, nz / l]) { dv.setFloat32(o, v, true); o += 4; }
    for (const i of [a, b, c]) for (let j = 0; j < 3; j++) { dv.setFloat32(o, P[i + j], true); o += 4; }
    o += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}

// ------------------------------------------------------------ agent API
// window.drydock lets a browser-driving agent operate the yard directly.
window.drydock = {
  get genome() { return JSON.parse(JSON.stringify(genome)); },
  get telemetry() { return lastResult ? lastResult.telemetry : null; },
  presets: PRESETS, GENES,
  load: (g) => { setGenome(g, { reframe: true }); return waitIdle(); },
  mutate: (opts) => { setGenome(mutate(genome, opts)); return waitIdle(); },
  crossover: (other, opts) => { setGenome(crossover(genome, other, opts)); return waitIdle(); },
  random: (seed) => { setGenome(randomGenome(seed), { reframe: true }); return waitIdle(); },
  compile: (g, opts) => mainC.compile(g, opts).then((r) => r.telemetry), // evaluate without displaying
  snapshot: () => view.snapshot(),
  view: (mode) => { mode === 'cockpit' ? view.cockpit() : view.orbit(); modeBtns(); },
  idle: () => waitIdle(),
};
function waitIdle() {
  return new Promise((res) => { const tick = () => (busy || queued ? setTimeout(tick, 50) : res(lastResult && lastResult.telemetry)); tick(); });
}

// ------------------------------------------------------------ boot
let start = PRESETS.katiya;
const m = location.hash.match(/g=([A-Za-z0-9_-]+)/);
if (m) { try { start = decodeGenome(m[1]); } catch (_) { /* ignore bad links */ } }
const pk = new URLSearchParams(location.search).get('preset');
if (pk && PRESETS[pk]) start = PRESETS[pk];
$('preset').value = Object.keys(PRESETS).find((k) => PRESETS[k].meta.name === start.meta?.name) || 'katiya';
setGenome(start, { history: false, reframe: true });
