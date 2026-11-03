// manifoldcad.js — turn a genome into a self-contained ManifoldCAD script.
//
// The script is the drydock's *actual* compiler source (geom.js, genome.js,
// compiler.js, with import/export lines stripped) plus the genome, ending in
// `export default <Manifold>`. Paste it into https://manifoldcad.org, or run
//   npx manifold-cad ship.mjs ship.3mf
// Nothing is paraphrased, so what you read is exactly what built the ship.

export const SOURCE_FILES = ['geom.js', 'genome.js', 'compiler.js'];

const strip = (src) => src
  .split('\n')
  .filter((line) => !/^import\s.*from\s+['"].*['"];?\s*$/.test(line))
  .join('\n')
  .replace(/^export\s+(?=(const|let|function|class|async)\b)/gm, '');

/**
 * @param {object} p
 * @param {Record<string,string>} p.sources  file name → source text (SOURCE_FILES)
 * @param {object} p.genome
 * @param {number} [p.printLengthMm]  bow-to-stern length of the exported model
 */
export function buildManifoldCadScript({ sources, genome, printLengthMm = 150 }) {
  const name = (genome.meta && genome.meta.name) || 'Starship';
  const genomeJson = JSON.stringify(genome, (k, v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v), 2);
  const body = SOURCE_FILES.map((f) => `// ${'='.repeat(70)}\n// src/${f}\n// ${'='.repeat(70)}\n${strip(sources[f])}`).join('\n\n');
  return `// ${name} — ManifoldCAD script exported from Starship Drydock
// https://github.com/SoulFireMage/starship-builder-
//
// Paste into https://manifoldcad.org, or run:  npx manifold-cad ship.mjs ship.3mf
//
// Everything below GENOME is the drydock's real compiler, inlined unchanged
// (written by Claude, from an initial plan by Gemini). How it uses Manifold:
//   • surfaces: rings of points (superellipse hull sections, NACA airfoil
//     wing sections, nacelle radius profiles) skinned into a triangle mesh by
//     loft() and handed to Manifold.ofMesh, which validates it as 2-manifold
//   • then ordinary CSG: union, subtract, intersect, hull (pylons),
//     trimByPlane (flat deck), cylinders/cubes (nozzles, canopy frames)
//   • style: refineToLength → warpBatch (bend, droop, ribs, terraces) → simplify
//   • rayCast to find the warped hull top so the canopy sits on it
// The Scope class frees WASM objects; harmless here alongside the editor's
// own garbage collection.

import { Manifold, Mesh, CrossSection } from 'manifold-3d/manifoldCAD';

const PRINT_LENGTH_MM = ${printLengthMm};   // bow-to-stern size of the exported model (editor units are mm)
const INCLUDE_CANOPY = true;     // fuse the canopy in as solid, for printing (false = open cockpit)

const GENOME = ${genomeJson};

${body}

// ${'='.repeat(70)}
// build
// ${'='.repeat(70)}
const built = compileStarship({ Manifold, Mesh, CrossSection }, GENOME, { manifold: true, quality: 'final' });
console.log(JSON.stringify(built.telemetry, null, 2));

let ship = built.manifold;
if (INCLUDE_CANOPY && built.canopyManifold) ship = ship.add(built.canopyManifold);

// Model units are metres; scale so the ship is PRINT_LENGTH_MM long.
export default ship.scale(PRINT_LENGTH_MM / built.telemetry.dimensionsM.length);
`;
}
