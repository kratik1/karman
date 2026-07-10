// The Lattice-Boltzmann simulation passes.
//
// State layout across three RGBA32F textures (MRT):
//   texA = (f0, f1, f2, f3)
//   texB = (f4, f5, f6, f7)
//   texC = (f8, rho, ux, uy)   <- macroscopic moments cached for rendering/advection

import { D2Q9 } from './common.glsl.js';

const HEADER = `#version 300 es
precision highp float;
${D2Q9}
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform ivec2 uSize;
layout(location=0) out vec4 oA;
layout(location=1) out vec4 oB;
layout(location=2) out vec4 oC;
layout(location=3) out vec4 oF;   // momentum-exchange force accumulator (fx,fy,0,0)

void loadF(ivec2 p, out float f[9]) {
  vec4 A = texelFetch(uA, p, 0);
  vec4 B = texelFetch(uB, p, 0);
  f[0]=A.x; f[1]=A.y; f[2]=A.z; f[3]=A.w;
  f[4]=B.x; f[5]=B.y; f[6]=B.z; f[7]=B.w;
  f[8]=texelFetch(uC, p, 0).x;
}

void storeF(float f[9], float rho, vec2 u) {
  oA = vec4(f[0], f[1], f[2], f[3]);
  oB = vec4(f[4], f[5], f[6], f[7]);
  oC = vec4(f[8], rho, u);
  oF = vec4(0.0);   // default: no force; STREAM overwrites at boundary links
}

void moments(float f[9], out float rho, out vec2 u) {
  rho = f[0]+f[1]+f[2]+f[3]+f[4]+f[5]+f[6]+f[7]+f[8];
  u = vec2(f[1] - f[3] + f[5] - f[6] - f[7] + f[8],
           f[2] - f[4] + f[5] + f[6] - f[7] - f[8]) / max(rho, 1e-6);
}
`;

// Fill the domain with equilibrium at rho=1 and a uniform inflow velocity,
// plus a small sinusoidal perturbation to break symmetry (kick-starts vortex
// shedding, which would otherwise take thousands of steps to develop from
// numerical noise alone).
export const INIT_FS = `${HEADER}
uniform float uInVel;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 u = vec2(uInVel, uInVel * 0.08 * sin(float(p.x) * 0.07));
  if (texelFetch(uMask, p, 0).r > 0.5) u = vec2(0.0);
  float f[9];
  for (int i = 0; i < 9; i++) f[i] = feq(i, 1.0, u);
  storeF(f, 1.0, u);
}
`;

// BGK collision: relax every f_i toward local equilibrium with rate 1/tau.
// Mouse "stirring" enters here as a Gaussian velocity nudge before computing
// the equilibrium — equivalent to a localized body force.
export const COLLIDE_FS = `${HEADER}
uniform float uTau;
uniform vec2 uSplatPos;     // in lattice cells
uniform vec2 uSplatVel;     // lattice velocity impulse
uniform float uSplatRadius; // in lattice cells
uniform vec2 uClapPos;      // acoustic pulse center, lattice cells
uniform float uClapAmp;     // pulse strength (0 = inactive)

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float f[9];
  loadF(p, f);

  float rho; vec2 u;
  moments(f, rho, u);

  if (uSplatRadius > 0.0) {
    vec2 d = (vec2(p) + 0.5 - uSplatPos) / uSplatRadius;
    u += uSplatVel * exp(-dot(d, d));
  }

  // "Clap": a localized density (pressure) bump that radiates outward at the
  // lattice sound speed (1/sqrt(3) cells/step) — scale every f_i at the cell.
  if (uClapAmp != 0.0) {
    vec2 dc = (vec2(p) + 0.5 - uClapPos) / 6.0;   // ~6-cell radius
    float bump = uClapAmp * exp(-dot(dc, dc));
    for (int i = 0; i < 9; i++) f[i] *= (1.0 + bump);
    rho = f[0]+f[1]+f[2]+f[3]+f[4]+f[5]+f[6]+f[7]+f[8];
  }

  // Cap |u| well below the lattice speed of sound (1/sqrt(3)) — the
  // low-Mach expansion behind feq breaks down past ~0.3 and blows up.
  float s = length(u);
  if (s > 0.25) u *= 0.25 / s;

  float omega = 1.0 / uTau;
  for (int i = 0; i < 9; i++) {
    f[i] += omega * (feq(i, rho, u) - f[i]);
  }

  storeF(f, rho, u);
}
`;

// Streaming (gather form): f_i(x, t+1) = f*_i(x - e_i, t).
// Boundaries:
//   - solid neighbor      -> half-way bounce-back: f_i(x) = f*_opp(i)(x)
//   - left edge (inlet)   -> equilibrium at rho=1, u=(uInVel, 0)
//   - right edge (outlet) -> zero-gradient (read from clamped coordinate)
//   - top/bottom          -> solid walls baked into the mask
export const STREAM_FS = `${HEADER}
uniform float uInVel;

float fetchF(int i, ivec2 p) {
  if (i < 4) return texelFetch(uA, p, 0)[i];
  if (i < 8) return texelFetch(uB, p, 0)[i - 4];
  return texelFetch(uC, p, 0).x;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float solid = texelFetch(uMask, p, 0).r;

  // Momentum-exchange: each bounced link hands 2*e*f* to the wall. Accumulate
  // it here so a single pass yields the per-cell force contribution.
  vec2 flink = vec2(0.0);

  float f[9];
  for (int i = 0; i < 9; i++) {
    ivec2 src = p - EI[i];
    if (src.x < 0) {
      f[i] = feq(i, 1.0, vec2(uInVel, 0.0));
    } else if (src.x >= uSize.x) {
      f[i] = fetchF(i, ivec2(uSize.x - 1, clamp(src.y, 0, uSize.y - 1)));
    } else {
      src.y = clamp(src.y, 0, uSize.y - 1);
      if (texelFetch(uMask, src, 0).r > 0.5) {
        // solid neighbor sits at p+EI[OPP[i]]; the population leaving p toward
        // it is direction OPP[i]. Force on wall = 2*E[OPP[i]]*f*_OPP[i](p).
        float fout = fetchF(OPP[i], p);
        f[i] = fout;               // bounce back off the solid neighbor
        // exclude the channel wall rows: only the obstacle's force is wanted
        if (src.y > 0 && src.y < uSize.y - 1) flink += 2.0 * E[OPP[i]] * fout;
      } else {
        f[i] = fetchF(i, src);
      }
    }
  }

  float rho; vec2 u;
  moments(f, rho, u);
  if (solid > 0.5) u = vec2(0.0);
  storeF(f, rho, u);
  // Only count links belonging to fluid cells (solid cells inside the body
  // would double-count from the inside). Force is drag(x)/lift(y).
  oF = solid > 0.5 ? vec4(0.0) : vec4(flink, 0.0, 0.0);
}
`;

// Parallel sum reduction: each output texel = sum of a 4x4 block of the input.
// Chained until the remainder is tiny, then finished on the CPU. Reads out of
// bounds return 0 (CLAMP_TO_EDGE would duplicate — so guard with a size test).
export const REDUCE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uSrcSize;
out vec4 o;

void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 4;
  vec4 s = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      ivec2 q = base + ivec2(i, j);
      if (q.x < uSrcSize.x && q.y < uSrcSize.y) s += texelFetch(uSrc, q, 0);
    }
  }
  o = s;
}
`;
