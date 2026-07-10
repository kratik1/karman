// Wave-2 experiment mode: automated Reynolds sweep over tau at fixed U.
// Measures drag (Cd) and Strouhal (St) per point and plots them live vs Re
// against literature reference curves. All timing chunked via setTimeout so the
// UI keeps breathing even when the tab is throttled.

// --- physics / reference curves (unbounded 2D cylinder) ---

// Re = U*D / nu, nu = (tau - 0.5)/3.
export function reynolds(U, D, tau) {
  const nu = (tau - 0.5) / 3;
  return (U * D) / nu;
}

// Sucker & Brauer empirical drag fit, good 10<Re<1e4. Unbounded domain; our
// channel (~22% blockage) reads above this.
export function cdRef(Re) {
  return 1.18 + 6.8 / Math.pow(Re, 0.89);
}

// Roshko/Williamson Strouhal fit for the shedding branch, clamped >= 0.
export function stRef(Re) {
  if (Re <= 50) return 0;
  return Math.max(0, 0.212 * (1 - 21.2 / Re));
}

// Shared Strouhal-in-lattice-steps measurement. Runs `measFrames` frames while
// sampling Fy every `sampleEvery` frames into a lift series, then counts mean
// crossings. Each frame is `substeps` lattice steps, so samples are spaced
// (sampleEvery*substeps) steps apart. f_steps = crossings/(2*n*stepsPerSample);
// St = f_steps * D / U. Also returns mean Fx (drag) accumulated in parallel.
// Synchronous — the caller controls chunking. Returns null if the sim was
// swapped out mid-run (capturedSim guard), so callers can abort cleanly.
export function measureStLattice(sim, opts) {
  const {
    warpStep,                 // (n) => advance n frames of `substeps` steps each
    substeps,
    measFrames = 700,
    sampleEvery = 8,
    U = sim.inVel,
    D = sim.obstacleD,
    isCurrent = () => true,
  } = opts;

  const lift = [];
  let sumFx = 0, nFx = 0;
  for (let f = 0; f < measFrames; f += sampleEvery) {
    if (!isCurrent()) return null;
    warpStep(sampleEvery);
    sim.sampleForce();
    lift.push(sim.force.fy);
    sumFx += sim.force.fx; nFx++;
  }

  const n = lift.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += lift[i];
  mean /= n;
  let crossings = 0, prev = lift[0] - mean;
  for (let i = 0; i < n; i++) {
    const v = lift[i] - mean;
    if ((v > 0) !== (prev > 0) && v !== 0) crossings++;
    prev = v;
  }
  const stepsPerSample = sampleEvery * substeps;
  const fSteps = crossings / (2 * n * stepsPerSample); // cycles per lattice step
  const meanFx = nFx ? sumFx / nFx : 0;
  const St = (fSteps * D) / U;
  return { St, fSteps, meanFx, samples: n };
}

// 8 points, tau log-spaced 0.65 -> 0.505.
function sweepTaus() {
  const hi = 0.65, lo = 0.505, N = 8;
  const out = [];
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    out.push(Math.exp(Math.log(hi) + t * (Math.log(lo) - Math.log(hi))));
  }
  return out;
}

// Controller factory. `deps` supplies the live sim accessor and a synchronous
// frame-warp used for both settling and measuring.
export function createExperiment(deps) {
  const { getSim, warp, getSubsteps, isCylinder } = deps;

  const ctrl = {
    running: false,
    results: [],      // [{Re, Cd, St, tau}]
    _cancel: false,
    _origTau: null,
    _sim: null,
    start,
    stop,
  };

  const chart = new Chart();

  function stop() {
    ctrl._cancel = true;
  }

  function start() {
    if (ctrl.running) return;
    const sim = getSim();
    ctrl._sim = sim;
    ctrl._origTau = sim.tau;
    ctrl.running = true;
    ctrl._cancel = false;
    ctrl.results = [];
    const taus = sweepTaus();
    const U = sim.inVel, D = sim.obstacleD || sim.h * 0.22;

    chart.show();
    chart.reset({ U, D, cylinder: isCylinder() });

    const substeps = getSubsteps();
    // Warp helper: advance `frames` frames of `substeps` steps. Sparse force
    // sampling here is just to keep the wake fed; measurement samples explicitly.
    const warpStep = (frames) => warp(frames);

    let idx = 0;
    let phase = 'settle';           // settle -> measure per point
    let settled = 0;
    const SETTLE = 400, CHUNK = 50;

    const measState = { lift: [], sumFx: 0, nFx: 0, done: 0 };
    const MEAS = 700, MEAS_EVERY = 8;

    function isCurrent() { return getSim() === sim && !ctrl._cancel; }

    function finish(cancelled) {
      ctrl.running = false;
      // Restore tau on the live sim if it is still ours.
      if (getSim() === sim) sim.tau = ctrl._origTau;
      chart.status(cancelled ? 'stopped · tau restored' : 'sweep complete');
      deps.onDone && deps.onDone();
    }

    function tick() {
      if (!isCurrent()) { finish(true); return; }
      if (idx >= taus.length) { finish(false); return; }

      const tau = taus[idx];
      const Re = reynolds(U, D, tau);
      sim.tau = tau;

      if (phase === 'settle') {
        if (settled === 0) {
          chart.status(`point ${idx + 1}/8 · Re ${Math.round(Re)} · settling…`);
        }
        const step = Math.min(CHUNK, SETTLE - settled);
        warpStep(step);
        settled += step;
        if (settled >= SETTLE) { phase = 'measure'; }
        setTimeout(tick, 0);
        return;
      }

      // phase === 'measure' — accumulate Fx and lift series in CHUNK bursts.
      if (measState.done === 0) {
        chart.status(`point ${idx + 1}/8 · Re ${Math.round(Re)} · measuring…`);
      }
      const remaining = MEAS - measState.done;
      const burst = Math.min(CHUNK, remaining);
      for (let f = 0; f < burst; f += MEAS_EVERY) {
        warpStep(MEAS_EVERY);
        sim.sampleForce();
        measState.lift.push(sim.force.fy);
        measState.sumFx += sim.force.fx; measState.nFx++;
      }
      measState.done += burst;

      if (measState.done >= MEAS) {
        // finalize this point
        const meanFx = measState.sumFx / measState.nFx;
        const Cd = (2 * meanFx) / (U * U * D);
        const lift = measState.lift;
        const nS = lift.length;
        let mean = 0;
        for (let i = 0; i < nS; i++) mean += lift[i];
        mean /= nS;
        let crossings = 0, prev = lift[0] - mean;
        for (let i = 0; i < nS; i++) {
          const v = lift[i] - mean;
          if ((v > 0) !== (prev > 0) && v !== 0) crossings++;
          prev = v;
        }
        const stepsPerSample = MEAS_EVERY * substeps;
        const fSteps = crossings / (2 * nS * stepsPerSample);
        const St = (fSteps * D) / U;

        const point = { Re, Cd, St, tau };
        ctrl.results.push(point);
        chart.addPoint(point);

        // advance to next point
        idx++;
        phase = 'settle';
        settled = 0;
        measState.lift = []; measState.sumFx = 0; measState.nFx = 0; measState.done = 0;
      }
      setTimeout(tick, 0);
    }

    setTimeout(tick, 0);
  }

  ctrl.chart = chart;
  return ctrl;
}

// ---------------------------------------------------------------------------
// Live chart: paper-white card, log-x Re, dual-axis Cd (left) + St (right).
// ---------------------------------------------------------------------------

const INK = '#22263a';
const INDIGO = '#29388a';
const VERMIL = '#c0392b';
const DIM = '#8b8574';
const PAPER = '#f4f1e9';
const MONO = "10px 'SF Mono', ui-monospace, Menlo, monospace";

class Chart {
  constructor() {
    this.el = null;
    this.canvas = null;
    this.ctx = null;
    this.points = [];
    this.cfg = { U: 0.1, D: 64, cylinder: true };
    this._build();
  }

  _build() {
    // Card wrapper matching the panel's ivory glass styling.
    const card = document.createElement('div');
    card.id = 'chartCard';
    Object.assign(card.style, {
      position: 'fixed', right: '18px', bottom: '18px',
      width: '420px', height: '260px',
      background: 'rgba(252, 250, 245, 0.94)',
      backdropFilter: 'blur(20px) saturate(1.15)',
      webkitBackdropFilter: 'blur(20px) saturate(1.15)',
      border: '1px solid rgba(35,30,20,0.12)', borderRadius: '14px',
      boxShadow: '0 16px 44px rgba(60,50,28,0.18), inset 0 1px 0 rgba(255,255,255,0.65)',
      display: 'none', zIndex: '20', overflow: 'hidden',
    });

    const close = document.createElement('button');
    close.textContent = '✕';
    Object.assign(close.style, {
      position: 'absolute', top: '6px', right: '8px', border: '0',
      background: 'transparent', color: DIM, cursor: 'pointer',
      font: '12px ui-monospace, monospace', padding: '2px 4px', zIndex: '2',
    });
    close.onclick = () => this.hide();

    const canvas = document.createElement('canvas');
    canvas.id = 'chart';
    canvas.width = 420 * 2; canvas.height = 260 * 2;   // retina
    Object.assign(canvas.style, { width: '420px', height: '260px', display: 'block' });

    card.appendChild(canvas);
    card.appendChild(close);
    document.body.appendChild(card);

    this.el = card;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.scale(2, 2);
    this._statusText = '';
  }

  show() { this.el.style.display = 'block'; }
  hide() { this.el.style.display = 'none'; }

  reset(cfg) {
    this.cfg = { ...this.cfg, ...cfg };
    this.points = [];
    this._statusText = '';
    this._draw();
  }

  status(t) { this._statusText = t; this._draw(); }

  addPoint(p) { this.points.push(p); this._draw(); }

  // log-x layout. Re range fixed 80..5000 to bracket the sweep.
  _draw() {
    const ctx = this.ctx;
    const W = 420, H = 260;
    const L = 46, R = 46, T = 30, B = 34;   // plot margins
    const px = L, py = T, pw = W - L - R, ph = H - T - B;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);

    const reMin = 80, reMax = 5000;
    const lg = (v) => Math.log10(v);
    const xOf = (re) => px + ((lg(re) - lg(reMin)) / (lg(reMax) - lg(reMin))) * pw;
    const cdMin = 0, cdMax = 3;
    const yCd = (cd) => py + ph - ((cd - cdMin) / (cdMax - cdMin)) * ph;
    const stMin = 0, stMax = 0.35;
    const ySt = (st) => py + ph - ((st - stMin) / (stMax - stMin)) * ph;

    // title
    ctx.fillStyle = INK;
    ctx.font = "600 11px 'SF Mono', ui-monospace, Menlo, monospace";
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('cylinder · Cd & St vs Re', px, 16);

    // plot frame
    ctx.strokeStyle = 'rgba(35,30,20,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px, py, pw, ph);

    ctx.font = MONO;
    // x ticks (Re)
    ctx.fillStyle = DIM; ctx.textAlign = 'center';
    for (const re of [100, 300, 1000, 3000]) {
      const x = xOf(re);
      ctx.strokeStyle = 'rgba(35,30,20,0.10)';
      ctx.beginPath(); ctx.moveTo(x, py); ctx.lineTo(x, py + ph); ctx.stroke();
      ctx.fillText(String(re), x, py + ph + 12);
    }
    ctx.fillText('Re →', px + pw / 2, H - 4);

    // left axis Cd ticks
    ctx.textAlign = 'right';
    ctx.fillStyle = INDIGO;
    for (const cd of [0, 1, 2, 3]) {
      const y = yCd(cd);
      ctx.fillText(cd.toFixed(0), px - 6, y + 3);
    }
    ctx.save();
    ctx.translate(12, py + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillText('Cd', 0, 0);
    ctx.restore();

    // right axis St ticks
    ctx.textAlign = 'left';
    ctx.fillStyle = VERMIL;
    for (const st of [0, 0.1, 0.2, 0.3]) {
      const y = ySt(st);
      ctx.fillText(st.toFixed(1), px + pw + 6, y + 3);
    }
    ctx.save();
    ctx.translate(W - 10, py + ph / 2); ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillText('St', 0, 0);
    ctx.restore();

    // reference curves (dashed, thin), drawn before data
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    // Cd_ref
    ctx.strokeStyle = 'rgba(41,56,138,0.5)';
    ctx.beginPath();
    for (let re = reMin; re <= reMax; re *= 1.05) {
      const x = xOf(re), y = yCd(Math.min(cdMax, cdRef(re)));
      re === reMin ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    // St_ref
    ctx.strokeStyle = 'rgba(192,57,43,0.5)';
    ctx.beginPath();
    let first = true;
    for (let re = reMin; re <= reMax; re *= 1.05) {
      const st = stRef(re);
      const x = xOf(re), y = ySt(Math.min(stMax, st));
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // measured data — Cd line+dots (indigo), St dots (vermilion)
    if (this.points.length) {
      ctx.strokeStyle = INDIGO; ctx.lineWidth = 1.5;
      ctx.beginPath();
      this.points.forEach((p, i) => {
        const x = xOf(p.Re), y = yCd(Math.min(cdMax, p.Cd));
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = INDIGO;
      for (const p of this.points) {
        const x = xOf(p.Re), y = yCd(Math.min(cdMax, p.Cd));
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill();
      }
      ctx.fillStyle = VERMIL;
      for (const p of this.points) {
        const x = xOf(p.Re), y = ySt(Math.min(stMax, p.St));
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill();
      }
    }

    // footnote + status
    ctx.font = "9px 'SF Mono', ui-monospace, Menlo, monospace";
    ctx.textAlign = 'left'; ctx.fillStyle = DIM;
    const note = this.cfg.cylinder
      ? 'ref: unbounded cylinder · 22% blockage raises Cd'
      : 'references assume a cylinder';
    ctx.fillText(note, px, 26);

    if (this._statusText) {
      // own line below the footnote — the two strings are long enough to
      // collide when sharing a baseline
      ctx.textAlign = 'right'; ctx.fillStyle = INK;
      ctx.fillText(this._statusText, px + pw, 38);
    }
  }
}
