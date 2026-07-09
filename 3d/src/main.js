import { createGL, makeQuad } from '../../src/gl.js';
import { LBM3D } from './lbm3d.js';
import { Renderer3D, OrbitCamera } from './render3d.js';
import { PRESETS3D } from './presets3d.js';
import { THEMES, DEFAULT_THEME } from './themes.js';

const canvas = document.getElementById('view');
const gl = createGL(canvas);
const quad = makeQuad(gl);

let themeName = DEFAULT_THEME;
const accents = () => THEMES[themeName].accents;

function applyTheme(name) {
  if (!THEMES[name]) return;
  themeName = name;
  const t = THEMES[name];
  Object.assign(renderer.theme, t);
  sim.jetA = t.jetA;
  sim.jetB = t.jetB;
  document.documentElement.style.setProperty('--accent', t.accents[renderer.mode]);
}

const settings = {
  quality: 64,          // NY=NZ, NX=2×
  preset: 'sphere',
  substeps: 4,
  tool: 'orbit',        // orbit | stir
  text: 'K',
  paused: false,
};

let sim, renderer;
const camera = new OrbitCamera();

function buildSim() {
  const n = settings.quality;
  sim = new LBM3D(gl, quad, n * 2, n, n);
  renderer = new Renderer3D(gl, quad, sim);
  sim.mask.set(PRESETS3D[settings.preset].build(sim.nx, sim.ny, sim.nz, { text: settings.text }));
  sim.uploadMask();
  sim.reset();
  applyTheme(themeName);
  if (window.__mode !== undefined) setMode(window.__mode);
}

function restampMask() {
  sim.mask.set(PRESETS3D[settings.preset].build(sim.nx, sim.ny, sim.nz, { text: settings.text }));
  sim.uploadMask();
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}

window.addEventListener('resize', resizeCanvas);

// ---------- pointer input ----------

const pointer = { down: false, x: 0, y: 0, button: 0 };

// ray through the pixel, intersected with the plane through the camera
// target perpendicular to the view direction -> voxel coords
function mouseToVoxel(e) {
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = (1 - (e.clientY - rect.top) / rect.height) * 2 - 1;
  const { eye, fwd, right, up } = camera.basis();
  const tanF = Math.tan(camera.fov / 2);
  const aspect = rect.width / rect.height;
  const rd = [
    fwd[0] + ndcX * aspect * tanF * right[0] + ndcY * tanF * up[0],
    fwd[1] + ndcX * aspect * tanF * right[1] + ndcY * tanF * up[1],
    fwd[2] + ndcX * aspect * tanF * right[2] + ndcY * tanF * up[2],
  ];
  // plane: dot(p - target, fwd) = 0
  const num = fwd[0] * (camera.target[0] - eye[0]) + fwd[1] * (camera.target[1] - eye[1]) + fwd[2] * (camera.target[2] - eye[2]);
  const den = fwd[0] * rd[0] + fwd[1] * rd[1] + fwd[2] * rd[2];
  const t = num / den;
  const w = [eye[0] + rd[0] * t, eye[1] + rd[1] * t, eye[2] + rd[2] * t];
  return {
    x: (w[0] - renderer.origin[0]) / renderer.voxel,
    y: (w[1] - renderer.origin[1]) / renderer.voxel,
    z: (w[2] - renderer.origin[2]) / renderer.voxel,
  };
}

function dyeColor(t) {
  return [0.5 + 0.5 * Math.cos(t), 0.5 + 0.5 * Math.cos(t + 2.094), 0.5 + 0.5 * Math.cos(t + 4.188)];
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  document.getElementById('toast')?.classList.remove('show');
  canvas.setPointerCapture(e.pointerId);
  Object.assign(pointer, { down: true, x: e.clientX, y: e.clientY, button: e.button });
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointer.down) return;
  const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y;

  if (pointer.button === 2 || (pointer.button === 0 && e.shiftKey)) {
    camera.pan(dx, dy);
  } else if (settings.tool === 'stir' && pointer.button === 0) {
    const v = mouseToVoxel(e);
    if (v.x > 0 && v.x < sim.nx && v.y > 0 && v.y < sim.ny && v.z > 0 && v.z < sim.nz) {
      const { right, up } = camera.basis();
      const k = 0.0016 * sim.ny;
      const clamp = (val) => Math.max(-0.15, Math.min(0.15, val));
      sim.splat = {
        x: v.x, y: v.y, z: v.z,
        vx: clamp((dx * right[0] - dy * up[0]) * k * 0.01),
        vy: clamp((dx * right[1] - dy * up[1]) * k * 0.01),
        vz: clamp((dx * right[2] - dy * up[2]) * k * 0.01),
        radius: sim.ny * 0.10,
      };
      sim.dyeSplat = { x: v.x, y: v.y, z: v.z, color: dyeColor(performance.now() * 0.001), radius: sim.ny * 0.08 };
    }
  } else {
    camera.orbit(dx, dy);
  }
  pointer.x = e.clientX;
  pointer.y = e.clientY;
});
window.addEventListener('pointerup', () => { pointer.down = false; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); camera.zoom(e.deltaY); }, { passive: false });

// ---------- UI ----------

const $ = (id) => document.getElementById(id);
let setMode, setTool;

function initUI() {
  const presetSel = $('preset');
  for (const [key, p] of Object.entries(PRESETS3D)) presetSel.add(new Option(p.label, key));
  presetSel.value = settings.preset;
  presetSel.onchange = () => {
    settings.preset = presetSel.value;
    $('textRow').hidden = settings.preset !== 'text';
    buildSim();
  };

  const textInput = $('obsText');
  textInput.value = settings.text;
  textInput.addEventListener('input', () => {
    settings.text = textInput.value;
    if (settings.preset === 'text') restampMask();
  });

  const modeButtons = [...document.querySelectorAll('[data-mode]')];
  setMode = (m) => {
    window.__mode = m;
    renderer.mode = m;
    modeButtons.forEach((b) => b.classList.toggle('on', +b.dataset.mode === m));
    document.documentElement.style.setProperty('--accent', accents()[m]);
  };
  modeButtons.forEach((b) => (b.onclick = () => setMode(+b.dataset.mode)));
  setMode(0);

  const toolButtons = [...document.querySelectorAll('[data-tool]')];
  setTool = (t) => {
    settings.tool = t;
    toolButtons.forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  };
  toolButtons.forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  setTool('orbit');

  function bindSlider(id, get, set, fmt, min, max) {
    const el = $(id), lab = $(id + 'Val');
    const fill = (v) => el.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
    el.value = get(); lab.textContent = fmt(get()); fill(get());
    el.oninput = () => { set(+el.value); lab.textContent = fmt(+el.value); fill(+el.value); };
  }
  bindSlider('flow', () => sim.inVel, (v) => { sim.inVel = v; }, (v) => v.toFixed(2), 0, 0.12);
  bindSlider('visc', () => sim.tau, (v) => { sim.tau = v; }, (v) => `τ ${v.toFixed(4)}`, 0.5005, 0.56);
  bindSlider('speed', () => settings.substeps, (v) => { settings.substeps = v; }, (v) => `${v}×`, 1, 8);

  const qualitySel = $('quality');
  qualitySel.value = String(settings.quality);
  qualitySel.onchange = () => { settings.quality = +qualitySel.value; buildSim(); };

  $('pause').onclick = togglePause;
  $('reset').onclick = () => sim.reset();
  $('collapse').onclick = () => $('panel').classList.toggle('collapsed');
  setTimeout(() => $('toast')?.classList.remove('show'), 9000);
}

function togglePause() {
  settings.paused = !settings.paused;
  $('pause').textContent = settings.paused ? 'Resume' : 'Pause';
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === '1') setMode(0);
  else if (e.key === '2') setMode(1);
  else if (e.key === '3') setMode(2);
  else if (e.key === '4') setMode(3);
  else if (e.key === 'r') sim.reset();
  else if (e.key === 'o') setTool('orbit');
  else if (e.key === 's') setTool('stir');
  else if (e.key === 'h') document.body.classList.toggle('hide-ui');
});

// ---------- main loop ----------

const hud = $('hud');
let frames = 0, lastHud = performance.now(), fps = 0;

function updateHud() {
  const D = sim.ny * 0.34;
  const re = Math.round((sim.inVel * D) / sim.nu);
  const mlups = ((sim.cells() * settings.substeps * fps) / 1e6).toFixed(0);
  hud.innerHTML =
    `<b>${fps.toFixed(0)}</b> fps<i>·</i>${sim.nx}×${sim.ny}×${sim.nz}<i>·</i>` +
    `<b>${mlups}</b> MLUPS<i>·</i>Re ≈ <b>${re}</b>`;
}

function stepSim(t) {
  sim.advance(settings.substeps);
  sim.advectDye(settings.substeps);
  sim.computeFields();
  renderer.updateParticles(settings.substeps, t);
}

function frame(t) {
  if (!settings.paused) stepSim(t * 0.001);
  renderer.draw(camera, canvas.width, canvas.height);

  frames++;
  const now = performance.now();
  if (now - lastHud > 500) {
    fps = (frames * 1000) / (now - lastHud);
    frames = 0; lastHud = now;
    updateHud();
  }
  requestAnimationFrame(frame);
}

// console API, same spirit as the 2D page
window.karman = {
  warp(framesN = 400) {
    const t0 = performance.now();
    for (let i = 0; i < framesN; i++) stepSim(i * 0.016);
    renderer.draw(camera, canvas.width, canvas.height);
    return `${framesN} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  },
  cam: camera,
  mode: (m) => setMode(m),
  theme: (name) => applyTheme(name),
  get sim() { return sim; },
  get renderer() { return renderer; },
};

function boot() {
  if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
    requestAnimationFrame(boot);
    return;
  }
  resizeCanvas();
  buildSim();
  initUI();
  requestAnimationFrame(frame);
}

boot();
