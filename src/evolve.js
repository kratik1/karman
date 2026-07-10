// Wave-2 stretch goal: greedy drag-minimizing mutation loop on the obstacle
// mask. Mutate -> settle -> measure mean Fx -> keep if drag dropped, else
// revert. Chunked async; cancellable. A greedy demo, not an optimizer.

import { SOLID, stampDisk } from './presets.js';

const SETTLE = 250, MEAS = 250, MEAS_EVERY = 8, CHUNK = 50;
const DISK_R = 3;
const INLET_X = 20;         // protect the inlet columns
const D_TOLERANCE = 0.15;   // keep obstacle height within +-15% of original

// Obstacle bounding-box height (excludes the two wall rows), like main.js.
function measureD(mask, w, h) {
  let yMin = Infinity, yMax = -Infinity;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] === SOLID) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; break; }
    }
  }
  return yMax >= yMin ? (yMax - yMin + 1) : 0;
}

// Collect boundary cells: solid cells adjacent to a fluid cell (4-neighborhood),
// excluding wall rows and the inlet columns.
function boundaryCells(mask, w, h) {
  const cells = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = INLET_X; x < w - 1; x++) {
      if (mask[y * w + x] !== SOLID) continue;
      if (mask[y * w + x - 1] !== SOLID || mask[y * w + x + 1] !== SOLID ||
          mask[(y - 1) * w + x] !== SOLID || mask[(y + 1) * w + x] !== SOLID) {
        cells.push({ x, y });
      }
    }
  }
  return cells;
}

export function createEvolve(deps) {
  const { getSim, warp, onStatus, onDone } = deps;

  const ctrl = {
    running: false,
    _cancel: false,
    gen: 0,
    bestCd: Infinity,
    curCd: Infinity,
    start,
    stop,
  };

  function stop() { ctrl._cancel = true; }

  // Measure mean Fx over MEAS frames after SETTLE, chunked. Calls back when done.
  function measureDrag(sim, isCurrent, done) {
    let settled = 0;
    const meas = { sumFx: 0, n: 0, done: 0 };

    function tick() {
      if (!isCurrent()) { done(null); return; }
      if (settled < SETTLE) {
        const step = Math.min(CHUNK, SETTLE - settled);
        warp(step); settled += step;
        setTimeout(tick, 0); return;
      }
      if (meas.done < MEAS) {
        const burst = Math.min(CHUNK, MEAS - meas.done);
        for (let f = 0; f < burst; f += MEAS_EVERY) {
          warp(MEAS_EVERY); sim.sampleForce();
          meas.sumFx += sim.force.fx; meas.n++;
        }
        meas.done += burst;
        setTimeout(tick, 0); return;
      }
      done(meas.n ? meas.sumFx / meas.n : 0);
    }
    setTimeout(tick, 0);
  }

  function start() {
    if (ctrl.running) return;
    const sim = getSim();
    const w = sim.w, h = sim.h;
    const origD = measureD(sim.mask, w, h) || 1;
    ctrl.running = true; ctrl._cancel = false;
    ctrl.gen = 0; ctrl.bestCd = Infinity; ctrl.curCd = Infinity;

    function isCurrent() { return getSim() === sim && !ctrl._cancel; }
    const U = sim.inVel, D = origD;
    const cdOf = (fx) => (2 * fx) / (U * U * D);

    let bestMask = Uint8Array.from(sim.mask);
    let bestFx = Infinity;

    function finish(cancelled) {
      ctrl.running = false;
      // Leave the best mask installed.
      if (getSim() === sim) { sim.mask.set(bestMask); sim.uploadMask(); }
      status(cancelled ? 'evolve stopped' : 'evolve done');
      onDone && onDone();
    }

    function status(extra) {
      const b = isFinite(ctrl.bestCd) ? ctrl.bestCd.toFixed(3) : '—';
      const c = isFinite(ctrl.curCd) ? ctrl.curCd.toFixed(3) : '—';
      onStatus && onStatus(`evolve · gen ${ctrl.gen} · Cd ${c} · best ${b}${extra ? ' · ' + extra : ''}`);
    }

    // Apply a random mutation to `mask`. Returns true if applied within bounds.
    function mutate(mask) {
      const cells = boundaryCells(mask, w, h);
      if (!cells.length) return false;
      const c = cells[(Math.random() * cells.length) | 0];
      const grow = Math.random() < 0.5;
      if (grow) {
        // stamp a solid disk at a random adjacent empty cell
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const d = dirs[(Math.random() * 4) | 0];
        const nx = c.x + d[0] * DISK_R, ny = c.y + d[1] * DISK_R;
        if (nx < INLET_X || nx >= w - 1 || ny < 2 || ny >= h - 2) return false;
        stampDisk(mask, w, h, nx, ny, DISK_R, SOLID);
      } else {
        stampDisk(mask, w, h, c.x, c.y, DISK_R, 0);
      }
      // keep the walls intact
      for (let i = 0; i < w; i++) { mask[i] = SOLID; mask[(h - 1) * w + i] = SOLID; }
      // reject if height drifted outside tolerance
      const nd = measureD(mask, w, h);
      if (Math.abs(nd - origD) / origD > D_TOLERANCE) return false;
      return true;
    }

    // First: measure the baseline drag of the starting shape.
    status('baseline…');
    measureDrag(sim, isCurrent, (fx0) => {
      if (fx0 === null) { finish(true); return; }
      bestFx = fx0; ctrl.bestCd = cdOf(fx0); ctrl.curCd = ctrl.bestCd;
      status();
      step();
    });

    function step() {
      if (!isCurrent()) { finish(true); return; }

      // trial mask = best + one mutation
      const trial = Uint8Array.from(bestMask);
      let ok = false;
      for (let attempt = 0; attempt < 8 && !ok; attempt++) {
        trial.set(bestMask);
        ok = mutate(trial);
      }
      if (!ok) { setTimeout(step, 0); return; }

      sim.mask.set(trial); sim.uploadMask();
      sim.obstacleD = measureD(trial, w, h);
      ctrl.gen++;
      status('measuring…');

      measureDrag(sim, isCurrent, (fx) => {
        if (fx === null) { finish(true); return; }
        ctrl.curCd = cdOf(fx);
        if (fx < bestFx) {
          bestFx = fx; bestMask = Uint8Array.from(trial);
          ctrl.bestCd = ctrl.curCd;
        } else {
          // revert: reinstall best
          sim.mask.set(bestMask); sim.uploadMask();
          sim.obstacleD = measureD(bestMask, w, h);
        }
        status();
        setTimeout(step, 0);
      });
    }
  }

  return ctrl;
}
