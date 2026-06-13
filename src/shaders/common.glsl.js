// Shared GLSL for the D2Q9 lattice.
//
// Velocity set (lattice units):
//      6  2  5
//       \ | /
//   3 --- 0 --- 1
//       / | \
//      7  4  8
//
// Weights: w0 = 4/9, axis = 1/9, diagonal = 1/36.
// OPP[i] is the direction opposite to i (used for bounce-back).

export const D2Q9 = `
const vec2 E[9] = vec2[9](
  vec2( 0.0,  0.0),
  vec2( 1.0,  0.0), vec2( 0.0,  1.0), vec2(-1.0,  0.0), vec2( 0.0, -1.0),
  vec2( 1.0,  1.0), vec2(-1.0,  1.0), vec2(-1.0, -1.0), vec2( 1.0, -1.0)
);
const ivec2 EI[9] = ivec2[9](
  ivec2( 0,  0),
  ivec2( 1,  0), ivec2( 0,  1), ivec2(-1,  0), ivec2( 0, -1),
  ivec2( 1,  1), ivec2(-1,  1), ivec2(-1, -1), ivec2( 1, -1)
);
const float W[9] = float[9](
  4.0/9.0,
  1.0/9.0, 1.0/9.0, 1.0/9.0, 1.0/9.0,
  1.0/36.0, 1.0/36.0, 1.0/36.0, 1.0/36.0
);
const int OPP[9] = int[9](0, 3, 4, 1, 2, 7, 8, 5, 6);

// Maxwell-Boltzmann equilibrium, expanded to second order in u.
// feq_i = w_i * rho * (1 + 3 e.u + 4.5 (e.u)^2 - 1.5 u.u)
float feq(int i, float rho, vec2 u) {
  float eu = 3.0 * dot(E[i], u);
  return W[i] * rho * (1.0 + eu + 0.5 * eu * eu - 1.5 * dot(u, u));
}
`;

// Manual bilinear sampling via texelFetch — works on float textures without
// requiring OES_texture_float_linear.
export const BILERP = `
vec4 bilerp(sampler2D t, vec2 pos, ivec2 size) {
  vec2 p = pos - 0.5;
  ivec2 i0 = ivec2(floor(p));
  vec2 f = p - vec2(i0);
  ivec2 lo = ivec2(0), hi = size - 1;
  ivec2 i1 = clamp(i0 + ivec2(1, 0), lo, hi);
  ivec2 i2 = clamp(i0 + ivec2(0, 1), lo, hi);
  ivec2 i3 = clamp(i0 + ivec2(1, 1), lo, hi);
  i0 = clamp(i0, lo, hi);
  vec4 a = texelFetch(t, i0, 0), b = texelFetch(t, i1, 0);
  vec4 c = texelFetch(t, i2, 0), d = texelFetch(t, i3, 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;
