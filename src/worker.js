// worker.js — runs the compiler off the main thread so sliders and the
// orbit camera never stall while manifold-3d is doing booleans.
import Module from 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/manifold.js';
import { compileStarship } from './compiler.js?v=2.4.0';

const ready = Module().then((w) => { w.setup(); return w; });

self.onmessage = async (e) => {
  const { id, genome, opts } = e.data;
  const wasm = await ready;
  try {
    const r = compileStarship(wasm, genome, opts || {});
    const transfer = [r.mesh.positions.buffer, r.mesh.normals.buffer, r.mesh.indices.buffer];
    if (r.glass) transfer.push(r.glass.positions.buffer, r.glass.normals.buffer, r.glass.indices.buffer);
    if (r.printMesh) transfer.push(r.printMesh.positions.buffer, r.printMesh.normals.buffer, r.printMesh.indices.buffer);
    self.postMessage({ id, ok: true, result: r }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
