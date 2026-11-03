# Starship Drydock — Agent & Architect Specification (v2)

> v2 written by Claude, building on the v1 plan by Gemini (preserved in
> [`docs/AGENT_SPEC_v1_gemini.md`](docs/AGENT_SPEC_v1_gemini.md)). The section
> "What changed from v1" at the end explains each departure.

## 1. Core idea: beauty in the compiler, variety in the genome

A starship is a **genome** (a small JSON document of proportions and angles)
compiled by a **pure function** into a watertight `manifold-3d` solid.

- **The compiler owns aesthetics and plausibility.** Every part is built from
  primitives that are smooth and well-proportioned by construction: hulls are
  spline-lofted superellipse sections, wings are lofted NACA airfoils, nacelles
  are lofted radius profiles, canopies are teardrop lofts sitting on the
  *measured* hull. Parts are attached *relative to the hull*, so they can't float.
  Cockpits are human-scale whatever the ship's size.
- **The genome owns variety.** Genes are bounded proportions (fractions of ship
  length), angles and counts. *Any* genome inside the ranges compiles to a
  single connected, watertight ship. `npm test` checks this contract over
  random genomes and long mutation/crossover walks.
- **Selection supplies taste.** The nursery shows six offspring; a human (or an
  agent with screenshots) picks the best and breeds again: interactive
  evolution in the style of Dawkins' biomorphs. Beauty comes out of the grammar
  because the grammar can only speak in beautiful primitives, and a judge
  chooses among them.

**Dual audience.** Humans use sliders and the nursery. Agents read and write
genome JSON and read telemetry, through Node tools or `window.drydock` in a
browser. Telemetry is a *complement* to looking, not a substitute: numbers can
say "watertight, connected, the pilot can see", but not "this looks like a
starship". Agents should take snapshots (`tools/snapshot.mjs`) too.

## 2. Coordinates (unchanged from v1)

- `+Y` forward (bow), `-Y` aft (stern) · `+Z` dorsal, `-Z` ventral · `+X` starboard.
- Bilateral symmetry about `X = 0`: build starboard, `.mirror([1,0,0])`, union.
- Units are metres. Genes are fractions of `length` unless stated otherwise.

## 3. Compiler pipeline (`src/compiler.js`)

`compileStarship(wasm, genome, opts) → { genome, mesh, glass, decor, deck, telemetry }`

It's pure: no DOM, no Three.js, no retained WASM objects (except with
`opts.manifold`, which also returns the live `manifold`, `glassManifold` and
`canopyManifold` for the caller to own; that's how the ManifoldCAD export works).
`opts.printable` adds `printMesh`: hull and canopy skin welded into one solid. It runs identically in
Node and in the browser worker. `opts`: `{ quality: 'final'|'draft', cutaway, manifold, printable }`.
The compiler uses only `Manifold` and `Mesh` from the module it's given, so
the same source runs inside ManifoldCAD unchanged (`src/manifoldcad.js`
inlines it).

| Stage | What happens | Rule |
|---|---|---|
| 0. Normalise | `normalize(genome)` clamps every gene and repairs structure | The compiler never trusts input |
| 1. Parts | Hull: 72 rings sampled from **monotone cubic** splines through the stations, skinned by `loft()` → `Manifold.ofMesh` (validated). Wings: airfoil rings along the span with sweep, crescent, gull, dihedral and rounded tips. Nacelles: radius-profile lofts plus a pylon `hull()`. Main engines: bells on the stern | Monotone splines never overshoot, so widths can't go negative and hulls can't bulge past their stations |
| 2. Union + exterior details | `Manifold.union(parts)`, then subtract nozzles and intakes | Exterior details may be carved before the warp |
| 3. **Refine, then warp** | `refineToLength(edge)` → `warpBatch(W)` → `simplify(tol)` | **A warp only moves existing vertices.** Without refining first, ribs and terraces alias away: the v1 demo's rib warp was sampled at 6 points along the ship |
| 4. Bridge + cavity | Ray-cast the **warped** dorsal *and ventral* surfaces at every canopy station (ignoring hits on fins or wings above the hull); fit each canopy ring so its buried half stays above the belly and inside the side walls; keep the canopy between stern and bow tip. Build the glass shell, frames and room on that measured surface. The room's roof respects the section's curvature at its edges | Warp the exterior; carve Euclidean interiors. Decks are dead level. Never warp a cavity |
| 5. Clean + telemetry | `decompose()`; drop numerical debris (thin, near-zero-volume slivers); keep sealed voids; compute telemetry | Report components honestly: a real floating part is a `DISCONNECTED` warning |
| 6. Free | `Scope.free()` in a `finally` | See §6 |

All warps must be **injective** (they mustn't fold the surface through itself):
- `bend` and `droop` are shears;
- `terrace` is monotone in z for each vertical column;
- `ribs` are small radial displacements, confined to the hull's own radius so pods and wings stay clean.

### Why the warp maps are designed this way
`warp(A − B) ≠ warp(A) − B`: warping and boolean subtraction don't commute.
Stage 4 exploits that on purpose. The exterior is warped, and the interior
stays Euclidean. v1 tried to bridge the two with a fixed blister; v2 measures
the warped surface instead, because a rigid approximation of the warp is
wrong by tens of centimetres at the ends of a long canopy on a bent spine.
That's enough to break through a hull skin.

## 4. Ship Genome schema (`starship-genome/2`, `src/genome.js`)

```jsonc
{
  "schema": "starship-genome/2",
  "meta": { "name": "Katiya-Class Scout", "author": "claude", "lineage": [], "generation": 0 },
  "length": 64,                                  // metres, 30–140
  "hull": {
    "tumble": 0.18,                              // tumblehome: pinches the upper half
    "stations": [                                // 3–9, sorted by t; t=0 stern, t=1 bow tip
      { "t": 0, "w": 0.11, "top": 0.05, "bot": 0.04, "z": 0.01, "n": 2.2 }
      // w = full beam, top/bot = height above/below spine, z = spine height
      // (all /length); n = superellipse exponent: <2 chined/diamond, 2 elliptic, >2 slab
    ]
  },
  "style": { "bend": -0.018, "droop": 0.28, "ribAmp": 0.0016, "ribWave": 0.045, "terrace": 0, "terraceStep": 0.02 },
  "wings": [                                     // 0–8; dihedral ≈ 90 with mirror:false = dorsal fin
    { "t": 0.34, "z": -0.1, "span": 0.36, "chord": 0.36, "taper": 0.22, "sweep": 38,
      "dihedral": -4, "gull": 0.08, "crescent": 0.22, "thick": 0.11, "mirror": true }
  ],
  "nacelles": [                                  // 0–4 (each mirrored unless dorsal/ventral)
    { "mount": "wing", "wing": 0, "at": 0.62, "angle": 0, "offset": -0.012,
      "length": 0.3, "radius": 0.026, "intake": 0.75, "exhaust": 0.8 }
  ],
  "engines": { "count": 2, "radius": 0.55 },     // stern main engines; radius = fraction of the largest bell that fits (0.9 = max)
  "bridge": { "t": 0.72, "size": 1.0, "height": 1.0, "struts": 3 },
  "palette": { "primary": "#2b3f37", "secondary": "#16201c", "accent": "#7fe0c2", "glow": "#38ffd2" }
}
```

The ranges and mutation step sizes live in `GENES` in `src/genome.js`; that's
the single source of truth, also used to build the UI sliders.
Interior hull stations keep a minimum section; only the bow tip may be
needle-thin. Airfoil sections are at least 6 cm thick, and the post-warp
`simplify()` tolerance stays below that, so thin tips can't be pinched off.
A wing root can't run past the stern face, where the nozzles would cut it up. A wing-mounted nacelle on a missing or vertical wing is re-homed
to the hull.

### Evolution operators
- `mutate(g, { seed, rate, strength })`: Gaussian point mutations, plus rare
  structural ones (add or remove a station, wing or nacelle; shift the palette hue).
  Deterministic for a given seed.
- `crossover(a, b, { seed })`: uniform crossover by gene block. Hull stations
  are blended when the station counts match, which keeps silhouettes coherent.
- `randomGenome(seed)`: a cross of two presets, then heavily mutated. It starts sane.
- `encodeGenome` / `decodeGenome`: URL-safe base64 for share links (`#g=…`).

## 5. Telemetry (`starship-telemetry/2`)

| Field | Meaning |
|---|---|
| `status` | `MANIFOLD_OK` or the manifold error status |
| `dimensionsM`, `hullVolumeM3`, `surfaceAreaM2`, `triangles` | From the final solid |
| `genus` | Topological handles (canopy frames, through-holes) |
| `components` | Real bodies after debris removal. **Must be 1** |
| `debrisRemoved`, `sealedVoids` | Housekeeping counts (not design faults) |
| `proportions` | `beamToLength`, `heightToLength`, `planformFill` (top-view area ÷ bounding rectangle, via `project()`) |
| `bridge.forwardSightlineClearPct` | A 7×5 ray fan (`rayCast`) from the pilot's eye, cast against the ship *without* canopy frames: does the bow or spine block the horizon? |
| `bridge.deckHeadroomM`, `habitableVolumeM3`, `pilotEyeXYZ` | Interior checks |
| `bridge.canopyBreachRays` | Probe rays (from below and both sides) that hit canopy glass before hull. Must be 0 |
| `warnings[]` | `DISCONNECTED`, `CANOPY_BREACH`, `BOW_OCCLUSION` (< 75% clear), `BRIDGE_CRAMPED` (< 1.95 m) |
| `timingsMs` | Per-stage build cost |

## 6. WASM hygiene (critical)

`manifold-3d` objects live in WebAssembly memory that JS garbage collection
can't see. In the compiler, **every** Manifold/CrossSection goes through
`Scope.k()`, including intermediates of chained calls
(`k(k(m.translate(…)).rotate(…))`), and `S.free()` runs in `finally`. The
compiler returns only plain typed arrays.

`npm test` instruments the bindings and fails on any leaked handle. Two traps,
found the hard way:
- `wasm.Manifold` is a JS wrapper class. Instance methods live on the
  *embind* prototype of real instances, not on `wasm.Manifold.prototype`.
- `delete` lives on embind's shared `ClassHandle` prototype.

The test self-checks that it can see a deliberate leak before trusting a clean
result.

The viewer disposes Three.js geometries and materials when it replaces a ship.

## 7. Interfaces for agents

```bash
npm install                                   # only manifold-3d, for the Node tools
npm test                                      # contract + leak + robustness suite
node tools/ui-test.mjs                        # browser UI regression test (needs Playwright)
node tools/compile.mjs katiya                 # telemetry JSON for a preset or a genome file
node tools/compile.mjs ship.json --cutaway
node tools/snapshot.mjs katiya my.json        # PNGs in snapshots/ + telemetry (needs Playwright)
node tools/snapshot.mjs my.json --view below  # side|below|front|rear|top|cockpit
node tools/manifoldcad.mjs katiya --mm 200   # self-contained ManifoldCAD script (real compiler source + genome)
node tools/serve.mjs 8080                     # local server (modules need http://)
```

In the browser (`window.drydock`):
`load(genome)`, `mutate(opts)`, `crossover(other, opts)`, `random(seed)` each
return a promise of the telemetry. Also:
- `compile(genome)` evaluates a genome without displaying it;
- `snapshot()` returns a PNG data URL;
- `manifoldCadScript()` returns the ManifoldCAD script for the current ship;
- `view(name)` switches the camera: `orbit`, `cockpit`, or a fixed angle `side`, `below`, `front`, `rear`, `top` (also `tools/snapshot.mjs --view below`);
- `genome`, `telemetry`, `presets` and `GENES` are readable properties.

A sensible agent loop:
1. Read the telemetry and `GENES`.
2. Propose mutations.
3. Reject any with warnings.
4. Snapshot the survivors and judge by eye.
5. Keep the best and repeat.

Record intent in `meta.lineage`.

## 8. UI rule: sliders look up, never hold

Every slider gets a *getter* (`() => genome.wings[sel.wing]`), never an
object reference. `normalize()` returns a fresh copy, so a held reference
goes stale, and edits then silently land on a detached object. That was the
v2.0 bug where the second slider "did nothing". `tools/ui-test.mjs` guards it.
Genes that can't act in context (rib spacing with zero rib depth, and so on)
are shown disabled with the reason, rather than looking broken.

## 9. Extending the compiler: checklist

1. Add the genes, with `[min, max, sigma]`, to `GENES`, and defaults in `normalize`.
2. Build the part from lofts or revolves in its own coordinates, **attached
   relative to the hull or a wing**. Never use absolute coordinates.
3. Wrap every manifold handle in `k()`.
4. Exterior part → union before the warp. Interior space → carve after it, on
   measured surfaces.
5. Add a preset that uses it, run `npm test`, and look at it (`tools/snapshot.mjs`).

## 10. What changed from v1, and why

| v1 (Gemini plan) | v2 | Reason |
|---|---|---|
| Pairwise `hull()` of 5 station plates | Spline-sampled ring loft via validated `ofMesh` | Hulls are convex per segment and crease at every station; lofts are smooth and can be concave |
| Warp directly | Refine → warp → simplify | Undersampling: the warp had 96 vertices on 6 stations to act on |
| Theme switch (`biomechanical` / `brutalist` / `sleek`) | Continuous style genes; themes became presets | Evolvable: offspring can sit *between* themes |
| Cube blister and box cockpit | Teardrop canopy on the measured surface, separate glass, real frames | That was most of the boxiness |
| Volume-ratio sight cone | Ray fan with `rayCast` | Exact, cheap, and ignores deliberate struts |
| Hard-coded `MANIFOLD_WATERTIGHT` | `status()`, `decompose()`, warnings | Telemetry has to be able to say no |
| Manual `.delete()` list (it leaked) | `Scope` + instrumented leak test | The v1 demo leaked more than a dozen handles per rebuild |
| Main-thread compile, `esm.sh`, manifold 3.0.0 | Module worker, jsDelivr, manifold 3.5.4 | Responsive UI; `rayCast`, `warpBatch` |

The v1 demo is kept as `demo.html`.
