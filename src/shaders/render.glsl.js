// Visualization passes: dye transport + final display compositing.

import { BILERP } from './common.glsl.js';

// Semi-Lagrangian dye advection, driven by the LBM velocity field (stored in
// texC.zw). Dye is purely cosmetic — it rides the flow, it doesn't affect it.
// Streaklines are injected at the inlet; mouse splats add colored dye.
export const ADVECT_FS = `#version 300 es
precision highp float;
${BILERP}
uniform sampler2D uDye;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform ivec2 uSize;
uniform float uDisp;        // displacement scale = substeps this frame
uniform float uInVel;
uniform vec2 uSplatPos;
uniform vec3 uSplatColor;
uniform float uSplatRadius;
in vec2 vUv;
out vec4 o;

vec3 streakPalette(float t) {
  // cool cyan -> electric violet across the channel height
  return mix(vec3(0.25, 0.85, 1.0), vec3(0.75, 0.35, 1.0), t);
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
    vec3 col = streakPalette(pos.y / float(uSize.y));
    d = max(d, vec4(col * line, line));
  }

  if (uSplatRadius > 0.0) {
    vec2 q = (pos - uSplatPos) / uSplatRadius;
    float g = exp(-dot(q, q));
    d.rgb += uSplatColor * g;
    d.a = max(d.a, g);
  }

  if (texelFetch(uMask, p, 0).r > 0.5) d = vec4(0.0);
  o = clamp(d, 0.0, 1.0);
}
`;

// Final composite: pick a field, map it to color, draw obstacles on top.
// Modes: 0 = dye, 1 = vorticity, 2 = speed.
export const DISPLAY_FS = `#version 300 es
precision highp float;
${BILERP}
uniform sampler2D uDye;
uniform sampler2D uC;
uniform sampler2D uMask;
uniform ivec2 uSize;
uniform int uMode;
uniform float uInVel;
in vec2 vUv;
out vec4 o;

vec2 velAt(vec2 pos) { return bilerp(uC, pos, uSize).zw; }

// Polynomial fit of matplotlib's inferno colormap (Matt Zucker).
vec3 inferno(float t) {
  const vec3 c0 = vec3(0.00021894, 0.00165100, -0.01948090);
  const vec3 c1 = vec3(0.10651341, 0.56395643, 3.93271239);
  const vec3 c2 = vec3(11.60249308, -3.97285397, -15.94239411);
  const vec3 c3 = vec3(-41.70399613, 17.43639888, 44.35414520);
  const vec3 c4 = vec3(77.16293570, -33.40235894, -81.80730926);
  const vec3 c5 = vec3(-71.31942824, 32.62606426, 73.20951986);
  const vec3 c6 = vec3(25.13112622, -12.24266895, -23.07032500);
  return clamp(c0+t*(c1+t*(c2+t*(c3+t*(c4+t*(c5+t*c6))))), 0.0, 1.0);
}

void main() {
  vec2 pos = vUv * vec2(uSize);
  vec3 col;

  if (uMode == 0) {
    vec4 d = bilerp(uDye, pos, uSize);
    col = vec3(0.015, 0.02, 0.035) + d.rgb;
  } else if (uMode == 1) {
    // vorticity = dv/dx - du/dy via central differences on the velocity field
    float w = (velAt(pos + vec2(1, 0)).y - velAt(pos - vec2(1, 0)).y
             - velAt(pos + vec2(0, 1)).x + velAt(pos - vec2(0, 1)).x) * 0.5;
    float s = clamp(w * 60.0, -1.0, 1.0);
    float a = pow(abs(s), 0.65);
    vec3 hot  = vec3(1.0, 0.42, 0.08);   // counter-clockwise
    vec3 cold = vec3(0.15, 0.5, 1.0);    // clockwise
    col = vec3(0.02, 0.025, 0.04) + (s > 0.0 ? hot : cold) * a;
  } else {
    float speed = length(velAt(pos));
    col = inferno(clamp(speed / max(uInVel * 2.2, 0.02), 0.0, 1.0));
  }

  // obstacles: smooth-edged slate with a faint rim
  float m = bilerp(uMask, pos, uSize).r;
  vec3 slate = vec3(0.16, 0.18, 0.22);
  float edge = smoothstep(0.05, 0.45, m) - smoothstep(0.45, 0.95, m);
  col = mix(col, slate, smoothstep(0.3, 0.6, m));
  col += vec3(0.10, 0.11, 0.13) * edge;

  o = vec4(pow(col, vec3(0.9)), 1.0); // mild lift for dark displays
}
`;
