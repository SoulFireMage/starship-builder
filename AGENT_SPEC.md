# Starship Builder (`starship-builder-`) — Agent & Architect Specification

## 1. Project Overview & Core Philosophy
This repository hosts a browser-native, zero-build procedural 3D starship drydock powered by **`manifold-3d` (WebAssembly CSG kernel)** and **Three.js**.
- **Dual-Audience Design:** The system is designed to be operated equally by **humans** (via high-density UI controls) and **autonomous AI agents / starship personas** (via declarative JSON Ship Genomes and deterministic spatial telemetry).
- **Zero Fragile Meshes:** Never generate raw triangle soup or unverified Three.js `BufferGeometry` for ship hulls. All structural geometry MUST be constructed through `manifold-3d` boolean, hull, extrusion, and warp primitives so that every vessel is guaranteed **watertight, 2-manifold, and sliceable**.
- **Zero-Build Static Architecture:** Keep the application runnable directly on GitHub Pages (`index.html` + ES Module imports via `esm.sh` or local static JS modules) without requiring Node.js bundlers unless explicitly requested.

---

## 2. Naval Coordinate & Symmetry Conventions
All ship genomes, station plates, and camera anchors strictly obey naval/aerospace Z-Up coordinates:
- **`+Y` = Forward (Bow)** / **`-Y` = Aft (Stern)** along the primary vessel spine.
- **`+Z` = Dorsal (Up)** / **`-Z` = Ventral (Down)**.
- **`+X` = Starboard (Right)** / **`-X` = Port (Left)**.
- **Bilateral Symmetry (`X = 0`):** Construct starboard (`+X`) assemblies first, then mirror across the YZ plane using `.mirror([1, 0, 0])` and union into the central hull.

---

## 3. The Golden Order of Operations (Compiler Pipeline)
When modifying or extending the geometry compiler (`compileStarship()`), agents MUST preserve this exact five-stage order of operations. **Violating Stage 2 vs. Stage 3 will warp the pilot's floor and break interior ergonomics.**

### Stage 1: Piecewise Spine Lofting (`Manifold.hull`)
- **Rule:** Never pass all spine stations into a single `Manifold.hull([...])` call—doing so wraps the entire ship in a single convex envelope and destroys concave waists, intakes, and neck tapers.
- **Pattern:** Iterate pairwise over adjacent spine stations `(S[i], S[i+1])`, call `Manifold.hull([S[i], S[i+1]])` on each adjacent pair, and boolean-union (`.add()`) the segments into `outerHull`.

### Stage 2: Continuous Exterior Space-Warping (`outerHull.warp`)
- Apply theme-specific coordinate displacement closures `(vert: Vec3) => void` to `outerHull` **before** carving interior rooms or hardpoints:
  - `biomechanical`: Trigonometric rib fluting (`sin(y * freq) * cos(x * freq)`), organic spline sweep, and anhedral tendril droop.
  - `brutalist`: Stepped terrace quantization (`Math.round(v / step) * step`) and subtracted rectangular armor trenches.
  - `sleek`: High-aspect chine flaring, flattened ventral planing hulls, and swept leading edges.

### Stage 3: Euclidean Negative-Space Cavity Carving (`subtract`)
Interior habitable spaces (cockpits, bridges, corridors, engineering bays) are carved **after** the exterior warp so decks remain flat and level:
1. **Blister Reinforcement:** For any cavity near the hull surface (like a dorsal bridge), union a slightly larger outer shell (`cavity + 2 * wallThickness`) onto `outerHull` first so the room never punches into thin air.
2. **Cavity Subtraction:** Subtract the interior room solid (`innerCavity`) from `outerHull`.
3. **Aperture / Canopy Punching:** Construct a forward frustum or window cutout block, subtract structural window struts (`strutBar`) from that cutout block, and subtract the resulting punch from the hull. This leaves real 3D physical window struts visible from inside the cockpit.
4. **Corridor Graphing:** Connect multiple internal cavities (`bridge -> spine_corridor -> engine_room`) by unioning their interior solids together into a single `habitableInterior` manifold before subtracting from `outerHull`.

### Stage 4: Automated Spatial Telemetry & Sightline Verification
Every compilation cycle must populate the `telemetry` JSON object so an agent can self-verify its design without needing visual screenshots:
- **`hullVolumeM3` & `surfaceAreaM2`:** Via `finalShip.volume()` and `finalShip.surfaceArea()`.
- **`genusHoles`:** Via `finalShip.genus()` (verifies that window cutouts and thruster tunnels actually pierced the hull wall).
- **`forwardLineOfSightClearPct`:** Project a test sight-cone (`Manifold.cylinder`) from `pilotEyeXYZ` along `+Y`, intersect it with `outerHull` (excluding the canopy blister), and compute `1.0 - (occlusion.volume() / sightBeam.volume())`. If `< 75%`, the bow or dorsal spine is blocking the pilot's forward horizon.
- **`CrossSection` Deck Plans:** Call `finalShip.slice(zHeight)` and serialize `.toPolygons()` into the 2D SVG blueprint view.

### Stage 5: Explicit WASM Heap Cleanup (CRITICAL)
`manifold-3d` compiles C++ objects into linear WebAssembly memory that **JavaScript Garbage Collection cannot see**.
- Every intermediate `Manifold` and `CrossSection` instance created during `compileStarship()` **MUST** be explicitly freed via `.delete()` before the function returns.
- Failure to call `.delete()` on intermediate primitives during interactive slider dragging will leak WASM memory and crash the browser tab within ~200 rebuilds.

---

## 4. Semantic Ship Genome Schema (`v1.1`)
Agents mutating a vessel should read and emit state conforming to this JSON structure:

```json
{
  "meta": {
    "id": "aktarian-scout-01",
    "name": "Katiya-Class",
    "author": "human_or_agent_id"
  },
  "theme": {
    "archetype": "biomechanical | brutalist | sleek",
    "warpIntensity": 0.65,
    "palette": {
      "hullPrimary": "#1d2d27",
      "trimWire": "#00ffcc",
      "interiorBulkhead": "#0f172a"
    }
  },
  "parametric": {
    "length": 64.0,
    "wingSpan": 36.0,
    "bridgeElevationZ": 2.2,
    "noseDroopZ": -1.8,
    "canopyStruts": 3
  },
  "cavities": [
    {
      "id": "bridge",
      "type": "cockpit",
      "pos": [0.0, 12.1, 2.2],
      "size": [4.2, 6.8, 2.6],
      "wallThickness": 0.45,
      "pilotEyeOffset": [0.0, -1.2, 0.35]
    }
  ]
}
