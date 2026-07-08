// Volume raymarcher. Renders at half resolution into an FBO whose alpha
// channel carries the distance to the first solid hit (used to occlude the
// tracer streaks drawn on top).
//
// Modes: 0 = smoke (colored dye), 1 = vorticity |curl|, 2 = speed |u|,
//        3 = tracers (near-empty volume, obstacles + faint speed haze only).

export function raymarchFS(common) {
  return `#version 300 es
precision highp float;
${common}
uniform sampler2D uDye;
uniform sampler2D uFields;  // R=|curl|, G=|u|
uniform sampler2D uMask;
uniform vec3 uEye;
uniform vec3 uFwd;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uTanFov;
uniform float uAspect;
uniform int uMode;
uniform float uInVel;
uniform vec3 uOrigin;   // world corner of the volume box
uniform float uVoxel;   // world size of one voxel
uniform vec3 uBg0;      // background gradient bottom
uniform vec3 uBg1;      // background gradient top
uniform vec3 uCold;     // colormap endpoints
uniform vec3 uHot;
in vec2 vUv;
out vec4 outColor;

const int STEPS = 80;

vec2 boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 t1 = (bmin - ro) / rd, t2 = (bmax - ro) / rd;
  vec3 tmin = min(t1, t2), tmax = max(t1, t2);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

float maskAt(vec3 vox) { return tri(uMask, vox).r; }

vec3 maskNormal(vec3 vox) {
  float e = 1.2;
  return normalize(vec3(
    maskAt(vox + vec3(e,0,0)) - maskAt(vox - vec3(e,0,0)),
    maskAt(vox + vec3(0,e,0)) - maskAt(vox - vec3(0,e,0)),
    maskAt(vox + vec3(0,0,e)) - maskAt(vox - vec3(0,0,e))));
}

float hash12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uFwd + ndc.x * uAspect * uTanFov * uRight + ndc.y * uTanFov * uUp);
  vec3 ro = uEye;

  // background: soft vertical gradient
  vec3 bg = mix(uBg0, uBg1, clamp(rd.y * 0.5 + 0.55, 0.0, 1.0));

  vec3 bmin = uOrigin;
  vec3 bmax = uOrigin + vec3(NX, NY, NZ) * uVoxel;
  vec2 hit = boxHit(ro, rd, bmin, bmax);
  float t0 = max(hit.x, 0.0), t1 = hit.y;

  if (t1 <= t0) { outColor = vec4(bg, 6.0e4); return; }

  float ds = (t1 - t0) / float(STEPS);
  // dithered start hides banding
  float t = t0 + ds * hash12(gl_FragCoord.xy);

  vec3 acc = vec3(0.0);
  float T = 1.0;            // transmittance
  float solidT = 6.0e4;     // distance to first solid hit (half-float safe)
  vec3 lightDir = normalize(vec3(-0.45, 0.8, 0.35));

  for (int i = 0; i < STEPS; i++) {
    if (T < 0.01) break;
    vec3 w = ro + rd * t;
    vec3 vox = (w - uOrigin) / uVoxel;

    float m = maskAt(vox);
    if (m > 0.5) {
      // opaque obstacle: shade and stop
      vec3 n = maskNormal(vox);
      float dif = max(dot(n, lightDir), 0.0);
      float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
      vec3 srf = vec3(0.10, 0.11, 0.13) + vec3(0.25, 0.27, 0.30) * dif + vec3(0.20) * rim;
      acc += T * srf;
      T = 0.0;
      solidT = t;
      break;
    }

    if (uMode == 0) {
      vec4 d = tri(uDye, vox);
      float dens = d.a * 3.0;
      acc += T * d.rgb * dens * ds * 3.4;
      T *= exp(-dens * ds * 0.7);
    } else if (uMode == 1) {
      float wv = tri(uFields, vox).r;
      float s = clamp(wv * 34.0, 0.0, 1.0);
      float dens = s * s * s * 5.0;
      vec3 col = mix(uCold, uHot, s);
      acc += T * col * dens * ds * 1.7;
      T *= exp(-dens * ds * 0.65);
    } else if (uMode == 2) {
      float sp = tri(uFields, vox).g;
      float s = clamp(sp / max(uInVel * 2.0, 0.02), 0.0, 1.0);
      float dens = s * s * 4.5;
      vec3 col = mix(uCold, uHot, s);
      acc += T * col * dens * ds * 1.9;
      T *= exp(-dens * ds * 0.6);
    } else {
      float sp = tri(uFields, vox).g;
      float s = clamp(sp / max(uInVel * 2.0, 0.02), 0.0, 1.0);
      acc += T * mix(uCold, uHot, s) * s * s * ds * 0.06; // faint haze under the streaks
      T *= exp(-s * ds * 0.03);
    }
    t += ds;
  }

  outColor = vec4(acc + T * bg, solidT);
}`;
}

// Upscale the half-res volume render to the canvas. Manual bilinear —
// float-texture linear filtering isn't guaranteed everywhere.
export const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uVolume;
in vec2 vUv;
out vec4 o;
void main() {
  ivec2 size = textureSize(uVolume, 0);
  vec2 p = vUv * vec2(size) - 0.5;
  ivec2 i0 = ivec2(floor(p));
  vec2 f = p - vec2(i0);
  ivec2 hi = size - 1;
  vec3 a = texelFetch(uVolume, clamp(i0, ivec2(0), hi), 0).rgb;
  vec3 b = texelFetch(uVolume, clamp(i0 + ivec2(1, 0), ivec2(0), hi), 0).rgb;
  vec3 c2 = texelFetch(uVolume, clamp(i0 + ivec2(0, 1), ivec2(0), hi), 0).rgb;
  vec3 d = texelFetch(uVolume, clamp(i0 + ivec2(1, 1), ivec2(0), hi), 0).rgb;
  vec3 c = mix(mix(a, b, f.x), mix(c2, d, f.x), f.y);
  float vig = smoothstep(1.35, 0.5, length(vUv - 0.5) * 1.5);
  c *= mix(0.85, 1.0, vig);
  o = vec4(pow(c, vec3(0.9)), 1.0);
}`;

// Wireframe box edges for spatial orientation.
export const WIRE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
uniform mat4 uVP;
uniform vec3 uOrigin;
uniform vec3 uSize;
void main() {
  gl_Position = uVP * vec4(uOrigin + aPos * uSize, 1.0);
}`;

export const WIRE_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 o;
void main() { o = vec4(uColor, 1.0); }`;
