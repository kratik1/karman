import { createGL, makeQuad } from './gl.js';
import { LBM } from './lbm.js';
import { Renderer, MODES } from './render.js';
import { Particles } from './particles.js';
import { PRESETS, stampDisk, SOLID } from './presets.js';
import { Aeolian } from './aeolian.js';
import { createExperiment } from './experiment.js';
import { createReport } from './report.js';
import { createEvolve } from './evolve.js';

const canvas = document.getElementById('view');
const gl = createGL(canvas);
const quad = makeQuad(gl);

// accent color per render mode — the UI chameleons to match the field
const ACCENTS = ['#3b5bdb', '#e8590c', '#c2255c', '#0b7285', '#5f3dc4'];

const settings = {
  quality: 288,        // sim grid height in cells
  preset: 'cylinder',
  substeps: 10,
  tool: 'stir',        // stir | draw | erase
  brush: 0.04,         // brush radius as a fraction of grid height
  text: 'KÁRMÁN',
  paused: false,
};

let sim, renderer, particles;
const aeolian = new Aeolian();
const FORCE_EVERY = 4; // reduce/read the force texture every Nth animation frame

// Estimate shedding frequency + amplitude from the lift (Fy) ring buffer.
// Frequency = mean-crossing rate of the de-meaned signal in wall-clock Hz;
// amplitude = RMS of the de-meaned signal. One lift sample per force reduction
// (every FORCE_EVERY frames), so cycles/sample * (fps/FORCE_EVERY) gives Hz.
function estimateShedding() {
  // scan only the most recent window so the pitch reacts within seconds and
  // isn't diluted by stale ring-buffer content after resets
  const buf = sim.liftHistory;
  const N = 128;
  const start = (sim._liftIdx - N + buf.length * 2) % buf.length;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = buf[(start + i) % buf.length];
  const n = N;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += win[i];
  mean /= n;
  let crossings = 0, sumSq = 0, prev = win[0] - mean;
  for (let i = 0; i < n; i++) {
    const v = win[i] - mean;
    if ((v > 0) !== (prev > 0) && v !== 0) crossings++;
    sumSq += v * v;
    prev = v;
  }
  const rms = Math.sqrt(sumSq / n);
  // Two crossings per cycle. Force is sampled every FORCE_EVERY frames, so the
  // sample rate is fps/FORCE_EVERY; cycles/sample * sampleRate = Hz.
  const cyclesPerSample = crossings / (2 * n);
  const freqHz = cyclesPerSample * (fps / FORCE_EVERY);
  return { freqHz, amp: rms };
}

// Signal handed to the synth: pitch/gain source, normalized so gain can't blow
// out. norm = 0.5*rho*U^2*D (rho=1). Silent when paused or wind ~ 0.
function aeolianSignal() {
  if (settings.paused || sim.inVel < 0.005) return { silent: true };
  const { freqHz, amp } = estimateShedding();
  const D = sim.obstacleD || sim.h * 0.22;
  const norm = 0.5 * sim.inVel * sim.inVel * D;
  return { freqHz, amp, norm, silent: false };
}

// Characteristic length D = obstacle bounding-box height in cells, excluding
// the two channel wall rows (y=0, y=NY-1). Cached on sim for Cd/Cl. 0 = none.
function measureObstacle(sim) {
  let yMin = Infinity, yMax = -Infinity;
  for (let y = 1; y < sim.h - 1; y++) {
    const row = y * sim.w;
    for (let x = 0; x < sim.w; x++) {
      if (sim.mask[row + x] === SOLID) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; break; }
    }
  }
  sim.obstacleD = yMax >= yMin ? (yMax - yMin + 1) : 0;
  return sim.obstacleD;
}

function buildSim() {
  const aspect = Math.max(1, Math.min(3, canvas.clientWidth / canvas.clientHeight));
  const h = settings.quality;
  const w = Math.round(h * aspect);
  const prevTau = sim?.tau, prevVel = sim?.inVel, prevMode = renderer?.mode;

  sim = new LBM(gl, quad, w, h);
  renderer = new Renderer(gl, quad, w, h);
  particles = new Particles(gl, quad, w, h);
  if (prevTau !== undefined) { sim.tau = prevTau; sim.inVel = prevVel; renderer.mode = prevMode; }

  sim.mask.set(PRESETS[settings.preset].build(w, h, { text: settings.text }));
  sim.uploadMask();
  measureObstacle(sim);
  sim.reset();
  renderer.clearDye();
}

// Re-stamp the obstacle mask without resetting the flow — lets you retype the
// text obstacle while the wind keeps blowing.
function restampMask() {
  sim.mask.set(PRESETS[settings.preset].build(sim.w, sim.h, { text: settings.text }));
  sim.uploadMask();
  measureObstacle(sim);
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}

let resizeTimer;
window.addEventListener('resize', () => {
  resizeCanvas();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(buildSim, 250);
});

// ---------- pointer input ----------

const pointer = { down: false, x: 0, y: 0, px: 0, py: 0, button: 0, shift: false };
const lastCell = { x: 0, y: 0 };   // most recent pointer cell (for 'x' clap)
let dragMoved = false;             // did the pointer drag since pressing down
const ring = document.getElementById('ring');

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
  stampDisk(sim.mask, sim.w, sim.h, x, y, sim.h * settings.brush, erase ? 0 : SOLID);
  // keep the channel walls intact
  for (let i = 0; i < sim.w; i++) { sim.mask[i] = SOLID; sim.mask[(sim.h - 1) * sim.w + i] = SOLID; }
  sim.uploadMask();
  measureObstacle(sim);
}

function dyeColor(t) {
  // hue-cycling ink: convert an emissive hue to pigment (paper minus color)
  const c = [
    0.5 + 0.5 * Math.cos(t),
    0.5 + 0.5 * Math.cos(t + 2.094),
    0.5 + 0.5 * Math.cos(t + 4.188),
  ];
  return [(1 - c[0]) * 0.8, (1 - c[1]) * 0.8, (1 - c[2]) * 0.8];
}

function updateRing(e) {
  const painting = settings.tool !== 'stir' || (pointer.down && activeTool() !== 'stir');
  if (!painting) { ring.style.opacity = '0'; return; }
  const rect = canvas.getBoundingClientRect();
  const d = (sim.h * settings.brush * 2) * (rect.height / sim.h);
  ring.style.opacity = '1';
  ring.style.width = ring.style.height = `${d}px`;
  ring.style.left = `${e.clientX}px`;
  ring.style.top = `${e.clientY}px`;
}

function dismissToast() {
  document.getElementById('toast')?.classList.remove('show');
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  dismissToast();
  canvas.setPointerCapture(e.pointerId);
  const c = toCell(e);
  Object.assign(pointer, { down: true, x: c.x, y: c.y, px: c.x, py: c.y, button: e.button, shift: e.shiftKey });
  lastCell.x = c.x; lastCell.y = c.y;
  dragMoved = false;
  if (activeTool() !== 'stir') paint(c.x, c.y, activeTool() === 'erase');
  updateRing(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (sim) { updateRing(e); const lc = toCell(e); lastCell.x = lc.x; lastCell.y = lc.y; }
  if (!pointer.down) return;
  const c = toCell(e);
  pointer.px = pointer.x; pointer.py = pointer.y;
  pointer.x = c.x; pointer.y = c.y;
  pointer.shift = e.shiftKey;
  if (Math.hypot(c.x - pointer.px, c.y - pointer.py) > 0.5) dragMoved = true;

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
canvas.addEventListener('pointerleave', () => { ring.style.opacity = '0'; });
window.addEventListener('pointerup', () => {
  // In schlieren mode, a plain click (stir tool, no drag) claps an acoustic pulse.
  if (pointer.down && !dragMoved && renderer.mode === MODES.SCHLIEREN && activeTool() === 'stir') {
    clap(pointer.x, pointer.y);
  }
  pointer.down = false;
});

function clap(x, y) {
  if (sim) sim.clap = { x, y };
}

// ---------- UI ----------

const $ = (id) => document.getElementById(id);

let setMode, setTool;

function initUI() {
  const presetSel = $('preset');
  for (const [key, p] of Object.entries(PRESETS)) {
    presetSel.add(new Option(p.label, key));
  }
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
    if (settings.preset === 'text') restampMask(); // live re-carve, flow keeps running
  });

  const modeButtons = [...document.querySelectorAll('[data-mode]')];
  setMode = function (m) {
    renderer.mode = m;
    modeButtons.forEach((b) => b.classList.toggle('on', +b.dataset.mode === m));
    document.documentElement.style.setProperty('--accent', ACCENTS[m]);
  };
  modeButtons.forEach((b) => (b.onclick = () => setMode(+b.dataset.mode)));
  setMode(MODES.DYE);

  const toolButtons = [...document.querySelectorAll('[data-tool]')];
  setTool = function (t) {
    settings.tool = t;
    toolButtons.forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    if (t === 'stir') ring.style.opacity = '0';
  };
  toolButtons.forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  setTool('stir');

  function bindSlider(id, get, set, fmt, min, max) {
    const el = $(id), lab = $(id + 'Val');
    const fill = (v) => el.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
    el.value = get();
    lab.textContent = fmt(get());
    fill(get());
    el.oninput = () => { set(+el.value); lab.textContent = fmt(+el.value); fill(+el.value); };
  }
  bindSlider('flow', () => sim.inVel, (v) => { sim.inVel = v; }, (v) => v.toFixed(2), 0, 0.15);
  bindSlider('visc', () => sim.tau, (v) => { sim.tau = v; }, (v) => `τ ${v.toFixed(3)}`, 0.51, 0.7);
  bindSlider('speed', () => settings.substeps, (v) => { settings.substeps = v; }, (v) => `${v}×`, 1, 20);

  const qualitySel = $('quality');
  qualitySel.value = String(settings.quality);
  qualitySel.onchange = () => { settings.quality = +qualitySel.value; buildSim(); };

  $('pause').onclick = togglePause;
  $('reset').onclick = () => { sim.reset(); renderer.clearDye(); };
  $('clear').onclick = clearObstacles;

  aeolian.attach(aeolianSignal);
  $('sound').onclick = toggleSound;

  // wave-2: experiment sweep, report plate, shape evolution
  $('experiment').onclick = () => {
    if (experiment.running) experiment.stop();
    else { experiment.start(); syncExpButton(); }
    syncExpButton();
  };
  $('report').onclick = async () => {
    const b = $('report');
    const prev = b.textContent;
    b.textContent = 'measuring…'; b.disabled = true;
    // let the label paint before the synchronous measurement burst
    setTimeout(async () => {
      try { await report.run(false); }
      finally { b.textContent = prev; b.disabled = false; }
    }, 30);
  };
  $('evolve').onclick = () => {
    if (evolve.running) evolve.stop();
    else { experiment.chart.show(); evolve.start(); syncEvolveButton(); }
    syncEvolveButton();
  };

  $('collapse').onclick = () => $('panel').classList.toggle('collapsed');

  setTimeout(dismissToast, 8000);
}

function clearObstacles() {
  sim.mask.set(PRESETS.sandbox.build(sim.w, sim.h));
  sim.uploadMask();
  measureObstacle(sim);
}

function togglePause() {
  settings.paused = !settings.paused;
  $('pause').textContent = settings.paused ? 'Resume' : 'Pause';
}

// AudioContext must be created/resumed inside the click handler (autoplay).
function toggleSound() {
  const on = aeolian.toggle();
  $('sound').classList.toggle('on', on);
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === '1') setMode(MODES.DYE);
  else if (e.key === '2') setMode(MODES.VORTICITY);
  else if (e.key === '3') setMode(MODES.SPEED);
  else if (e.key === '4') setMode(MODES.TRACE);
  else if (e.key === '5') setMode(MODES.SCHLIEREN);
  else if (e.key === 'm') toggleSound();
  else if (e.key === 'x') clap(lastCell.x, lastCell.y);
  else if (e.key === 'r') { sim.reset(); renderer.clearDye(); }
  else if (e.key === 's') setTool('stir');
  else if (e.key === 'd') setTool('draw');
  else if (e.key === 'e') setTool('erase');
  else if (e.key === 'c') clearObstacles();
  else if (e.key === '[') settings.brush = Math.max(0.015, settings.brush / 1.25);
  else if (e.key === ']') settings.brush = Math.min(0.12, settings.brush * 1.25);
  else if (e.key === 'h') document.body.classList.toggle('hide-ui');
});

// ---------- main loop + HUD ----------

const hud = $('hud');
let frames = 0, lastHud = performance.now(), fps = 0;

function updateHud() {
  // Re uses the measured obstacle height when present (falls back to old est.).
  const D = sim.obstacleD || sim.h * 0.22;
  const re = Math.round((sim.inVel * D) / sim.nu);
  const mlups = ((sim.w * sim.h * settings.substeps * fps) / 1e6).toFixed(0);

  // Drag/lift coefficients from the momentum-exchange force (rho=1).
  // Cd = 2*Fx/(rho*U^2*D), Cl = 2*Fy/(rho*U^2*D). "—" when no obstacle.
  let coef;
  if (sim.obstacleD > 0 && sim.inVel > 1e-4) {
    const q = sim.inVel * sim.inVel * sim.obstacleD; // rho*U^2*D
    const cd = (2 * sim.forceAvg.fx) / q;
    const cl = (2 * sim.forceAvg.fy) / q;
    coef = `C<sub>d</sub> <b>${cd.toFixed(2)}</b> <i>·</i> C<sub>l</sub> <b>${cl.toFixed(2)}</b>`;
  } else {
    coef = `C<sub>d</sub> <b>—</b> <i>·</i> C<sub>l</sub> <b>—</b>`;
  }

  hud.innerHTML =
    `<b>${fps.toFixed(0)}</b> fps<i>·</i>${sim.w}×${sim.h}<i>·</i>` +
    `<b>${mlups}</b> MLUPS<i>·</i>Re ≈ <b>${re}</b><i>·</i>${coef}`;
}

let forceFrame = 0;

function frame(t) {
  if (!settings.paused) {
    sim.advance(settings.substeps);
    // Reduce/read the force texture once every FORCE_EVERY frames (bound stalls).
    if (forceFrame++ % FORCE_EVERY === 0) sim.sampleForce();
    renderer.advect(sim, settings.substeps);
    particles.step(sim, settings.substeps, t * 0.001);
  }
  renderer.draw(sim, particles.trailTex, canvas.width, canvas.height);

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

// Synchronous frame-warp shared by karman.warp and the wave-2 controllers.
// Advances `frames` frames of `settings.substeps` lattice steps each. Force is
// sampled sparsely here (each sample is a GPU sync); measurement routines that
// need force call sim.sampleForce() themselves after their own bursts.
function warpFrames(frames) {
  for (let i = 0; i < frames; i++) {
    sim.advance(settings.substeps);
    if (i % 16 === 0) sim.sampleForce();
    renderer.advect(sim, settings.substeps);
    particles.step(sim, settings.substeps, warpFrames._t++ * 0.016);
  }
  renderer.draw(sim, particles.trailTex, canvas.width, canvas.height);
}
warpFrames._t = 0;

// Deps handed to the wave-2 controllers. Accessors are live (buildSim swaps
// sim/renderer), so controllers capture their sim at start and abort if the
// getSim() reference changes underneath them.
const wave2Deps = {
  getSim: () => sim,
  warp: warpFrames,
  getSubsteps: () => settings.substeps,
  getGLCanvas: () => canvas,
  isCylinder: () => settings.preset === 'cylinder',
  get presetLabel() { return PRESETS[settings.preset]?.label || settings.preset; },
  get modeName() { return ['dye', 'vorticity', 'speed', 'trace', 'schlieren'][renderer.mode] || 'dye'; },
};

// extend via prototype, NOT spread: spreading would evaluate the live getters
// now, before sim/renderer exist
const experiment = createExperiment(Object.setPrototypeOf({ onDone: () => syncExpButton() }, wave2Deps));
const report = createReport(wave2Deps);
const evolve = createEvolve(Object.setPrototypeOf({
  onStatus: (t) => experiment.chart.status(t),
  onDone: () => syncEvolveButton(),
}, wave2Deps));

function syncExpButton() {
  const b = $('experiment');
  if (b) b.textContent = experiment.running ? 'Stop' : 'Experiment';
}
function syncEvolveButton() {
  const b = $('evolve');
  if (b) b.textContent = evolve.running ? 'Stop' : 'Evolve';
}

// Tiny console API — open devtools and play. karman.warp(600) fast-forwards
// 600 frames synchronously (great for capturing a developed wake).
window.karman = {
  warp(frames = 600) {
    const t0 = performance.now();
    warpFrames(frames);
    return `${frames} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  },
  mode: (m) => setMode(m),
  get sim() { return sim; },
  get aeolian() { return aeolian; },
  get signal() { return aeolianSignal(); },
  experiment,
  report: () => report.run(true),
  evolve,
};

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

boot();
