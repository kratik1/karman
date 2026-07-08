// GPU tracer particles + persistent trail texture.

import { Pass, compileProgram, makeTexture, makeFBO, blitTo } from './gl.js';
import { UPDATE_FS, POINT_VS, POINT_FS, FADE_FS } from './shaders/particles.glsl.js';

const DIM = 128; // 128² = 16,384 tracers — sparse enough for distinct streaks

export class Particles {
  constructor(gl, quad, simW, simH) {
    this.gl = gl;
    this.quad = quad;
    this.simW = simW;
    this.simH = simH;
    // trail lives at 2× sim resolution so streaks stay crisp when upscaled
    this.trailW = simW * 2;
    this.trailH = simH * 2;

    this.updatePass = new Pass(gl, UPDATE_FS);
    this.fadePass = new Pass(gl, FADE_FS);

    this.pointProg = compileProgram(gl, POINT_VS, POINT_FS);
    this.pointU = {
      uParticles: gl.getUniformLocation(this.pointProg, 'uParticles'),
      uC: gl.getUniformLocation(this.pointProg, 'uC'),
      uSize: gl.getUniformLocation(this.pointProg, 'uSize'),
      uInVel: gl.getUniformLocation(this.pointProg, 'uInVel'),
    };
    this.pointVao = gl.createVertexArray(); // attribute-less draw via gl_VertexID

    this.state = makeFBO(gl, [makeTexture(gl, DIM, DIM, gl.RGBA32F)]);
    this.state2 = makeFBO(gl, [makeTexture(gl, DIM, DIM, gl.RGBA32F)]);
    this.trail = makeFBO(gl, [makeTexture(gl, this.trailW, this.trailH, gl.RGBA16F)]);
    this.trail2 = makeFBO(gl, [makeTexture(gl, this.trailW, this.trailH, gl.RGBA16F)]);

    this._seed();
  }

  _seed() {
    const gl = this.gl;
    const data = new Float32Array(DIM * DIM * 4);
    for (let i = 0; i < DIM * DIM; i++) {
      data[i * 4 + 0] = Math.random() * this.simW;
      data[i * 4 + 1] = 2 + Math.random() * (this.simH - 4);
      data[i * 4 + 2] = Math.random() * 400; // staggered lifetimes
      data[i * 4 + 3] = Math.random();
    }
    gl.bindTexture(gl.TEXTURE_2D, this.state.textures[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DIM, DIM, gl.RGBA, gl.FLOAT, data);
  }

  // Advect particles, then fade + re-splat the trail.
  step(sim, disp, time) {
    const gl = this.gl;

    const p = this.updatePass.use()
      .tex('uParticles', this.state.textures[0])
      .tex('uC', sim.fieldTex)
      .tex('uMask', sim.maskTex)
      .f('uDisp', disp)
      .f('uTime', time % 1000)
      .f('uInVel', sim.inVel);
    gl.uniform2i(p.uniforms.uSize, this.simW, this.simH);
    blitTo(gl, this.quad, this.state2, DIM, DIM);
    [this.state, this.state2] = [this.state2, this.state];

    // fade previous trail into the other buffer...
    this.fadePass.use().tex('uTrail', this.trail.textures[0]);
    blitTo(gl, this.quad, this.trail2, this.trailW, this.trailH);
    [this.trail, this.trail2] = [this.trail2, this.trail];

    // ...then splat the points on top, additively
    gl.useProgram(this.pointProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.state.textures[0]);
    gl.uniform1i(this.pointU.uParticles, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, sim.fieldTex);
    gl.uniform1i(this.pointU.uC, 1);
    gl.uniform2i(this.pointU.uSize, this.simW, this.simH);
    gl.uniform1f(this.pointU.uInVel, sim.inVel);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trail.fbo);
    gl.viewport(0, 0, this.trailW, this.trailH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.pointVao);
    gl.drawArrays(gl.POINTS, 0, DIM * DIM);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  get trailTex() { return this.trail.textures[0]; }
}
