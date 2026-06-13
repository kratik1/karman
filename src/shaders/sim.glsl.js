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
        f[i] = fetchF(OPP[i], p); // bounce back off the solid neighbor
      } else {
        f[i] = fetchF(i, src);
      }
    }
  }

  float rho; vec2 u;
  moments(f, rho, u);
  if (solid > 0.5) u = vec2(0.0);
  storeF(f, rho, u);
}
`;
