// GLSL for the 3D solver. The volume is stored as a "flat 3D texture":
// NZ slices of NX×NY tiled into a 2D atlas, so every simulation pass is a
// plain fragment shader over the atlas — no compute shaders needed.
//
// D3Q19 lattice: rest + 6 axis + 12 edge-diagonal velocities.
// Populations pack into five RGBA32F atlases:
//   F0=(f0..f3) F1=(f4..f7) F2=(f8..f11) F3=(f12..f15) F4=(f16,f17,f18,-)
// The stream pass also writes a macro atlas: (ux, uy, uz, rho).

export function makeCommon(NX, NY, NZ, TX, TY) {
  return `
const int NX=${NX}, NY=${NY}, NZ=${NZ}, TX=${TX}, TY=${TY};

const ivec3 E[19] = ivec3[19](
  ivec3(0,0,0),
  ivec3(1,0,0), ivec3(-1,0,0), ivec3(0,1,0), ivec3(0,-1,0), ivec3(0,0,1), ivec3(0,0,-1),
  ivec3(1,1,0), ivec3(-1,-1,0), ivec3(1,-1,0), ivec3(-1,1,0),
  ivec3(1,0,1), ivec3(-1,0,-1), ivec3(1,0,-1), ivec3(-1,0,1),
  ivec3(0,1,1), ivec3(0,-1,-1), ivec3(0,1,-1), ivec3(0,-1,1)
);
const float W[19] = float[19](
  1.0/3.0,
  1.0/18.0, 1.0/18.0, 1.0/18.0, 1.0/18.0, 1.0/18.0, 1.0/18.0,
  1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0,
  1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0,
  1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0
);
const int OPP[19] = int[19](0, 2,1, 4,3, 6,5, 8,7, 10,9, 12,11, 14,13, 16,15, 18,17);
// Specular-reflection index tables for free-slip side walls: MIR_Y[i] is the
// direction whose velocity equals E[i] with e_y negated (e_x,e_z kept), MIR_Z
// mirrors e_z. Used to reflect populations off the y/z walls with no shear.
const int MIR_Y[19] = int[19](0, 1,2, 4,3, 5,6, 9,10,7,8, 11,12,13,14, 18,17,16,15);
const int MIR_Z[19] = int[19](0, 1,2, 3,4, 6,5, 7,8,9,10, 13,14,11,12, 17,18,15,16);

// voxel <-> atlas mapping
ivec2 A(ivec3 p) { return ivec2((p.z % TX) * NX + p.x, (p.z / TX) * NY + p.y); }
ivec3 V(ivec2 a) {
  return ivec3(a.x % NX, a.y % NY, (a.y / NY) * TX + (a.x / NX));
}

float feq(int i, float rho, vec3 u) {
  float eu = 3.0 * dot(vec3(E[i]), u);
  return W[i] * rho * (1.0 + eu + 0.5 * eu * eu - 1.5 * dot(u, u));
}

// trilinear sample of a scalar/vector field stored in an atlas
vec4 tri(sampler2D t, vec3 p) {
  p = clamp(p - 0.5, vec3(0.0), vec3(NX, NY, NZ) - 1.001);
  ivec3 i = ivec3(p);
  vec3 f = p - vec3(i);
  ivec3 j = min(i + 1, ivec3(NX, NY, NZ) - 1);
  vec4 c000 = texelFetch(t, A(ivec3(i.x,i.y,i.z)), 0), c100 = texelFetch(t, A(ivec3(j.x,i.y,i.z)), 0);
  vec4 c010 = texelFetch(t, A(ivec3(i.x,j.y,i.z)), 0), c110 = texelFetch(t, A(ivec3(j.x,j.y,i.z)), 0);
  vec4 c001 = texelFetch(t, A(ivec3(i.x,i.y,j.z)), 0), c101 = texelFetch(t, A(ivec3(j.x,i.y,j.z)), 0);
  vec4 c011 = texelFetch(t, A(ivec3(i.x,j.y,j.z)), 0), c111 = texelFetch(t, A(ivec3(j.x,j.y,j.z)), 0);
  vec4 x00 = mix(c000, c100, f.x), x10 = mix(c010, c110, f.x);
  vec4 x01 = mix(c001, c101, f.x), x11 = mix(c011, c111, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}
`;
}

// Every sim pass renders to the same 6-attachment FBO (5 population atlases
// + macro), and every pass must write ALL outputs — leaving a draw buffer
// unwritten is a draw-time error on some drivers.
const SIM_IO = `
uniform sampler2D uF0; uniform sampler2D uF1; uniform sampler2D uF2;
uniform sampler2D uF3; uniform sampler2D uF4;
uniform sampler2D uMask;
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
layout(location=2) out vec4 o2;
layout(location=3) out vec4 o3;
layout(location=4) out vec4 o4;
layout(location=5) out vec4 oMacro;

void loadF(ivec3 p, out float f[19]) {
  ivec2 a = A(p);
  vec4 A0 = texelFetch(uF0, a, 0), A1 = texelFetch(uF1, a, 0);
  vec4 A2 = texelFetch(uF2, a, 0), A3 = texelFetch(uF3, a, 0);
  vec4 A4 = texelFetch(uF4, a, 0);
  f[0]=A0.x; f[1]=A0.y; f[2]=A0.z; f[3]=A0.w;
  f[4]=A1.x; f[5]=A1.y; f[6]=A1.z; f[7]=A1.w;
  f[8]=A2.x; f[9]=A2.y; f[10]=A2.z; f[11]=A2.w;
  f[12]=A3.x; f[13]=A3.y; f[14]=A3.z; f[15]=A3.w;
  f[16]=A4.x; f[17]=A4.y; f[18]=A4.z;
}

void storeF(float f[19], float rho, vec3 u) {
  o0 = vec4(f[0], f[1], f[2], f[3]);
  o1 = vec4(f[4], f[5], f[6], f[7]);
  o2 = vec4(f[8], f[9], f[10], f[11]);
  o3 = vec4(f[12], f[13], f[14], f[15]);
  o4 = vec4(f[16], f[17], f[18], 0.0);
  oMacro = vec4(u, rho);
}

void moments(float f[19], out float rho, out vec3 u) {
  rho = 0.0;
  u = vec3(0.0);
  for (int i = 0; i < 19; i++) { rho += f[i]; u += f[i] * vec3(E[i]); }
  u /= max(rho, 1e-6);
}
`;

export function initFS(common) {
  return `#version 300 es
precision highp float;
${common}
${SIM_IO}
uniform float uInVel;
void main() {
  ivec3 p = V(ivec2(gl_FragCoord.xy));
  vec3 u = vec3(uInVel, 0.0, 0.0);
  // small transverse perturbation to break symmetry and start shedding early
  u.y += uInVel * 0.10 * sin(float(p.x) * 0.11 + float(p.z) * 0.23);
  u.z += uInVel * 0.10 * cos(float(p.x) * 0.13 + float(p.y) * 0.19);
  if (texelFetch(uMask, A(p), 0).r > 0.5) u = vec3(0.0);
  float f[19];
  for (int i = 0; i < 19; i++) f[i] = feq(i, 1.0, u);
  storeF(f, 1.0, u);
}`;
}

// TRT collision with a Smagorinsky LES eddy viscosity and a sponge outlet.
//
// TRT splits each population pair into symmetric/antisymmetric parts and
// relaxes them at two rates: omega+ (=1/tau_eff) sets the viscosity, omega-
// is fixed by the magic parameter Lambda=1/4 so the wall placement of the
// bounce-back is viscosity-independent. When omega+ == omega- this reduces
// exactly to BGK.
//
// LES: the non-equilibrium momentum flux tensor Pi_ab = sum_i e_ia e_ib
// (f_i - feq_i) gives a local strain-rate magnitude Q = sqrt(2 Pi:Pi). The
// eddy viscosity is folded into tau via the Hou et al. closure:
//   tau_eff = 0.5 (tau0 + sqrt(tau0^2 + 18*sqrt(2)*Csm^2*Q/rho))
// Prefactor convention: nu_t = (Csm*Delta)^2 * S with Delta=1 (one lattice
// unit) and S recovered from Q; the 18*sqrt(2) collects the D3Q19 cs^2=1/3
// factors so nu_t adds directly to nu=(tau-0.5)/3. Csm=0.16.
export function collideFS(common) {
  return `#version 300 es
precision highp float;
${common}
${SIM_IO}
uniform float uTau;
uniform vec3 uSplatPos;
uniform vec3 uSplatVel;
uniform float uSplatRadius;
const float CSM = 0.16;   // Smagorinsky constant
const int SPONGE = 10;    // cells before the outlet where tau is ramped up
void main() {
  ivec3 p = V(ivec2(gl_FragCoord.xy));
  float f[19];
  loadF(p, f);
  float rho; vec3 u;
  moments(f, rho, u);

  if (uSplatRadius > 0.0) {
    vec3 d = (vec3(p) + 0.5 - uSplatPos) / uSplatRadius;
    u += uSplatVel * exp(-dot(d, d));
  }
  float s = length(u);
  if (s > 0.22) u *= 0.22 / s; // stay far below the lattice speed of sound

  // equilibrium and non-equilibrium parts (feq reused for LES + TRT)
  float fe[19];
  for (int i = 0; i < 19; i++) fe[i] = feq(i, rho, u);

  // Smagorinsky: strain magnitude from the non-equilibrium stress tensor.
  // Pi is symmetric, so only 6 unique components are accumulated.
  float Pxx=0.0, Pyy=0.0, Pzz=0.0, Pxy=0.0, Pxz=0.0, Pyz=0.0;
  for (int i = 0; i < 19; i++) {
    float neq = f[i] - fe[i];
    vec3 e = vec3(E[i]);
    Pxx += e.x*e.x*neq; Pyy += e.y*e.y*neq; Pzz += e.z*e.z*neq;
    Pxy += e.x*e.y*neq; Pxz += e.x*e.z*neq; Pyz += e.y*e.z*neq;
  }
  float PiPi = Pxx*Pxx + Pyy*Pyy + Pzz*Pzz + 2.0*(Pxy*Pxy + Pxz*Pxz + Pyz*Pyz);
  float Q = sqrt(2.0 * PiPi);
  float tau0 = uTau;
  float tauEff = 0.5 * (tau0 + sqrt(tau0*tau0 + 18.0*1.41421356*CSM*CSM*Q/max(rho,1e-6)));

  // Sponge zone: smoothly ramp tau up to ~4x in the last SPONGE cells so
  // vortices are damped before hitting the crude outlet copy (no reflection).
  float spEnter = float(NX - SPONGE);
  float sp = smoothstep(spEnter, float(NX - 1), float(p.x));
  tauEff *= 1.0 + 3.0 * sp;
  // small inlet buffer: the imposed equilibrium at x=0 lacks a non-equilibrium
  // part, which rings at tau near 1/2; a touch of extra viscosity damps the
  // ringing before it advects into the domain as vorticity noise
  tauEff *= 1.0 + 2.0 * smoothstep(12.0, 0.0, float(p.x));

  // TRT relaxation rates. Lambda=1/4 magic parameter.
  float omegaP = 1.0 / tauEff;
  float omegaM = 1.0 / (0.5 + 0.25 / (1.0/omegaP - 0.5));

  // Rest population (i=0) is purely symmetric.
  f[0] -= omegaP * (f[0] - fe[0]);
  // Relax each opposite pair once using shared f+/f-. In this E ordering the
  // odd indices 1,3,5,..,17 are exactly one representative per pair
  // (OPP[odd]=odd+1), so step by 2 to visit each pair once.
  for (int i = 1; i < 19; i += 2) {
    int j = OPP[i];
    float fp = 0.5 * (f[i] + f[j]);
    float fm = 0.5 * (f[i] - f[j]);
    float fep = 0.5 * (fe[i] + fe[j]);
    float fem = 0.5 * (fe[i] - fe[j]);
    float relP = omegaP * (fp - fep);
    float relM = omegaM * (fm - fem);
    f[i] -= relP + relM;   // f- and fe- flip sign for the opposite direction
    f[j] -= relP - relM;
  }
  storeF(f, rho, u);
}`;
}

export function streamFS(common) {
  return `#version 300 es
precision highp float;
${common}
${SIM_IO}
uniform float uInVel;
uniform float uTime;   // lattice-step counter (mod 100000) for inlet forcing

float fetchF(int i, ivec3 p) {
  ivec2 a = A(p);
  if (i < 4)  return texelFetch(uF0, a, 0)[i];
  if (i < 8)  return texelFetch(uF1, a, 0)[i - 4];
  if (i < 12) return texelFetch(uF2, a, 0)[i - 8];
  if (i < 16) return texelFetch(uF3, a, 0)[i - 12];
  return texelFetch(uF4, a, 0)[i - 16];
}

void main() {
  ivec3 p = V(ivec2(gl_FragCoord.xy));
  float solid = texelFetch(uMask, A(p), 0).r;

  // Time-varying inlet velocity: a gentle, long-wavelength transverse sway
  // windowed to the core of the inlet. Long wavelengths keep the injected
  // vorticity (~amplitude x wavenumber) low, so the freestream stays clean
  // while the wake still receives enough disturbance to stay turbulent.
  // wake instability so the flow never relaminarizes to a steady state.
  vec3 uIn = vec3(uInVel, 0.0, 0.0);
  vec2 c = (vec2(p.yz) - 0.5 * vec2(float(NY), float(NZ))) / float(NY);
  float win = exp(-dot(c, c) / 0.18);
  uIn.y += uInVel * 0.02 * win * sin(0.013 * uTime + 2.6 * c.y + 4.0 * c.x);
  uIn.z += uInVel * 0.02 * win * cos(0.011 * uTime + 2.2 * c.x - 3.1 * c.y);

  float f[19];
  for (int i = 0; i < 19; i++) {
    ivec3 src = p - E[i];
    if (src.x < 0) {
      f[i] = feq(i, 1.0, uIn);                           // inlet
    } else if (src.x >= NX) {
      src.x = NX - 1;                                    // crude outflow
      src.yz = clamp(src.yz, ivec2(0), ivec2(NY - 1, NZ - 1));
      f[i] = fetchF(i, src);
    } else {
      // Free-slip (specular) side walls: if the streaming source falls
      // outside a y/z wall, mirror the source position back inside and fetch
      // the direction whose normal velocity component is flipped. This adds
      // no shear at the wall, so no spurious boundary layer grows.
      bool outY = src.y < 0 || src.y >= NY;
      bool outZ = src.z < 0 || src.z >= NZ;
      int dir = i;
      if (outY) { src.y = src.y < 0 ? -src.y - 1 : 2*NY - 1 - src.y; dir = MIR_Y[dir]; }
      if (outZ) { src.z = src.z < 0 ? -src.z - 1 : 2*NZ - 1 - src.z; dir = MIR_Z[dir]; }
      if (texelFetch(uMask, A(src), 0).r > 0.5) {
        f[i] = fetchF(OPP[i], p);                        // half-way bounce-back
      } else {
        f[i] = fetchF(dir, src);
      }
    }
  }

  float rho; vec3 u;
  moments(f, rho, u);
  if (solid > 0.5) u = vec3(0.0);
  storeF(f, rho, u);
}`;
}

// Colored smoke, advected semi-Lagrangianly. Injected at the inlet as a
// lattice of round jets so the volume renderer shows distinct filaments.
export function dyeFS(common) {
  return `#version 300 es
precision highp float;
${common}
uniform sampler2D uDye;
uniform sampler2D uMacro;
uniform sampler2D uMask;
uniform float uDisp;
uniform float uInVel;
uniform vec3 uJetA;
uniform vec3 uJetB;
uniform vec3 uSplatPos;
uniform vec3 uSplatColor;
uniform float uSplatRadius;
out vec4 o;

void main() {
  ivec3 p = V(ivec2(gl_FragCoord.xy));
  if (p.z >= NZ) { o = vec4(0.0); return; }
  vec3 pos = vec3(p) + 0.5;

  vec3 vel = tri(uMacro, pos).xyz;
  vec4 d = tri(uDye, pos - vel * uDisp);
  d *= 0.999;

  if (pos.x < 2.5 && uInVel > 0.001) {
    float per = float(NY) / 4.0;
    // jet centers on multiples of per so the middle row hits the obstacle
    vec2 g = mod(pos.yz + per * 0.5, per) - per * 0.5;
    float jet = 1.8 * exp(-dot(g, g) / 6.0);
    // no jets hugging the walls — they just smear along the boundary
    float wallDist = min(min(pos.y, float(NY) - pos.y), min(pos.z, float(NZ) - pos.z));
    jet *= smoothstep(2.0, 6.0, wallDist);
    vec2 cell = floor((pos.yz + per * 0.5) / per);
    float t = fract(cell.x * 0.37 + cell.y * 0.61);
    vec3 col = mix(uJetA, uJetB, t);
    d = max(d, vec4(col * jet, jet));
  }

  if (uSplatRadius > 0.0) {
    vec3 q = (pos - uSplatPos) / uSplatRadius;
    float g = exp(-dot(q, q));
    d.rgb += uSplatColor * g;
    d.a = max(d.a, g);
  }

  if (texelFetch(uMask, A(p), 0).r > 0.5) d = vec4(0.0);
  o = clamp(d, 0.0, 2.0);
}`;
}

// Per-frame derived fields: R = |curl u| (vorticity magnitude), G = |u|.
export function fieldsFS(common) {
  return `#version 300 es
precision highp float;
${common}
uniform sampler2D uMacro;
out vec4 o;

vec3 velAt(ivec3 p) {
  p = clamp(p, ivec3(0), ivec3(NX - 1, NY - 1, NZ - 1));
  return texelFetch(uMacro, A(p), 0).xyz;
}

void main() {
  ivec3 p = V(ivec2(gl_FragCoord.xy));
  if (p.z >= NZ) { o = vec4(0.0); return; }
  // the first cells at the inlet carry imposed-equilibrium ringing; keep them
  // out of the displayed fields
  if (p.x < 12) { o = vec4(0.0, length(velAt(p)), 0.0, 0.0); return; }
  vec3 dx = velAt(p + ivec3(1,0,0)) - velAt(p - ivec3(1,0,0));
  vec3 dy = velAt(p + ivec3(0,1,0)) - velAt(p - ivec3(0,1,0));
  vec3 dz = velAt(p + ivec3(0,0,1)) - velAt(p - ivec3(0,0,1));
  vec3 curl = 0.5 * vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);
  o = vec4(length(curl), length(velAt(p)), 0.0, 0.0);
}`;
}

// 3D tracer particles: xyz = position (voxels), w = remaining life.
export function particleUpdateFS(common) {
  return `#version 300 es
precision highp float;
${common}
uniform sampler2D uParticles;
uniform sampler2D uMacro;
uniform sampler2D uMask;
uniform float uDisp;
uniform float uTime;
uniform float uInVel;
out vec4 o;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 p = texelFetch(uParticles, tc, 0);
  vec3 pos = p.xyz + tri(uMacro, p.xyz).xyz * uDisp;
  float age = p.w - 1.0;

  ivec3 cell = ivec3(clamp(pos, vec3(0.0), vec3(NX, NY, NZ) - 1.0));
  bool dead = age <= 0.0
    || pos.x < 0.0 || pos.x > float(NX) - 1.0
    || pos.y < 1.5 || pos.y > float(NY) - 2.5
    || pos.z < 1.5 || pos.z > float(NZ) - 2.5
    || texelFetch(uMask, A(cell), 0).r > 0.5;

  if (dead) {
    float h1 = hash(vec2(tc) + uTime);
    float h2 = hash(vec2(tc) * 1.71 + uTime + 31.4);
    float h3 = hash(vec2(tc) * 2.33 - uTime);
    float h4 = hash(vec2(tc) * 3.07 + uTime * 1.7);
    pos = uInVel > 0.005
      ? vec3(h1 * 3.0, 2.0 + h2 * (float(NY) - 4.0), 2.0 + h3 * (float(NZ) - 4.0))
      : vec3(h1 * float(NX), 2.0 + h2 * (float(NY) - 4.0), 2.0 + h3 * (float(NZ) - 4.0));
    age = 200.0 + h4 * 500.0;
  }
  o = vec4(pos, age);
}`;
}

// Streaklet rendering: each particle draws a short line from pos to
// pos - vel*k, pulled from textures via gl_VertexID. No vertex buffers.
export function streakVS(common) {
  return `#version 300 es
precision highp float;
${common}
uniform sampler2D uParticles;
uniform sampler2D uMacro;
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uVoxel;   // world size of one voxel
uniform vec3 uOrigin;   // world-space corner of the box
out float vSpeed;
out float vDist;

void main() {
  int pid = gl_VertexID / 2;
  int end = gl_VertexID % 2;
  ivec2 ts = textureSize(uParticles, 0);
  ivec2 tc = ivec2(pid % ts.x, pid / ts.x);
  vec4 p = texelFetch(uParticles, tc, 0);
  vec3 vel = tri(uMacro, p.xyz).xyz;
  vSpeed = length(vel);
  vec3 vox = p.xyz - vel * (float(end) * 15.0);
  vec3 world = uOrigin + vox * uVoxel;
  vDist = distance(world, uEye);
  gl_Position = uVP * vec4(world, 1.0);
}`;
}

export const STREAK_FS = `#version 300 es
precision highp float;
uniform float uInVel;
uniform sampler2D uDepth;   // volume pass output; alpha = dist to first solid
uniform vec2 uViewport;
uniform vec3 uSlow;
uniform vec3 uFast;
in float vSpeed;
in float vDist;
out vec4 o;
void main() {
  float solidT = texture(uDepth, gl_FragCoord.xy / uViewport).a;
  if (vDist > solidT + 0.02) discard;  // occluded by an obstacle
  float t = clamp(vSpeed / max(uInVel * 2.0, 0.02), 0.0, 1.0);
  o = vec4(mix(uSlow, uFast, t) * (0.08 + 0.5 * t), 1.0);
}`;
