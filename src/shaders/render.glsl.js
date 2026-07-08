// Visualization passes: dye transport + final display compositing.
//
// Ivory theme: everything renders as ink on paper. Dye, trails, and field
// colormaps are stored as PIGMENT (absorption per channel), and the display
// shader subtracts pigment from the paper color — the digital equivalent of
// a wash drawing in a fluid dynamics textbook.

import { BILERP } from './common.glsl.js';

export const PALETTE = `
const vec3 PAPER  = vec3(0.945, 0.935, 0.910);
const vec3 INK    = vec3(0.145, 0.155, 0.205);  // obstacle fill
const vec3 INDIGO = vec3(0.16, 0.22, 0.52);
const vec3 VERMIL = vec3(0.86, 0.24, 0.10);
// pigment = PAPER - target color; subtracting it reproduces the target
const vec3 PIG_INDIGO = PAPER - INDIGO;
const vec3 PIG_VERMIL = PAPER - VERMIL;
`;

// Semi-Lagrangian dye advection, driven by the LBM velocity field (stored in
// texC.zw). Dye rides the flow; it doesn't affect it. Inlet streaklines are
// injected as pigment ranging indigo -> vermilion across the channel height.
export const ADVECT_FS = `#version 300 es
precision highp float;
${BILERP}
${PALETTE}
uniform sampler2D uDye;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform ivec2 uSize;
uniform float uDisp;        // displacement scale = substeps this frame
uniform float uInVel;
uniform vec2 uSplatPos;
uniform vec3 uSplatColor;   // pigment, not light
uniform float uSplatRadius;
in vec2 vUv;
out vec4 o;

vec3 streakPigment(float t) {
  return mix(PIG_INDIGO, PIG_VERMIL, t);
}

void main() {
  vec2 pos = gl_FragCoord.xy;
  ivec2 p = ivec2(pos);

  vec2 vel = bilerp(uC, pos, uSize).zw;
  vec4 d = bilerp(uDye, pos - vel * uDisp, uSize);
  d *= 0.9985; // slow fade so the wake stays readable

  // inlet streaklines
  if (pos.x < 3.0 && uInVel > 0.001) {
    float per = 14.0;
    float line = smoothstep(0.35, 0.0, abs(mod(pos.y, per) - per * 0.5) - 1.0);
    vec3 pig = streakPigment(pos.y / float(uSize.y));
    d = max(d, vec4(pig * line, line));
  }

  if (uSplatRadius > 0.0) {
    vec2 q = (pos - uSplatPos) / uSplatRadius;
    float g = exp(-dot(q, q));
    d.rgb += uSplatColor * g;
    d.a = max(d.a, g);
  }

  if (texelFetch(uMask, p, 0).r > 0.5) d = vec4(0.0);
  o = clamp(d, 0.0, 1.0);
}`;

// Final composite: pick a field, lay its pigment on the paper, draw
// obstacles on top. Modes: 0 = dye, 1 = vorticity, 2 = speed, 3 = tracers.
export const DISPLAY_FS = `#version 300 es
precision highp float;
${BILERP}
${PALETTE}
uniform sampler2D uDye;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform sampler2D uTrail;
uniform ivec2 uSize;
uniform int uMode;
uniform float uInVel;
in vec2 vUv;
out vec4 o;

vec2 velAt(vec2 pos) { return bilerp(uC, pos, uSize).zw; }

void main() {
  vec2 pos = vUv * vec2(uSize);
  vec3 col;

  if (uMode == 0) {
    vec4 d = bilerp(uDye, pos, uSize);
    col = PAPER - d.rgb;
  } else if (uMode == 1) {
    // vorticity = dv/dx - du/dy via central differences on the velocity field
    float w = (velAt(pos + vec2(1, 0)).y - velAt(pos - vec2(1, 0)).y
             - velAt(pos + vec2(0, 1)).x + velAt(pos - vec2(0, 1)).x) * 0.5;
    float s = clamp(w * 60.0, -1.0, 1.0);
    float a = pow(abs(s), 0.65);
    col = PAPER - (s > 0.0 ? PIG_VERMIL : PIG_INDIGO) * a * 0.95;
    col = mix(col, vec3(0.06, 0.06, 0.09), pow(abs(s), 6.0) * 0.45); // ink-black cores
  } else if (uMode == 2) {
    float t = clamp(length(velAt(pos)) / max(uInVel * 2.2, 0.02), 0.0, 1.0);
    col = mix(PAPER, mix(INDIGO, VERMIL, t), pow(t, 0.8));
  } else {
    // tracer trails as accumulated pigment; soft tone-map stops pooling
    vec3 tr = 1.0 - exp(-bilerp(uTrail, pos * 2.0, uSize * 2).rgb * 1.6);
    float sp = clamp(length(velAt(pos)) / max(uInVel * 2.2, 0.02), 0.0, 1.0);
    col = PAPER - tr - mix(PIG_INDIGO, PIG_VERMIL, sp) * sp * sp * 0.05;
  }

  // obstacles: solid ink with a soft edge
  float m = bilerp(uMask, pos, uSize).r;
  float edge = smoothstep(0.05, 0.45, m) - smoothstep(0.45, 0.95, m);
  col = mix(col, INK, smoothstep(0.3, 0.6, m));
  col -= vec3(0.05, 0.05, 0.04) * edge; // faint contour line

  // gentle page shading toward the corners
  float vig = smoothstep(1.30, 0.45, length(vUv - 0.5) * 1.55);
  col *= mix(0.94, 1.0, vig);

  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
