// app.js — UI wiring: genome state, sliders, history, nursery, export.
import { Viewport, ThumbRenderer } from './viewer.js';
import { PRESETS, GENES, LIMITS, normalize, mutate, crossover, randomGenome, encodeGenome, decodeGenome } from './genome.js';
import { buildManifoldCadScript, SOURCE_FILES } from './manifoldcad.js';

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
// Sliders never hold on to genome objects: each one is given a *getter* that
// looks its target up in the current genome at event time. (Holding objects
// went stale as soon as normalize() replaced the genome, so later edits
// silently did nothing.)
const nice = (v, r) => { const span = r[1] - r[0]; return span >= 20 ? v.toFixed(0) : span >= 2 ? v.toFixed(1) : span >= 0.2 ? v.toFixed(3) : v.toFixed(4); };
const clone = (o) => JSON.parse(JSON.stringify(o));
function slider(parent, label, get, key, range, { integer = false, needs = null } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'slider';
  const lbl = document.createElement('div'); lbl.className = 'lbl';
  const name = document.createElement('span'); name.textContent = label;
  const val = document.createElement('span');
  lbl.append(name, val);
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = range[0]; inp.max = range[1]; inp.step = integer ? 1 : (range[1] - range[0]) / 200;
  inp.value = get()[key]; inp.setAttribute('aria-label', label);
  const show = () => { const v = get()[key]; val.textContent = integer ? String(Math.round(v)) : nice(+v, range); };
  show();
  if (needs) {            // a gene that can't act yet: grey it out and say why
    inp.disabled = true; wrap.classList.add('inert');
    const why = document.createElement('div'); why.className = 'why'; why.textContent = needs;
    wrap.append(lbl, inp, why); parent.append(wrap); return inp;
  }
  inp.addEventListener('pointerdown', () => { past.push(clone(genome)); if (past.length > 60) past.shift(); future.length = 0; });
  inp.addEventListener('keydown', () => { past.push(clone(genome)); if (past.length > 60) past.shift(); future.length = 0; }, { once: true });
  inp.addEventListener('input', () => {
    get()[key] = integer ? Math.round(+inp.value) : +inp.value;
    show();
    $('genome-json').value = JSON.stringify(genome, null, 2);
    requestCompile('draft');
  });
  inp.addEventListener('change', () => { genome = normalize(genome); buildUI(); requestCompile('final'); });
  wrap.append(lbl, inp);
  parent.append(wrap);
  return inp;
}

/** Part chooser: a select plus labelled action buttons ({label, title, run, disabled}). */
function picker(parent, items, current, labelFn, onPick, actions) {
  if (items.length) {
    const s = document.createElement('select');
    items.forEach((it, i) => { const o = document.createElement('option'); o.value = i; o.textContent = labelFn(it, i); s.append(o); });
    s.value = current; s.onchange = () => onPick(+s.value);
    parent.append(s);
  } else {
    const e = document.createElement('div'); e.className = 'why'; e.textContent = 'None yet. Add one below.'; parent.append(e);
  }
  const row = document.createElement('div'); row.className = 'actions';
  for (const a of actions) {
    const b = document.createElement('button'); b.className = 'small'; b.textContent = a.label;
    b.title = a.disabled || a.title || ''; b.disabled = !!a.disabled; b.onclick = a.run;
    row.append(b);
  }
  parent.append(row);
}

const LABELS = {
  length: 'Length (m)', tumble: 'Tumblehome', bend: 'Spine bend', droop: 'Wing droop', ribAmp: 'Rib depth', ribWave: 'Rib spacing',
  terrace: 'Armour terracing', terraceStep: 'Terrace step', t: 'Position along hull', w: 'Beam', top: 'Dorsal height', bot: 'Ventral depth',
  z: 'Root height on hull', n: 'Section squareness', span: 'Span', chord: 'Root chord', taper: 'Taper', sweep: 'Sweep°', dihedral: 'Dihedral° (90 = upright)',
  gull: 'Gull kink', crescent: 'Crescent', thick: 'Thickness', at: 'Mount position', angle: 'Angle around hull°', offset: 'Stand-off',
  radius: 'Radius', intake: 'Intake', exhaust: 'Exhaust', count: 'Main engines', size: 'Canopy size', height: 'Canopy height', struts: 'Canopy struts',
};
const lab = (k) => LABELS[k] || k;
const isFin = (w) => Math.abs(w.dihedral) > 55;
const podEligible = (w) => w && w.mirror && Math.abs(w.dihedral) <= 60;

const NEW_WING = () => ({ t: 0.4, z: 0, span: 0.26, chord: 0.26, taper: 0.35, sweep: 35, dihedral: 0, gull: 0, crescent: 0.1, thick: 0.09, mirror: true });
const NEW_FIN = () => ({ t: 0.15, z: 0.8, span: 0.1, chord: 0.16, taper: 0.4, sweep: 45, dihedral: 90, gull: 0, crescent: 0.1, thick: 0.08, mirror: false });

function edit(fn) { const ng = clone(genome); fn(ng); setGenome(ng); }

function buildUI() {
  // style
  const s = $('sec-style'); s.innerHTML = '';
  slider(s, lab('length'), () => genome, 'length', GENES.length);
  slider(s, lab('tumble'), () => genome.hull, 'tumble', GENES.hull.tumble);
  for (const k of Object.keys(GENES.style)) {
    const needs = k === 'ribWave' && genome.style.ribAmp === 0 ? 'Raise rib depth to use this'
      : k === 'terraceStep' && genome.style.terrace === 0 ? 'Raise armour terracing to use this' : null;
    slider(s, lab(k), () => genome.style, k, GENES.style[k], { needs });
  }

  // hull stations
  const h = $('sec-hull'); h.innerHTML = '';
  const sts = genome.hull.stations;
  sel.station = Math.min(sel.station, sts.length - 1);
  const end = sel.station === 0 || sel.station === sts.length - 1;
  picker(h, sts, sel.station, (x, i) => `Station ${i + 1} (t=${x.t.toFixed(2)})${i === 0 ? ' · stern' : i === sts.length - 1 ? ' · bow tip' : ''}`,
    (i) => { sel.station = i; buildUI(); }, [
      { label: '+ Station', title: 'Insert a station between this one and the next', disabled: sts.length >= LIMITS.stations[1] ? `At most ${LIMITS.stations[1]} stations` : null,
        run: () => edit((ng) => {
          const i = sel.station === sts.length - 1 ? sel.station : sel.station + 1;
          const a = ng.hull.stations[i - 1], b = ng.hull.stations[i]; const m = {}; for (const k in a) m[k] = (a[k] + b[k]) / 2;
          ng.hull.stations.splice(i, 0, m); sel.station = i;
        }) },
      { label: 'Remove', disabled: end ? 'Stern and bow stations are fixed' : sts.length <= LIMITS.stations[0] ? `At least ${LIMITS.stations[0]} stations` : null,
        run: () => edit((ng) => { ng.hull.stations.splice(sel.station, 1); }) },
    ]);
  for (const k of Object.keys(GENES.hull.station)) {
    if (k === 't' && end) continue;
    let range = GENES.hull.station[k];
    if (k === 't') range = [sts[sel.station - 1].t + 0.04, sts[sel.station + 1].t - 0.04]; // can't overtake neighbours
    slider(h, k === 'z' ? 'Spine height' : lab(k), () => genome.hull.stations[sel.station], k, range);
  }

  // wings & fins
  const w = $('sec-wings'); w.innerHTML = '';
  const ws = genome.wings;
  sel.wing = Math.min(sel.wing, Math.max(0, ws.length - 1));
  const full = ws.length >= LIMITS.wings[1] ? `At most ${LIMITS.wings[1]} wings and fins` : null;
  picker(w, ws, sel.wing, (x, i) => `${i + 1}. ${isFin(x) ? 'Fin' : 'Wing'}${x.mirror ? ' pair' : ' (single)'}`,
    (i) => { sel.wing = i; buildUI(); }, [
      { label: '+ Wing pair', disabled: full, run: () => edit((ng) => { ng.wings.push(NEW_WING()); sel.wing = ng.wings.length - 1; }) },
      { label: '+ Fin', title: 'A single upright fin on the centreline', disabled: full, run: () => edit((ng) => { ng.wings.push(NEW_FIN()); sel.wing = ng.wings.length - 1; }) },
      { label: 'Duplicate', title: 'Copy this one, shifted forward', disabled: full || (!ws.length && 'Nothing to copy'),
        run: () => edit((ng) => { const c = clone(ng.wings[sel.wing]); c.t = Math.min(0.9, c.t + 0.12); ng.wings.splice(sel.wing + 1, 0, c); sel.wing += 1; }) },
      { label: 'Remove', disabled: !ws.length && 'Nothing to remove',
        run: () => edit((ng) => {
          const i = sel.wing; ng.wings.splice(i, 1);
          for (const n of ng.nacelles) {           // keep pods attached to the right wing
            if (n.mount !== 'wing') continue;
            if (n.wing === i) { n.mount = 'hull'; n.at = 0.25; } else if (n.wing > i) n.wing -= 1;
          }
        }) },
    ]);
  if (ws[sel.wing]) {
    const lb = document.createElement('label'); lb.className = 'check';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = ws[sel.wing].mirror;
    cb.onchange = () => edit((ng) => { ng.wings[sel.wing].mirror = cb.checked; });
    lb.append(cb, document.createTextNode('Mirrored pair (untick for a single centreline fin)'));
    w.append(lb);
    for (const k of Object.keys(GENES.wing)) slider(w, lab(k), () => genome.wings[sel.wing], k, GENES.wing[k]);
  }

  // nacelles
  const n = $('sec-nacelles'); n.innerHTML = '';
  const ns = genome.nacelles;
  sel.nacelle = Math.min(sel.nacelle, Math.max(0, ns.length - 1));
  const nfull = ns.length >= LIMITS.nacelles[1] ? `At most ${LIMITS.nacelles[1]} nacelles` : null;
  const firstWing = genome.wings.findIndex(podEligible);
  picker(n, ns, sel.nacelle, (x, i) => `${i + 1}. Pod on ${x.mount === 'wing' ? 'wing ' + (x.wing + 1) : 'hull'}`,
    (i) => { sel.nacelle = i; buildUI(); }, [
      { label: '+ Hull pod', disabled: nfull, run: () => edit((ng) => { ng.nacelles.push({ mount: 'hull', wing: 0, at: 0.2, angle: 0, offset: 0.01, length: 0.28, radius: 0.03, intake: 0.8, exhaust: 0.85 }); sel.nacelle = ng.nacelles.length - 1; }) },
      { label: '+ Wing pod', disabled: nfull || (firstWing < 0 && 'Needs a mirrored, non-upright wing'),
        run: () => edit((ng) => { ng.nacelles.push({ mount: 'wing', wing: firstWing, at: 0.6, angle: 0, offset: -0.012, length: 0.28, radius: 0.026, intake: 0.8, exhaust: 0.85 }); sel.nacelle = ng.nacelles.length - 1; }) },
      { label: 'Duplicate', disabled: nfull || (!ns.length && 'Nothing to copy'),
        run: () => edit((ng) => { const c = clone(ng.nacelles[sel.nacelle]); c.at = Math.min(1, c.at + 0.15); ng.nacelles.splice(sel.nacelle + 1, 0, c); sel.nacelle += 1; }) },
      { label: 'Remove', disabled: !ns.length && 'Nothing to remove', run: () => edit((ng) => { ng.nacelles.splice(sel.nacelle, 1); }) },
    ]);
  if (ns[sel.nacelle]) {
    const cn = ns[sel.nacelle];
    const ms = document.createElement('select');
    const opts = [['hull', 'Mounted on hull'], ...genome.wings.map((x, i) => (podEligible(x) ? [`wing:${i}`, `Mounted on wing ${i + 1}`] : null)).filter(Boolean)];
    for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; ms.append(o); }
    ms.value = cn.mount === 'wing' ? `wing:${cn.wing}` : 'hull';
    ms.onchange = () => edit((ng) => {
      const t = ng.nacelles[sel.nacelle];
      if (ms.value === 'hull') t.mount = 'hull'; else { t.mount = 'wing'; t.wing = +ms.value.split(':')[1]; }
    });
    n.append(ms);
    for (const k of Object.keys(GENES.nacelle)) {
      if (k === 'angle' && cn.mount === 'wing') continue;
      const label = k === 'at' ? (cn.mount === 'wing' ? 'Position along span' : 'Position along hull') : lab(k);
      slider(n, label, () => genome.nacelles[sel.nacelle], k, GENES.nacelle[k]);
    }
  }

  // engines & bridge
  const b = $('sec-bridge'); b.innerHTML = '';
  slider(b, lab('count'), () => genome.engines, 'count', GENES.engines.count, { integer: true });
  slider(b, 'Engine size (of what fits the stern)', () => genome.engines, 'radius', GENES.engines.radius, { needs: genome.engines.count === 0 ? 'Add a main engine first' : null });
  slider(b, 'Bridge position', () => genome.bridge, 't', GENES.bridge.t);
  slider(b, lab('size'), () => genome.bridge, 'size', GENES.bridge.size);
  slider(b, lab('height'), () => genome.bridge, 'height', GENES.bridge.height);
  slider(b, lab('struts'), () => genome.bridge, 'struts', GENES.bridge.struts, { integer: true });

  // palette
  const p = $('sec-palette'); p.innerHTML = '';
  for (const k of ['primary', 'secondary', 'accent', 'glow']) {
    const l = document.createElement('label'); l.textContent = k;
    const c = document.createElement('input'); c.type = 'color'; c.value = genome.palette[k];
    c.addEventListener('pointerdown', () => { past.push(clone(genome)); future.length = 0; });
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
const printMm = () => Math.max(20, Math.min(2000, +$('print-mm').value || 150));
const note = (msg) => { $('status').textContent = msg; };
$('btn-dl-stl').onclick = async () => {
  note('building printable solid…');
  try {
    const r = await mainC.compile(genome, { quality: 'final', printable: true });
    download(`${slug()}-${printMm()}mm.stl`, toSTL(r.printMesh, printMm() / r.telemetry.dimensionsM.length));
    note(`STL saved: one watertight body, ${printMm()} mm long`);
  } catch (err) { note('STL export failed: ' + err.message); }
};
let srcCache = null;
async function manifoldCadScript() {
  if (!srcCache) {
    srcCache = {};
    for (const f of SOURCE_FILES) srcCache[f] = await (await fetch(new URL(`./${f}`, import.meta.url))).text();
  }
  return buildManifoldCadScript({ sources: srcCache, genome, printLengthMm: printMm() });
}
$('btn-dl-mcad').onclick = async () => download(`${slug()}.manifoldcad.mjs`, new Blob([await manifoldCadScript()], { type: 'text/javascript' }));
$('btn-copy-mcad').onclick = async () => {
  const text = await manifoldCadScript();
  try { await navigator.clipboard.writeText(text); note('script copied: paste it into manifoldcad.org'); }
  catch (_) { download(`${slug()}.manifoldcad.mjs`, new Blob([text], { type: 'text/javascript' })); note('clipboard blocked, so the script was downloaded instead'); }
};

function toSTL(m, scale = 1) {
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
    for (const i of [a, b, c]) for (let j = 0; j < 3; j++) { dv.setFloat32(o, P[i + j] * scale, true); o += 4; }
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
  manifoldCadScript: () => manifoldCadScript(),
  view: (mode) => {                          // 'orbit' | 'cockpit' | 'side' | 'below' | 'front' | 'rear' | 'top'
    if (mode === 'cockpit') view.cockpit(); else if (mode === 'orbit') { view.viewDir = null; view.orbit(); } else view.angle(mode);
    modeBtns();
    if (mode !== 'orbit' && mode !== 'cockpit') $('btn-spin').classList.remove('on');
  },
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
