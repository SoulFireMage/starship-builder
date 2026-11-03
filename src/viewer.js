// viewer.js — Three.js presentation layer. Takes the plain mesh data the
// compiler returns; never touches manifold-3d. Everything here is cosmetic
// (materials, panel-line shader, engine glow, stars), so it can be
// changed freely without affecting the geometry contract.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // Z-up naval convention

function geometryFrom(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  const hasN = m.normals.some((v) => v !== 0);
  if (hasN) g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  if (!hasN) g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Hull material: physically based paint + procedural plating in object space. */
export function makeHullMaterial(palette, length) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0.55, roughness: 0.42, clearcoat: 0.45, clearcoatRoughness: 0.35,
  });
  const u = {
    uPrimary: { value: new THREE.Color(palette.primary) },
    uSecondary: { value: new THREE.Color(palette.secondary) },
    uAccent: { value: new THREE.Color(palette.accent) },
    uLen: { value: length },
    uPanel: { value: Math.max(1.4, length / 16) },
  };
  mat.userData.uniforms = u;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;\nvObjN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vObjPos; varying vec3 vObjN;
        uniform vec3 uPrimary, uSecondary, uAccent; uniform float uLen, uPanel;
        float hash3(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
        float gridLine(float v){ float d = min(fract(v), 1.0 - fract(v)); return 1.0 - smoothstep(0.0, fwidth(v) * 0.9, d); }
        float panelHash;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 nO = normalize(vObjN);
        float belly = smoothstep(0.1, -0.6, nO.z);
        vec3 col = mix(uPrimary, uSecondary, belly);
        float sx = abs(vObjPos.x);
        float stripe = (1.0 - smoothstep(uLen*0.0035, uLen*0.005, abs(sx - uLen*0.014))) * smoothstep(0.5, 0.85, nO.z);
        col = mix(col, uAccent, stripe * 0.85);
        vec3 pp = vObjPos / uPanel;
        float across = abs(nO.z) > abs(nO.x) ? gridLine(pp.x * 1.6) : gridLine(pp.z * 1.6);
        float lines = max(gridLine(pp.y), across);
        panelHash = hash3(floor(vec3(pp.x * 1.6, pp.y, pp.z * 1.6)));
        col *= (0.94 + 0.09 * panelHash) * (1.0 - 0.24 * lines);
        diffuseColor.rgb = col;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor * (0.8 + 0.4 * panelHash), 0.05, 1.0);`);
  };
  return mat;
}

function makeGlassMaterial(palette) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(palette.glow).multiplyScalar(0.35), metalness: 0.2, roughness: 0.04,
    transparent: true, opacity: 0.3, clearcoat: 1, envMapIntensity: 2.2, side: THREE.DoubleSide, depthWrite: false,
  });
}

let haloTex = null;
function halo() {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  haloTex = new THREE.CanvasTexture(c);
  return haloTex;
}

/** Builds a THREE.Group for a compiled ship (hull + glass + engine glow). */
export function buildShipGroup(result) {
  const { genome, mesh, glass, decor } = result;
  const group = new THREE.Group();
  const hull = new THREE.Mesh(geometryFrom(mesh), makeHullMaterial(genome.palette, genome.length));
  group.add(hull);
  if (glass) group.add(new THREE.Mesh(geometryFrom(glass), makeGlassMaterial(genome.palette)));
  const glowCol = new THREE.Color(genome.palette.glow);
  for (const e of decor.engines) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(e.r, 32),
      new THREE.MeshBasicMaterial({ color: glowCol.clone().multiplyScalar(6), toneMapped: false }));
    disc.rotation.x = Math.PI / 2;
    disc.position.set(...e.pos);
    group.add(disc);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo(), color: glowCol, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85, toneMapped: false }));
    sp.scale.setScalar(e.r * 5);
    sp.position.set(e.pos[0], e.pos[1] - e.r * 0.9, e.pos[2]);
    group.add(sp);
  }
  return group;
}

export function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}

function starfield() {
  const n = 2600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = 900;
    const s = Math.sqrt(1 - u * u);
    pos.set([r * s * Math.cos(th), r * s * Math.sin(th), r * u], i * 3);
    const b = 0.4 + Math.random() * 0.6, warm = Math.random();
    col.set([b, b * (0.9 + 0.1 * warm), b * (0.8 + 0.25 * (1 - warm))], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
}

/** Main interactive viewport. */
export class Viewport {
  constructor(container) {
    this.container = container;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05070c);
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(starfield());

    const sun = new THREE.DirectionalLight(0xfff1dd, 2.4); sun.position.set(60, 40, 90); this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x6fb6ff, 1.1); rim.position.set(-70, -60, -20); this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0x8090b0, 0x101018, 0.35));

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 4000);
    this.camera.position.set(60, 50, 30);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;


    this.group = null;
    this.mode = 'orbit';
    this.framedFor = null;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => { requestAnimationFrame(loop); this.controls.update(); this.renderer.render(this.scene, this.camera); };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  show(result, { reframe = false } = {}) {
    if (this.group) { this.scene.remove(this.group); disposeGroup(this.group); }
    this.group = buildShipGroup(result);
    this.scene.add(this.group);
    this.last = result;
    const L = result.genome.length;
    if (reframe || this.framedFor === null || Math.abs(this.framedFor - L) / L > 0.25) { this.frame(); this.framedFor = L; }
    if (this.mode === 'cockpit') this.cockpit();
  }

  frame(dir = this.viewDir || [0.72, 0.52, 0.42]) {
    if (!this.group) return;
    const box = new THREE.Box3().setFromObject(this.group.children[0]);
    const c = box.getCenter(new THREE.Vector3()), R = box.getSize(new THREE.Vector3()).length() / 2;
    this.controls.target.copy(c);
    // fit whichever field of view is narrower (portrait phones are width-limited)
    const vf = (this.camera.fov * Math.PI) / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
    const d = R / Math.sin(Math.min(vf, hf) / 2) * 0.95;
    this.camera.position.copy(c).add(new THREE.Vector3(...dir).normalize().multiplyScalar(d));
    this.camera.near = Math.max(0.05, R / 500);
    this.camera.updateProjectionMatrix();
  }

  orbit() {
    this.mode = 'orbit';
    Object.assign(this.controls, { enableZoom: true, enablePan: true });
    this.controls.autoRotate = this.autoRotate !== false;
    this.camera.fov = 42; this.frame();
  }

  cockpit() {
    if (!this.last) return;
    this.mode = 'cockpit';
    const { pilotEye, lookDir } = this.last.decor;
    const eye = new THREE.Vector3(...pilotEye), dir = new THREE.Vector3(...lookDir);
    this.controls.autoRotate = false;
    Object.assign(this.controls, { enableZoom: false, enablePan: false });
    this.controls.target.copy(eye).addScaledVector(dir, 0.35);
    this.camera.position.copy(eye);
    this.camera.near = 0.03; this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
  }

  /** Named camera angles for inspecting a ship (also used by agents). */
  angle(name) {
    const dirs = {
      default: [0.72, 0.52, 0.42], side: [1, 0.0001, 0.05], below: [0.55, 0.35, -0.75],
      front: [0.15, 1, 0.2], rear: [0.25, -1, 0.3], top: [0.0001, 0.0001, 1],
    };
    this.viewDir = dirs[name] || dirs.default;
    if (this.mode !== 'orbit') this.orbit(); else this.frame();
    this.setAutoRotate(false);
  }

  setAutoRotate(on) { this.autoRotate = on; if (this.mode === 'orbit') this.controls.autoRotate = on; }

  snapshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
}

/** Small offscreen renderer for nursery thumbnails. */
export class ThumbRenderer {
  constructor(w = 320, h = 200) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    this.renderer.setSize(w, h, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0e16);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.4); sun.position.set(60, 40, 90); this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 4000);
  }
  render(result) {
    const g = buildShipGroup(result);
    this.scene.add(g);
    const box = new THREE.Box3().setFromObject(g.children[0]);
    const c = box.getCenter(new THREE.Vector3()), R = box.getSize(new THREE.Vector3()).length() / 2;
    const d = R / Math.sin((this.camera.fov * Math.PI) / 360) * 0.6;
    this.camera.position.copy(c).add(new THREE.Vector3(0.75, 0.55, 0.45).normalize().multiplyScalar(d));
    this.camera.lookAt(c);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.scene.remove(g); disposeGroup(g);
    return url;
  }
}
