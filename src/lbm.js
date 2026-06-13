// Simulation state + per-frame orchestration of the LBM passes.

import { Pass, makeTexture, makeFBO, blitTo } from './gl.js';
import { INIT_FS, COLLIDE_FS, STREAM_FS } from './shaders/sim.glsl.js';

export class LBM {
  constructor(gl, quad, width, height) {
    this.gl = gl;
    this.quad = quad;
    this.w = width;
    this.h = height;

    this.initPass = new Pass(gl, INIT_FS);
    this.collidePass = new Pass(gl, COLLIDE_FS);
    this.streamPass = new Pass(gl, STREAM_FS);

    // Two MRT targets; `state` holds streamed f's, `scratch` holds
    // post-collision f's. Each is 3x RGBA32F (see sim.glsl.js for layout).
    this.state = this._makeTarget();
    this.scratch = this._makeTarget();

    // Obstacle mask lives CPU-side (easy painting) and mirrors to a texture.
    this.mask = new Uint8Array(width * height);
    this.maskTex = makeTexture(gl, width, height, gl.R8);

    // physics parameters (lattice units)
    this.tau = 0.53;     // relaxation time; nu = (tau - 0.5) / 3
    this.inVel = 0.1;    // inlet velocity; keep < ~0.15 for stability

    this.splat = null;   // {x, y, vx, vy, radius} pending mouse impulse
  }

  _makeTarget() {
    const gl = this.gl;
    return makeFBO(gl, [
      makeTexture(gl, this.w, this.h, gl.RGBA32F),
      makeTexture(gl, this.w, this.h, gl.RGBA32F),
      makeTexture(gl, this.w, this.h, gl.RGBA32F),
    ]);
  }

  get nu() { return (this.tau - 0.5) / 3; }

  uploadMask() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RED, gl.UNSIGNED_BYTE, this.mask);
  }

  // Reset the fluid to uniform inflow equilibrium (keeps the obstacle mask).
  reset() {
    const p = this.initPass.use()
      .tex('uMask', this.maskTex)
      .f('uInVel', this.inVel);
    this.gl.uniform2i(p.uniforms.uSize, this.w, this.h);
    blitTo(this.gl, this.quad, this.state, this.w, this.h);
  }

  // One LBM timestep = collide (local) + stream (gather from neighbors).
  step(splat) {
    const gl = this.gl;
    const [A, B, C] = this.state.textures;

    const cp = this.collidePass.use()
      .tex('uA', A).tex('uB', B).tex('uC', C).tex('uMask', this.maskTex)
      .f('uTau', this.tau);
    gl.uniform2i(cp.uniforms.uSize, this.w, this.h);
    if (splat) {
      cp.f2('uSplatPos', splat.x, splat.y)
        .f2('uSplatVel', splat.vx, splat.vy)
        .f('uSplatRadius', splat.radius);
    } else {
      cp.f('uSplatRadius', 0);
    }
    blitTo(gl, this.quad, this.scratch, this.w, this.h);

    const [A2, B2, C2] = this.scratch.textures;
    const sp = this.streamPass.use()
      .tex('uA', A2).tex('uB', B2).tex('uC', C2).tex('uMask', this.maskTex)
      .f('uInVel', this.inVel);
    gl.uniform2i(sp.uniforms.uSize, this.w, this.h);
    blitTo(gl, this.quad, this.state, this.w, this.h);
  }

  // Run `n` substeps; the pending mouse splat is applied each substep at
  // reduced strength so total impulse is independent of substep count.
  advance(n) {
    let splat = this.splat;
    if (splat) splat = { ...splat, vx: splat.vx / n, vy: splat.vy / n };
    for (let i = 0; i < n; i++) this.step(splat);
    this.splat = null;
  }

  // texture holding (f8, rho, ux, uy) — renderers read velocity from .zw
  get fieldTex() { return this.state.textures[2]; }
}
