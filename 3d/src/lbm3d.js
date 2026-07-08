// D3Q19 simulation state + pass orchestration over flat-3D atlases.

import { Pass, makeTexture, makeFBO, blitTo } from '../../src/gl.js';
import { makeCommon, initFS, collideFS, streamFS, dyeFS, fieldsFS } from './shaders3d.js';

export class LBM3D {
  constructor(gl, quad, nx, ny, nz) {
    this.gl = gl;
    this.quad = quad;
    this.nx = nx; this.ny = ny; this.nz = nz;
    this.tx = Math.ceil(Math.sqrt(nz));
    this.ty = Math.ceil(nz / this.tx);
    this.aw = nx * this.tx;   // atlas dimensions
    this.ah = ny * this.ty;

    this.common = makeCommon(nx, ny, nz, this.tx, this.ty);

    this.initPass = new Pass(gl, initFS(this.common));
    this.collidePass = new Pass(gl, collideFS(this.common));
    this.streamPass = new Pass(gl, streamFS(this.common));
    this.dyePass = new Pass(gl, dyeFS(this.common));
    this.fieldsPass = new Pass(gl, fieldsFS(this.common));

    const mk32 = () => makeTexture(gl, this.aw, this.ah, gl.RGBA32F);
    // five population atlases + macro, double buffered; macro is shared
    this.macro = mk32();
    this.state = makeFBO(gl, [mk32(), mk32(), mk32(), mk32(), mk32(), this.macro]);
    this.scratch = makeFBO(gl, [mk32(), mk32(), mk32(), mk32(), mk32(), this.macro]);

    this.dye = makeFBO(gl, [makeTexture(gl, this.aw, this.ah, gl.RGBA16F)]);
    this.dye2 = makeFBO(gl, [makeTexture(gl, this.aw, this.ah, gl.RGBA16F)]);
    this.fields = makeFBO(gl, [makeTexture(gl, this.aw, this.ah, gl.RGBA16F)]);

    this.mask = new Uint8Array(nx * ny * nz);
    this.maskTex = makeTexture(gl, this.aw, this.ah, gl.R8);

    this.tau = 0.512;   // low viscosity: Re past the sphere-wake instability
    this.inVel = 0.08;
    this.jetA = [0.25, 0.85, 1.0];   // inlet jet palette (theme-controlled)
    this.jetB = [0.85, 0.40, 1.0];
    this.splat = null;      // {x,y,z, vx,vy,vz, radius}
    this.dyeSplat = null;   // {x,y,z, color:[r,g,b], radius}
  }

  cells() { return this.nx * this.ny * this.nz; }
  get nu() { return (this.tau - 0.5) / 3; }

  // mirror the CPU mask into the atlas texture
  uploadMask() {
    const { gl, nx, ny, nz, tx } = this;
    const atlas = new Uint8Array(this.aw * this.ah);
    for (let z = 0; z < nz; z++) {
      const ox = (z % tx) * nx, oy = Math.floor(z / tx) * ny;
      for (let y = 0; y < ny; y++) {
        atlas.set(this.mask.subarray((z * ny + y) * nx, (z * ny + y) * nx + nx), (oy + y) * this.aw + ox);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.aw, this.ah, gl.RED, gl.UNSIGNED_BYTE, atlas);
  }

  reset() {
    const gl = this.gl;
    this.initPass.use().tex('uMask', this.maskTex).f('uInVel', this.inVel);
    blitTo(gl, this.quad, this.state, this.aw, this.ah);
    for (const t of [this.dye, this.dye2]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _bindF(pass, textures) {
    pass.tex('uF0', textures[0]).tex('uF1', textures[1]).tex('uF2', textures[2])
        .tex('uF3', textures[3]).tex('uF4', textures[4]).tex('uMask', this.maskTex);
    return pass;
  }

  step(splat) {
    const gl = this.gl;

    const cp = this._bindF(this.collidePass.use(), this.state.textures).f('uTau', this.tau);
    if (splat) {
      cp.f3('uSplatPos', splat.x, splat.y, splat.z)
        .f3('uSplatVel', splat.vx, splat.vy, splat.vz)
        .f('uSplatRadius', splat.radius);
    } else {
      cp.f('uSplatRadius', 0);
    }
    blitTo(gl, this.quad, this.scratch, this.aw, this.ah);

    this._bindF(this.streamPass.use(), this.scratch.textures).f('uInVel', this.inVel);
    blitTo(gl, this.quad, this.state, this.aw, this.ah);
  }

  advance(n) {
    let splat = this.splat;
    if (splat) splat = { ...splat, vx: splat.vx / n, vy: splat.vy / n, vz: splat.vz / n };
    for (let i = 0; i < n; i++) this.step(splat);
    this.splat = null;
  }

  advectDye(substeps) {
    const gl = this.gl;
    const p = this.dyePass.use()
      .tex('uDye', this.dye.textures[0])
      .tex('uMacro', this.macro)
      .tex('uMask', this.maskTex)
      .f('uDisp', substeps)
      .f('uInVel', this.inVel)
      .f3('uJetA', ...this.jetA)
      .f3('uJetB', ...this.jetB);
    const s = this.dyeSplat;
    if (s) {
      p.f3('uSplatPos', s.x, s.y, s.z)
        .f3('uSplatColor', s.color[0], s.color[1], s.color[2])
        .f('uSplatRadius', s.radius);
    } else {
      p.f('uSplatRadius', 0);
    }
    blitTo(gl, this.quad, this.dye2, this.aw, this.ah);
    [this.dye, this.dye2] = [this.dye2, this.dye];
    this.dyeSplat = null;
  }

  computeFields() {
    this.fieldsPass.use().tex('uMacro', this.macro);
    blitTo(this.gl, this.quad, this.fields, this.aw, this.ah);
  }

  get dyeTex() { return this.dye.textures[0]; }
  get fieldsTex() { return this.fields.textures[0]; }
}
