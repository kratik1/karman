// Simulation state + per-frame orchestration of the LBM passes.

import { Pass, makeTexture, makeFBO, blitTo } from './gl.js';
import { INIT_FS, COLLIDE_FS, STREAM_FS, REDUCE_FS } from './shaders/sim.glsl.js';

export class LBM {
  constructor(gl, quad, width, height) {
    this.gl = gl;
    this.quad = quad;
    this.w = width;
    this.h = height;

    this.initPass = new Pass(gl, INIT_FS);
    this.collidePass = new Pass(gl, COLLIDE_FS);
    this.streamPass = new Pass(gl, STREAM_FS);
    this.reducePass = new Pass(gl, REDUCE_FS);

    // Two MRT targets; `state` holds streamed f's, `scratch` holds
    // post-collision f's. Each is 4x RGBA32F: 3 for state (see sim.glsl.js
    // layout) + 1 for the per-cell momentum-exchange force.
    this.state = this._makeTarget();
    this.scratch = this._makeTarget();

    // Force-reduction ping-pong chain (÷4 per pass down to <=8 texels/axis).
    this._buildReduction();

    // Latest force + smoothed/history for HUD and audio.
    this.force = { fx: 0, fy: 0 };
    this.forceAvg = { fx: 0, fy: 0 };
    this.liftHistory = new Float32Array(512);
    this._liftIdx = 0;
    this.onLiftSample = null;   // hook: called with each new instantaneous Fy

    // Obstacle mask lives CPU-side (easy painting) and mirrors to a texture.
    this.mask = new Uint8Array(width * height);
    this.maskTex = makeTexture(gl, width, height, gl.R8);

    // physics parameters (lattice units)
    this.tau = 0.53;     // relaxation time; nu = (tau - 0.5) / 3
    this.inVel = 0.1;    // inlet velocity; keep < ~0.15 for stability

    this.splat = null;   // {x, y, vx, vy, radius} pending mouse impulse
    this.clap = null;    // {x, y} pending acoustic pulse (one substep)
  }

  _makeTarget() {
    const gl = this.gl;
    return makeFBO(gl, [
      makeTexture(gl, this.w, this.h, gl.RGBA32F),
      makeTexture(gl, this.w, this.h, gl.RGBA32F),
      makeTexture(gl, this.w, this.h, gl.RGBA32F),
      makeTexture(gl, this.w, this.h, gl.RGBA32F), // per-cell force (fx,fy,0,0)
    ]);
  }

  // Chain of shrinking single-attachment RGBA32F targets, each 1/4 the size of
  // the previous per axis, down to <=8 texels on the larger axis. The GPU sums
  // the force field down to a handful of texels; JS finishes the last add.
  _buildReduction() {
    const gl = this.gl;
    this.reduceLevels = [];
    let w = this.w, h = this.h;
    while (w > 8 || h > 8) {
      w = Math.ceil(w / 4);
      h = Math.ceil(h / 4);
      this.reduceLevels.push({
        w, h,
        target: makeFBO(gl, [makeTexture(gl, w, h, gl.RGBA32F)]),
      });
    }
    // Read framebuffer for the final tiny level.
    this._readFbo = gl.createFramebuffer();
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
  step(splat, clap) {
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
    if (clap) {
      cp.f2('uClapPos', clap.x, clap.y).f('uClapAmp', 0.15);
    } else {
      cp.f('uClapAmp', 0);
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
    const clap = this.clap; // fires on the first substep only
    for (let i = 0; i < n; i++) this.step(splat, i === 0 ? clap : null);
    this.splat = null;
    this.clap = null;
  }

  // Reduce the per-cell force texture to a single (Fx, Fy) and update the
  // running average + lift history. Call once per animation frame (not per
  // substep) after advance(); a handful of tiny passes plus one small readback.
  sampleForce() {
    const gl = this.gl;
    let srcTex = this.state.textures[3];
    let srcW = this.w, srcH = this.h;

    for (const lvl of this.reduceLevels) {
      const rp = this.reducePass.use().tex('uSrc', srcTex);
      gl.uniform2i(rp.uniforms.uSrcSize, srcW, srcH);
      blitTo(gl, this.quad, lvl.target, lvl.w, lvl.h);
      srcTex = lvl.target.textures[0];
      srcW = lvl.w; srcH = lvl.h;
    }

    // Read the remaining <=8x8 texels and sum on the CPU.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._readFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, srcTex, 0);
    const n = srcW * srcH;
    const buf = new Float32Array(n * 4);
    gl.readPixels(0, 0, srcW, srcH, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    let fx = 0, fy = 0;
    for (let i = 0; i < n; i++) { fx += buf[i * 4]; fy += buf[i * 4 + 1]; }
    this.force.fx = fx; this.force.fy = fy;

    // Exponential moving average for a steady HUD reading.
    const a = 0.02;
    this.forceAvg.fx += a * (fx - this.forceAvg.fx);
    this.forceAvg.fy += a * (fy - this.forceAvg.fy);

    // Ring buffer of instantaneous lift (Fy) — the audio needs the oscillation.
    this.liftHistory[this._liftIdx] = fy;
    this._liftIdx = (this._liftIdx + 1) % this.liftHistory.length;
    if (this.onLiftSample) this.onLiftSample(fy);
  }

  // texture holding (f8, rho, ux, uy) — renderers read velocity from .zw
  get fieldTex() { return this.state.textures[2]; }
}
