// Wave-2 report plate: a 1930s NACA technical-note styled PNG, all Canvas2D.
// Header + serif title, flow snapshot (copied from the live WebGL canvas),
// a measurements table, an obstacle silhouette inset, and small print.

import { measureStLattice } from './experiment.js';

const SERIF = "Georgia, 'Times New Roman', serif";
const MONO = "'SF Mono', ui-monospace, Menlo, monospace";
const PAPER = '#f4f1e9';
const INK = '#22263a';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Gather the measurement bundle. St is measured over a short lattice-step burst
// (shared helper) so it matches the experiment's units, not the audio estimator.
export function gatherMeasurements(deps) {
  const sim = deps.getSim();
  const substeps = deps.getSubsteps();
  const U = sim.inVel;
  const D = sim.obstacleD || sim.h * 0.22;
  const nu = (sim.tau - 0.5) / 3;
  const Re = (U * D) / nu;

  const Cd = sim.obstacleD > 0 && U > 1e-4 ? (2 * sim.forceAvg.fx) / (U * U * D) : 0;
  const Cl = sim.obstacleD > 0 && U > 1e-4 ? (2 * sim.forceAvg.fy) / (U * U * D) : 0;

  // 300-frame lattice-step St burst.
  const st = measureStLattice(sim, {
    warpStep: (n) => deps.warp(n),
    substeps,
    measFrames: 300,
    sampleEvery: 8,
    U, D,
  });

  return {
    Re, Cd, Cl,
    St: st ? st.St : 0,
    fSteps: st ? st.fSteps : 0,
    grid: `${sim.w} × ${sim.h}`,
    tau: sim.tau,
    U,
    D,
    presetLabel: deps.presetLabel,
    modeName: deps.modeName,
  };
}

// Build the plate onto a fresh 1400x1000 offscreen canvas. `glCanvas` is the
// live WebGL canvas (preserveDrawingBuffer keeps its pixels readable).
export function buildPlate(m, glCanvas, sim) {
  const W = 1400, H = 1000;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  // double-rule border
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.strokeRect(34, 34, W - 68, H - 68);
  ctx.lineWidth = 1;
  ctx.strokeRect(42, 42, W - 84, H - 84);

  const M = 70;  // content margin

  // --- header ---
  const note = 100 + Math.floor(Math.random() * 900);
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.font = `600 15px ${MONO}`;
  smallCaps(ctx, `TECHNICAL NOTE No. ${note}`, W / 2, 92, 3);

  ctx.font = `700 40px ${SERIF}`;
  const title = `WIND-TUNNEL MEASUREMENTS ON A ${(m.presetLabel || 'CYLINDER').toUpperCase()} SECTION`;
  // wrapCentered centers the line block on y — anchor low enough that a
  // two-line title clears the TECHNICAL NOTE line above
  wrapCentered(ctx, title, W / 2, 158, W - 200, 46);

  ctx.font = `italic 17px ${SERIF}`;
  ctx.fillStyle = '#4a4d5e';
  ctx.fillText('kármán digital wind tunnel · lattice-Boltzmann method', W / 2, 208);

  const now = new Date();
  ctx.font = `15px ${SERIF}`;
  ctx.fillStyle = INK;
  ctx.fillText(`Washington · ${MONTHS[now.getMonth()]} ${now.getFullYear()}`, W / 2, 234);

  // header rule
  ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(M, 256); ctx.lineTo(W - M, 256); ctx.stroke();

  // --- left column: flow snapshot (~55%) ---
  const colY = 290;
  const leftW = Math.round((W - 2 * M) * 0.55);
  const leftX = M;
  const figH = 430;

  // Copy central region of the live canvas.
  ctx.save();
  ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
  ctx.strokeRect(leftX, colY, leftW, figH);
  try {
    const sw = glCanvas.width, sh = glCanvas.height;
    // central crop to match the plate aspect
    const cropAsp = leftW / figH;
    let cw = sw, ch = Math.round(sw / cropAsp);
    if (ch > sh) { ch = sh; cw = Math.round(sh * cropAsp); }
    const sx = Math.round((sw - cw) / 2), sy = Math.round((sh - ch) / 2);
    ctx.drawImage(glCanvas, sx, sy, cw, ch, leftX + 2, colY + 2, leftW - 4, figH - 4);
  } catch (e) {
    ctx.fillStyle = '#e7e3d8';
    ctx.fillRect(leftX + 2, colY + 2, leftW - 4, figH - 4);
  }
  ctx.restore();

  ctx.fillStyle = INK; ctx.textAlign = 'left';
  ctx.font = `italic 15px ${SERIF}`;
  ctx.fillText(`Figure 1. — Vortex street in the wake; ${m.modeName || 'dye'} visualization.`,
    leftX, colY + figH + 26);

  // --- right column: measurements table ---
  const rightX = leftX + leftW + 48;
  const rightW = (W - M) - rightX;
  let ty = colY + 8;

  ctx.fillStyle = INK; ctx.textAlign = 'left';
  ctx.font = `600 16px ${MONO}`;
  smallCaps(ctx, 'MEASUREMENTS', rightX, ty, 2);
  ty += 14;
  ctx.strokeStyle = 'rgba(34,38,58,0.4)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(rightX, ty); ctx.lineTo(rightX + rightW, ty); ctx.stroke();
  ty += 30;

  const rows = [
    ['Reynolds number', Math.round(m.Re).toString()],
    ['Drag coefficient C_D', m.Cd.toFixed(3)],
    ['Lift coefficient C_L (mean)', m.Cl.toFixed(3)],
    ['Strouhal number St', m.St.toFixed(3)],
    ['Shedding freq. (lattice)', m.fSteps.toExponential(2) + ' /step'],
    ['Grid', m.grid],
    ['Relaxation time τ', m.tau.toFixed(3)],
    ['Inflow U', m.U.toFixed(3)],
  ];
  const rowH = 42;
  for (const [label, val] of rows) {
    ctx.fillStyle = INK; ctx.textAlign = 'left';
    ctx.font = `17px ${SERIF}`;
    ctx.fillText(label, rightX, ty);
    ctx.textAlign = 'right';
    ctx.font = `600 17px ${MONO}`;
    ctx.fillText(val, rightX + rightW, ty);
    ctx.strokeStyle = 'rgba(34,38,58,0.12)';
    ctx.beginPath(); ctx.moveTo(rightX, ty + 12); ctx.lineTo(rightX + rightW, ty + 12); ctx.stroke();
    ty += rowH;
  }

  // --- obstacle silhouette inset (plan-form drawing), top-right ---
  drawMaskInset(ctx, sim, rightX, ty + 20, rightW, 130);

  // --- footer ---
  ctx.strokeStyle = INK; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(M, H - 96); ctx.lineTo(W - M, H - 96); ctx.stroke();
  ctx.fillStyle = '#4a4d5e'; ctx.textAlign = 'center';
  ctx.font = `13px ${SERIF}`;
  ctx.fillText('Results obtained with the momentum-exchange method on a D2Q9 lattice. Channel blockage uncorrected.',
    W / 2, H - 74);

  return cv;
}

// Sample sim.mask into a small ink-on-paper thumbnail (plan-form drawing).
function drawMaskInset(ctx, sim, x, y, maxW, maxH) {
  ctx.fillStyle = INK; ctx.textAlign = 'left';
  ctx.font = `italic 13px Georgia, serif`;
  ctx.fillText('plan-form of the section', x, y - 6);

  const asp = sim.w / sim.h;
  let iw = maxW, ih = Math.round(maxW / asp);
  if (ih > maxH) { ih = maxH; iw = Math.round(maxH * asp); }

  ctx.strokeStyle = 'rgba(34,38,58,0.35)'; ctx.lineWidth = 1;
  ctx.strokeRect(x, y, iw, ih);

  const img = ctx.createImageData(iw, ih);
  const d = img.data;
  const SOLID = 255;
  for (let py = 0; py < ih; py++) {
    // flip y: sim y points up, canvas y points down
    const sy = Math.min(sim.h - 1, Math.floor(((ih - 1 - py) / ih) * sim.h));
    for (let px = 0; px < iw; px++) {
      const sx = Math.min(sim.w - 1, Math.floor((px / iw) * sim.w));
      const solid = sim.mask[sy * sim.w + sx] === SOLID;
      const i = (py * iw + px) * 4;
      if (solid) { d[i] = 0x22; d[i + 1] = 0x26; d[i + 2] = 0x3a; d[i + 3] = 255; }
      else { d[i] = 0xf4; d[i + 1] = 0xf1; d[i + 2] = 0xe9; d[i + 3] = 255; }
    }
  }
  ctx.putImageData(img, x + 1, y + 1);
}

// letter-spaced small caps at the current font, centered or left per textAlign.
function smallCaps(ctx, text, x, y, tracking) {
  const chars = [...text];
  let total = 0;
  for (const c of chars) total += ctx.measureText(c).width + tracking;
  total -= tracking;
  let cx = ctx.textAlign === 'center' ? x - total / 2 : x;
  const savedAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const c of chars) {
    ctx.fillText(c, cx, y);
    cx += ctx.measureText(c).width + tracking;
  }
  ctx.textAlign = savedAlign;
}

function wrapCentered(ctx, text, x, y, maxW, lineH) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  const startY = y - ((lines.length - 1) * lineH) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, x, startY + i * lineH));
}

// Controller: gather (short synchronous burst chunked), build, download PNG.
// Also returns a data URL for testing.
export function createReport(deps) {
  async function run(returnDataUrl) {
    const sim = deps.getSim();
    const m = gatherMeasurements(deps);
    // guard: sim may have been swapped during the burst
    if (deps.getSim() !== sim) return null;
    const cv = buildPlate(m, deps.getGLCanvas(), sim);

    if (returnDataUrl) return cv.toDataURL('image/png');

    return new Promise((resolve) => {
      cv.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'karman-report.png';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        resolve(url);
      }, 'image/png');
    });
  }
  return { run };
}
