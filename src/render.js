// Dye transport + final on-screen compositing.

import { Pass, makeTexture, makeFBO, blitTo } from './gl.js';
import { ADVECT_FS, DISPLAY_FS } from './shaders/render.glsl.js';

export const MODES = { DYE: 0, VORTICITY: 1, SPEED: 2 };

export class Renderer {
  constructor(gl, quad, width, height) {
    this.gl = gl;
    this.quad = quad;
    this.w = width;
    this.h = height;

    this.advectPass = new Pass(gl, ADVECT_FS);
    this.displayPass = new Pass(gl, DISPLAY_FS);

    this.dye = makeFBO(gl, [makeTexture(gl, width, height, gl.RGBA16F)]);
    this.dye2 = makeFBO(gl, [makeTexture(gl, width, height, gl.RGBA16F)]);

    this.mode = MODES.DYE;
    this.dyeSplat = null; // {x, y, color:[r,g,b], radius}
  }

  clearDye() {
    const gl = this.gl;
    for (const t of [this.dye, this.dye2]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  advect(sim, substeps) {
    const gl = this.gl;
    const p = this.advectPass.use()
      .tex('uDye', this.dye.textures[0])
      .tex('uC', sim.fieldTex)
      .tex('uMask', sim.maskTex)
      .f('uDisp', substeps)
      .f('uInVel', sim.inVel);
    gl.uniform2i(p.uniforms.uSize, this.w, this.h);
    const s = this.dyeSplat;
    if (s) {
      p.f2('uSplatPos', s.x, s.y)
        .f3('uSplatColor', s.color[0], s.color[1], s.color[2])
        .f('uSplatRadius', s.radius);
    } else {
      p.f('uSplatRadius', 0);
    }
    blitTo(gl, this.quad, this.dye2, this.w, this.h);
    [this.dye, this.dye2] = [this.dye2, this.dye];
    this.dyeSplat = null;
  }

  draw(sim, canvasW, canvasH) {
    const gl = this.gl;
    const p = this.displayPass.use()
      .tex('uDye', this.dye.textures[0])
      .tex('uC', sim.fieldTex)
      .tex('uMask', sim.maskTex)
      .i('uMode', this.mode)
      .f('uInVel', sim.inVel);
    gl.uniform2i(p.uniforms.uSize, this.w, this.h);
    blitTo(gl, this.quad, null, canvasW, canvasH);
  }
}
