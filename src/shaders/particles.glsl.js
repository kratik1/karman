// Tracer particles: 65k massless points advected by the LBM velocity field,
// splatted additively into a fading trail texture — classic wind-tunnel
// smoke-wire visualization, but live.
//
// Particle state texture (RGBA32F): xy = position (lattice cells),
//                                   z  = remaining lifetime (frames),
//                                   w  = per-particle seed.

import { BILERP } from './common.glsl.js';

export const UPDATE_FS = `#version 300 es
precision highp float;
${BILERP}
uniform sampler2D uParticles;
uniform sampler2D uC;      // (f8, rho, ux, uy)
uniform sampler2D uMask;
uniform ivec2 uSize;       // sim grid size
uniform float uDisp;       // displacement scale = substeps this frame
uniform float uTime;
uniform float uInVel;
out vec4 o;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 p = texelFetch(uParticles, tc, 0);
  vec2 pos = p.xy + bilerp(uC, p.xy, uSize).zw * uDisp;
  float age = p.z - 1.0;

  ivec2 cell = ivec2(clamp(pos, vec2(0.0), vec2(uSize) - 1.0));
  bool dead = age <= 0.0
    || pos.x < 0.0 || pos.x > float(uSize.x) - 1.0
    || pos.y < 1.5 || pos.y > float(uSize.y) - 2.5
    || texelFetch(uMask, cell, 0).r > 0.5;

  if (dead) {
    float h1 = hash(vec2(tc) + uTime);
    float h2 = hash(vec2(tc) * 1.71 + uTime + 31.416);
    float h3 = hash(vec2(tc) * 2.33 - uTime);
    // with wind on, seed at the inlet; in still sandbox, seed everywhere
    pos = uInVel > 0.005
      ? vec2(h1 * 3.0, 2.0 + h2 * (float(uSize.y) - 4.0))
      : vec2(h1 * float(uSize.x), 2.0 + h2 * (float(uSize.y) - 4.0));
    age = 150.0 + h3 * 400.0;
  }
  o = vec4(pos, age, p.w);
}
`;

// Attribute-less point rendering: gl_VertexID indexes the state texture.
export const POINT_VS = `#version 300 es
precision highp float;
uniform sampler2D uParticles;
uniform sampler2D uC;
uniform ivec2 uSize;
out float vSpeed;
void main() {
  ivec2 ts = textureSize(uParticles, 0);
  ivec2 tc = ivec2(gl_VertexID % ts.x, gl_VertexID / ts.x);
  vec4 p = texelFetch(uParticles, tc, 0);
  ivec2 cell = ivec2(clamp(p.xy, vec2(0.0), vec2(uSize) - 1.0));
  vSpeed = length(texelFetch(uC, cell, 0).zw);
  gl_Position = vec4(p.xy / vec2(uSize) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 2.0;
}
`;

export const POINT_FS = `#version 300 es
precision highp float;
uniform float uInVel;
in float vSpeed;
out vec4 o;
void main() {
  float t = clamp(vSpeed / max(uInVel * 2.0, 0.02), 0.0, 1.0);
  // trails accumulate PIGMENT (subtracted from paper at display time):
  // indigo ink in the calm, vermilion where it rips
  vec3 slow = vec3(0.785, 0.715, 0.390);   // paper - indigo
  vec3 fast = vec3(0.085, 0.695, 0.810);   // paper - vermilion
  o = vec4(mix(slow, fast, t) * 0.14, 1.0);
}
`;

// Exponential trail decay — gives the comet-tail persistence.
export const FADE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTrail;
out vec4 o;
void main() {
  o = texelFetch(uTrail, ivec2(gl_FragCoord.xy), 0) * 0.91;
}
`;
