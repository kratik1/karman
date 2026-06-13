import { createGL, makeQuad } from './gl.js';
import { LBM } from './lbm.js';
import { Renderer, MODES } from './render.js';
import { PRESETS, stampDisk, SOLID } from './presets.js';

const canvas = document.getElementById('view');
const gl = createGL(canvas);
const quad = makeQuad(gl);

const settings = {
  quality: 288,        // sim grid height in cells
  preset: 'cylinder',
  substeps: 10,
  tool: 'stir',        // stir | draw | erase
  paused: false,
};

let sim, renderer;

function buildSim() {
  const aspect = Math.max(1, Math.min(3, canvas.clientWidth / canvas.clientHeight));
  const h = settings.quality;
  const w = Math.round(h * aspect);
  const prevTau = sim?.tau, prevVel = sim?.inVel, prevMode = renderer?.mode;

  sim = new LBM(gl, quad, w, h);
  renderer = new Renderer(gl, quad, w, h);
  if (prevTau !== undefined) { sim.tau = prevTau; sim.inVel = prevVel; renderer.mode = prevMode; }

  sim.mask.set(PRESETS[settings.preset].build(w, h));
  sim.uploadMask();
  sim.reset();
  renderer.clearDye();
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}

// Wait until the canvas actually has layout (size 0 at module-eval time in
// some embedders) before sizing the grid off its aspect ratio.
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

let resizeTimer;
window.addEventListener('resize', () => {
  resizeCanvas();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildSim, 250);
});

// ---------- pointer input ----------

const pointer = { down: false, x: 0, y: 0, px: 0, py: 0, button: 0, shift: false };

function toCell(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * sim.w,
    y: (1 - (e.clientY - rect.top) / rect.height) * sim.h,
  };
}

function activeTool() {
  if (pointer.button === 2) return 'erase';
  if (pointer.shift) return 'draw';
  return settings.tool;
}

function paint(x, y, erase) {
  stampDisk(sim.mask, sim.w, sim.h, x, y, sim.h * 0.04, erase ? 0 : SOLID);
  // keep the channel walls intact
  for (let i = 0; i < sim.w; i++) { sim.mask[i] = SOLID; sim.mask[(sim.h - 1) * sim.w + i] = SOLID; }
  sim.uploadMask();
}

function dyeColor(t) {
  return [
    0.5 + 0.5 * Math.cos(t),
    0.5 + 0.5 * Math.cos(t + 2.094),
    0.5 + 0.5 * Math.cos(t + 4.188),
  ];
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const c = toCell(e);
  Object.assign(pointer, { down: true, x: c.x, y: c.y, px: c.x, py: c.y, button: e.button, shift: e.shiftKey });
  if (activeTool() !== 'stir') paint(c.x, c.y, activeTool() === 'erase');
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointer.down) return;
  const c = toCell(e);
  pointer.px = pointer.x; pointer.py = pointer.y;
  pointer.x = c.x; pointer.y = c.y;
  pointer.shift = e.shiftKey;

  const tool = activeTool();
  if (tool === 'stir') {
    const dx = pointer.x - pointer.px, dy = pointer.y - pointer.py;
    const k = 0.045;
    const clamp = (v) => Math.max(-0.2, Math.min(0.2, v));
    sim.splat = { x: pointer.x, y: pointer.y, vx: clamp(dx * k), vy: clamp(dy * k), radius: sim.h * 0.045 };
    renderer.dyeSplat = { x: pointer.x, y: pointer.y, color: dyeColor(performance.now() * 0.001), radius: sim.h * 0.035 };
  } else {
    paint(pointer.x, pointer.y, tool === 'erase');
  }
});
window.addEventListener('pointerup', () => { pointer.down = false; });

// ---------- UI ----------

const $ = (id) => document.getElementById(id);

let setMode, setTool;

function initUI() {
const presetSel = $('preset');
for (const [key, p] of Object.entries(PRESETS)) {
  presetSel.add(new Option(p.label, key));
}
presetSel.value = settings.preset;
presetSel.onchange = () => { settings.preset = presetSel.value; buildSim(); };

const modeButtons = [...document.querySelectorAll('[data-mode]')];
setMode = function (m) {
  renderer.mode = m;
  modeButtons.forEach((b) => b.classList.toggle('on', +b.dataset.mode === m));
};
modeButtons.forEach((b) => (b.onclick = () => setMode(+b.dataset.mode)));
setMode(MODES.DYE);

const toolButtons = [...document.querySelectorAll('[data-tool]')];
setTool = function (t) {
  settings.tool = t;
  toolButtons.forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
};
toolButtons.forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
setTool('stir');

function bindSlider(id, get, set, fmt) {
  const el = $(id), lab = $(id + 'Val');
  el.value = get();
  lab.textContent = fmt(get());
  el.oninput = () => { set(+el.value); lab.textContent = fmt(+el.value); };
}
bindSlider('flow', () => sim.inVel, (v) => { sim.inVel = v; }, (v) => v.toFixed(2));
bindSlider('visc', () => sim.tau, (v) => { sim.tau = v; }, (v) => `τ ${v.toFixed(3)}`);
bindSlider('speed', () => settings.substeps, (v) => { settings.substeps = v; }, (v) => `${v}×`);

const qualitySel = $('quality');
qualitySel.value = String(settings.quality);
qualitySel.onchange = () => { settings.quality = +qualitySel.value; buildSim(); };

$('pause').onclick = togglePause;
$('reset').onclick = () => { sim.reset(); renderer.clearDye(); };
$('clear').onclick = () => {
  sim.mask.set(PRESETS.sandbox.build(sim.w, sim.h));
  sim.uploadMask();
};
} // end initUI

function togglePause() {
  settings.paused = !settings.paused;
  $('pause').textContent = settings.paused ? 'Resume' : 'Pause';
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === '1') setMode(MODES.DYE);
  else if (e.key === '2') setMode(MODES.VORTICITY);
  else if (e.key === '3') setMode(MODES.SPEED);
  else if (e.key === 'r') { sim.reset(); renderer.clearDye(); }
  else if (e.key === 's') setTool('stir');
  else if (e.key === 'd') setTool('draw');
  else if (e.key === 'e') setTool('erase');
  else if (e.key === 'h') document.body.classList.toggle('hide-ui');
});

// ---------- main loop + HUD ----------

const hud = $('hud');
let frames = 0, lastHud = performance.now(), fps = 0;

function updateHud() {
  const D = sim.h * 0.22; // characteristic length ~ cylinder diameter
  const re = Math.round((sim.inVel * D) / sim.nu);
  const mlups = ((sim.w * sim.h * settings.substeps * fps) / 1e6).toFixed(0);
  hud.textContent =
    `${fps.toFixed(0)} fps · ${sim.w}×${sim.h} grid · ` +
    `${settings.substeps} steps/frame · ${mlups} MLUPS · Re ≈ ${re}`;
}

function frame() {
  if (!settings.paused) {
    sim.advance(settings.substeps);
    renderer.advect(sim, settings.substeps);
  }
  renderer.draw(sim, canvas.width, canvas.height);

  frames++;
  const now = performance.now();
  if (now - lastHud > 500) {
    fps = (frames * 1000) / (now - lastHud);
    frames = 0;
    lastHud = now;
    updateHud();
  }
  requestAnimationFrame(frame);
}

boot();
