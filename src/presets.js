// Obstacle mask generators. Masks are Uint8Array(w*h); SOLID = solid cell.
// The mask is uploaded to a normalized R8 texture, so solid must be 255 (reads
// back as 1.0 in the shader); 1 would read back as 1/255 and fail the > 0.5 test.
// All presets include thin top/bottom walls so the channel behaves like a
// wind tunnel section (no-slip via bounce-back).

export const SOLID = 255;

function blank(w, h) {
  const m = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    m[x] = SOLID;                 // bottom wall
    m[(h - 1) * w + x] = SOLID;   // top wall
  }
  return m;
}

export function stampDisk(mask, w, h, cx, cy, r, value = SOLID) {
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) mask[y * w + x] = value;
    }
  }
}

function cylinder(w, h) {
  const m = blank(w, h);
  // slightly off-center vertically: breaks symmetry, shedding starts sooner
  stampDisk(m, w, h, w * 0.22, h * 0.5 + 1.5, h * 0.11);
  return m;
}

function pillars(w, h) {
  const m = blank(w, h);
  const r = h * 0.055;
  stampDisk(m, w, h, w * 0.18, h * 0.36, r);
  stampDisk(m, w, h, w * 0.30, h * 0.64, r);
  stampDisk(m, w, h, w * 0.42, h * 0.40, r);
  return m;
}

// NACA 0012 airfoil at an angle of attack.
function airfoil(w, h) {
  const m = blank(w, h);
  const chord = w * 0.32;
  const aoa = (-12 * Math.PI) / 180;
  const cx = w * 0.2, cy = h * 0.52;
  const cosA = Math.cos(aoa), sinA = Math.sin(aoa);
  const t = 0.12; // thickness ratio

  // rasterize by checking each cell against the rotated thickness envelope
  const x0 = Math.max(0, Math.floor(cx - chord * 0.2));
  const x1 = Math.min(w - 1, Math.ceil(cx + chord * 1.2));
  const y0 = Math.max(0, Math.floor(cy - chord * 0.5));
  const y1 = Math.min(h - 1, Math.ceil(cy + chord * 0.5));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // transform into chord coordinates
      const dx = x - cx, dy = y - cy;
      const xc = (dx * cosA - dy * sinA) / chord;
      const yc = (dx * sinA + dy * cosA) / chord;
      if (xc < 0 || xc > 1) continue;
      const yt = 5 * t * (0.2969 * Math.sqrt(xc) - 0.1260 * xc - 0.3516 * xc * xc
               + 0.2843 * xc ** 3 - 0.1015 * xc ** 4);
      if (Math.abs(yc) <= yt) m[y * w + x] = SOLID;
    }
  }
  return m;
}

function sandbox(w, h) {
  return blank(w, h);
}

// Rasterize arbitrary text into the obstacle mask via an offscreen 2D canvas —
// put your own name in the wind tunnel.
function textObstacle(w, h, opts) {
  const text = (opts && opts.text ? opts.text : 'KÁRMÁN').trim() || 'KÁRMÁN';
  const m = blank(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const font = (s) => `900 ${s}px "Arial Black", "Helvetica Neue", sans-serif`;
  let size = h * 0.30;
  ctx.font = font(size);
  while (ctx.measureText(text).width > w * 0.55 && size > 6) {
    size *= 0.93;
    ctx.font = font(size);
  }
  ctx.fillStyle = '#fff';
  ctx.fillText(text, w * 0.42, h * 0.5);
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // canvas rows are top-down; the sim's y axis points up
      if (d[(y * w + x) * 4 + 3] > 128) m[(h - 1 - y) * w + x] = SOLID;
    }
  }
  return m;
}

export const PRESETS = {
  cylinder: { label: 'Cylinder', build: cylinder },
  airfoil:  { label: 'Airfoil (NACA 0012)', build: airfoil },
  pillars:  { label: 'Pillar slalom', build: pillars },
  text:     { label: 'Your text…', build: textObstacle },
  sandbox:  { label: 'Empty sandbox', build: sandbox },
};
