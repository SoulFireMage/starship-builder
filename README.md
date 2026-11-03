# Starship Drydock

A browser-native procedural starship designer. Ships are **genomes**, small
JSON documents of proportions and angles, compiled by
[manifold-3d](https://github.com/elalish/manifold) into guaranteed-watertight
solids. You can tune them with sliders, or **breed** them: the nursery shows
six offspring, you adopt the one you like, and breed again.

> **An AI project.** Built by **Claude** (Anthropic), from an initial plan and
> v1 demo by **Gemini**. Commissioned and steered by the repo owner. The
> original plan is preserved in [`docs/AGENT_SPEC_v1_gemini.md`](docs/AGENT_SPEC_v1_gemini.md);
> the v1 demo is still at [`demo.html`](demo.html).

None of it is meant to be physically realistic. It's a way to grow interesting
starship models that humans and agents can both play with.

## What's in it

- **Smooth by construction:**
  - spline-lofted superellipse hulls (from chined to slab-sided);
  - NACA-airfoil wings with sweep, crescent, gull and rounded tips;
  - lofted nacelles on pylons;
  - a teardrop canopy with real boolean-cut frames, sitting over a level deck you can stand on (try **Cockpit**).
- **Style genes:** spine bend, wing droop, rib fluting and armour terracing, all applied as warps after refinement, so they actually show.
- **Evolution:** mutate, crossover, random, undo/redo, and a six-child nursery with a variation slider.
- **Parts:** up to 8 wings and fins (add a wing pair, add a fin, duplicate, remove), 4 engine pods on the hull or wings, and 3–9 hull stations.
- **Telemetry for agents:**
  - watertight status, genus and body count;
  - a ray-cast pilot sightline and deck headroom;
  - proportions;
  - a live `Manifold.slice()` deck plan.
- **Export & 3D print** (its own bar: along the bottom on desktop, right under the 3D view on phones):
  - **STL for printing:** one welded, watertight body with the canopy fused in, scaled to your chosen print length in mm.
  - **ManifoldCAD script:** a self-contained `.mjs` to paste into [manifoldcad.org](https://manifoldcad.org) (or run with `npx manifold-cad ship.mjs ship.3mf`). It is the drydock's *actual* compiler source plus your genome, so you can read exactly how the ship is built and export 3MF/GLB from there.
  - Genome JSON, share links (`#g=…`) and PNG screenshots.

## Run it

It's a zero-build static site. Locally, ES modules and workers need `http://`:

```bash
node tools/serve.mjs 8080     # → http://localhost:8080/
```

## Agent / developer tools

```bash
npm install                   # installs manifold-3d for the Node tools only
npm test                      # validity contract, WASM leak check, robustness over evolved genomes
node tools/ui-test.mjs        # browser UI regression test (needs Playwright + Chromium)
node tools/compile.mjs heron  # telemetry for a preset or a genome .json
node tools/snapshot.mjs       # PNG renders in snapshots/ (needs Playwright + Chromium)
node tools/manifoldcad.mjs katiya --mm 200 > katiya.mjs   # ManifoldCAD script for a preset/genome
```

See [`AGENT_SPEC.md`](AGENT_SPEC.md) for the pipeline, the genome schema, the
telemetry, the `window.drydock` browser API, and the rules for extending it.

## Deploying on GitHub Pages

Settings → Pages → **Build and deployment: Deploy from a branch** → `main` /
`(root)`. No build step or Actions workflow is needed. `.nojekyll` stops Jekyll
from touching the files. The site will be at
`https://<user>.github.io/starship-builder/`, ready to link or iframe from a
blog. three.js and manifold-3d load from jsDelivr at pinned versions.

## Layout

| Path | Role |
|---|---|
| `index.html` | The drydock UI |
| `src/genome.js` | Gene ranges, presets, normalise / mutate / crossover / random / encode |
| `src/geom.js` | Monotone splines, superellipse and airfoil rings, validated loft, WASM `Scope`, seeded RNG |
| `src/compiler.js` | Genome → manifold → mesh + telemetry (pure; Node or browser) |
| `src/worker.js` | Runs the compiler off the main thread |
| `src/viewer.js` | Three.js: plating shader, glass, engine glow, starfield, thumbnails |
| `src/manifoldcad.js` | Builds the self-contained ManifoldCAD script from the real sources |
| `src/app.js` | UI wiring, nursery, history, export, `window.drydock` |
| `tools/` | `test`, `ui-test`, `compile`, `snapshot`, `manifoldcad`, `serve` |
| `demo.html`, `docs/AGENT_SPEC_v1_gemini.md` | The original v1 (Gemini) demo and plan |
