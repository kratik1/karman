// 3D obstacle masks. Flat Uint8Array indexed (z*ny + y)*nx + x, SOLID = 255.
// No channel walls: the y/z faces use zero-gradient boundaries so the flow
// slips past them, which keeps the whole volume usable.

export const SOLID = 255;

function empty(nx, ny, nz) {
  return new Uint8Array(nx * ny * nz);
}

function stampBall(m, nx, ny, nz, cx, cy, cz, r) {
  const r2 = r * r;
  for (let z = Math.max(0, cz - r | 0); z <= Math.min(nz - 1, cz + r | 0); z++)
    for (let y = Math.max(0, cy - r | 0); y <= Math.min(ny - 1, cy + r | 0); y++)
      for (let x = Math.max(0, cx - r | 0); x <= Math.min(nx - 1, cx + r | 0); x++) {
        const dx = x - cx, dy = y - cy, dz = z - cz;
        if (dx * dx + dy * dy + dz * dz <= r2) m[(z * ny + y) * nx + x] = SOLID;
      }
}

function sphere(nx, ny, nz) {
  const m = empty(nx, ny, nz);
  stampBall(m, nx, ny, nz, nx * 0.24, ny * 0.5 + 1, nz * 0.5 + 1, ny * 0.19);
  return m;
}

// vertical pole: cylinder along y — sheds a helical 3D wake
function pillar(nx, ny, nz) {
  const m = empty(nx, ny, nz);
  const cx = nx * 0.24, cz = nz * 0.5 + 1, r = ny * 0.11, r2 = r * r;
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz <= r2)
        for (let y = 0; y < ny; y++) m[(z * ny + y) * nx + x] = SOLID;
    }
  return m;
}

function balls(nx, ny, nz) {
  const m = empty(nx, ny, nz);
  const r = ny * 0.10;
  stampBall(m, nx, ny, nz, nx * 0.20, ny * 0.36, nz * 0.36, r);
  stampBall(m, nx, ny, nz, nx * 0.32, ny * 0.62, nz * 0.55, r);
  stampBall(m, nx, ny, nz, nx * 0.44, ny * 0.40, nz * 0.66, r);
  return m;
}

// text rasterized in the x-y plane, extruded a few voxels along z
function textObstacle(nx, ny, nz, opts) {
  const text = (opts && opts.text ? opts.text : 'K').trim() || 'K';
  const m = empty(nx, ny, nz);
  const c = document.createElement('canvas');
  c.width = nx; c.height = ny;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const font = (s) => `900 ${s}px "Arial Black", "Helvetica Neue", sans-serif`;
  let size = ny * 0.6;
  ctx.font = font(size);
  while (ctx.measureText(text).width > nx * 0.5 && size > 6) {
    size *= 0.93;
    ctx.font = font(size);
  }
  ctx.fillStyle = '#fff';
  ctx.fillText(text, nx * 0.38, ny * 0.5);
  const d = ctx.getImageData(0, 0, nx, ny).data;
  const z0 = Math.max(1, Math.round(nz / 2 - nz * 0.08));
  const z1 = Math.min(nz - 2, Math.round(nz / 2 + nz * 0.08));
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++)
      if (d[(y * nx + x) * 4 + 3] > 128)
        for (let z = z0; z <= z1; z++)
          m[(z * ny + (ny - 1 - y)) * nx + x] = SOLID; // canvas y is top-down
  return m;
}

export const PRESETS3D = {
  sphere: { label: 'Sphere', build: sphere },
  pillar: { label: 'Pole', build: pillar },
  balls:  { label: 'Ball cluster', build: balls },
  text:   { label: 'Your text…', build: textObstacle },
  sandbox:{ label: 'Empty sandbox', build: empty },
};
