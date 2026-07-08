// 3D presentation: orbit camera, half-res volume raymarch, tracer streaks,
// wireframe bounds. Minimal hand-rolled mat4 math — no dependencies.

import { Pass, compileProgram, makeTexture, makeFBO, blitTo, QUAD_VS } from '../../src/gl.js';
import { raymarchFS, COMPOSITE_FS, WIRE_VS, WIRE_FS } from './raymarch.glsl.js';
import { particleUpdateFS, streakVS, STREAK_FS } from './shaders3d.js';

// ---------- tiny mat4 (column-major) ----------

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = (far + near) * nf; m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function lookAt(eye, target, up) {
  const z = norm3(sub3(eye, target));
  const x = norm3(cross3(up, z));
  const y = cross3(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ]);
}

function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm3(v) { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

// ---------- orbit camera ----------

export class OrbitCamera {
  constructor() {
    this.theta = 0.5;      // azimuth
    this.phi = 0.28;       // elevation
    this.radius = 2.6;
    this.target = [0, 0, 0];
    this.fov = (42 * Math.PI) / 180;
  }
  get eye() {
    const cp = Math.cos(this.phi), sp = Math.sin(this.phi);
    return [
      this.target[0] + this.radius * cp * Math.sin(this.theta),
      this.target[1] + this.radius * sp,
      this.target[2] + this.radius * cp * Math.cos(this.theta),
    ];
  }
  basis() {
    const eye = this.eye;
    const fwd = norm3(sub3(this.target, eye));
    const right = norm3(cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    return { eye, fwd, right, up };
  }
  orbit(dx, dy) {
    this.theta -= dx * 0.005;
    this.phi = Math.max(-1.35, Math.min(1.35, this.phi + dy * 0.005));
  }
  zoom(dy) {
    this.radius = Math.max(0.9, Math.min(7, this.radius * Math.exp(dy * 0.001)));
  }
  pan(dx, dy) {
    const { right, up } = this.basis();
    const k = this.radius * 0.0012;
    for (let i = 0; i < 3; i++) this.target[i] += (-dx * right[i] + dy * up[i]) * k;
  }
}

// ---------- renderer ----------

const PARTICLE_DIM = 160; // 25,600 tracers

export class Renderer3D {
  constructor(gl, quad, sim) {
    this.gl = gl;
    this.quad = quad;
    this.sim = sim;
    this.mode = 0;

    // world scale: box height = 1
    this.voxel = 1 / sim.ny;
    this.size = [sim.nx * this.voxel, 1, sim.nz * this.voxel];
    this.origin = [-this.size[0] / 2, -0.5, -this.size[2] / 2];

    this.theme = {
      bg0: [0.016, 0.020, 0.032], bg1: [0.043, 0.055, 0.083],
      cold: [0.15, 0.5, 1.0], hot: [1.0, 0.42, 0.08],
      slow: [0.10, 0.38, 1.0], fast: [1.0, 0.86, 0.45],
      wire: [0.16, 0.19, 0.26],
      emission: 1.0, absorb: 1.0,
    };

    this.raymarchPass = new Pass(gl, raymarchFS(sim.common));
    this.compositePass = new Pass(gl, COMPOSITE_FS);

    this.volW = 2; this.volH = 2;
    this.volume = null; // sized lazily to half canvas res

    // particles
    this.particleUpdate = new Pass(gl, particleUpdateFS(sim.common));
    this.pState = makeFBO(gl, [makeTexture(gl, PARTICLE_DIM, PARTICLE_DIM, gl.RGBA32F)]);
    this.pState2 = makeFBO(gl, [makeTexture(gl, PARTICLE_DIM, PARTICLE_DIM, gl.RGBA32F)]);
    this._seedParticles();

    this.streakProg = compileProgram(gl, streakVS(sim.common), STREAK_FS);
    this.streakU = {};
    for (const n of ['uParticles', 'uMacro', 'uVP', 'uEye', 'uVoxel', 'uOrigin', 'uInVel', 'uDepth', 'uViewport', 'uSlow', 'uFast'])
      this.streakU[n] = gl.getUniformLocation(this.streakProg, n);
    this.streakVao = gl.createVertexArray();

    // wire box
    this.wireProg = compileProgram(gl, WIRE_VS, WIRE_FS);
    this.wireU = {
      uVP: gl.getUniformLocation(this.wireProg, 'uVP'),
      uOrigin: gl.getUniformLocation(this.wireProg, 'uOrigin'),
      uSize: gl.getUniformLocation(this.wireProg, 'uSize'),
      uColor: gl.getUniformLocation(this.wireProg, 'uColor'),
    };
    this.wireVao = gl.createVertexArray();
    gl.bindVertexArray(this.wireVao);
    const E = [0,0,0, 1,0,0, 1,0,0, 1,1,0, 1,1,0, 0,1,0, 0,1,0, 0,0,0,
               0,0,1, 1,0,1, 1,0,1, 1,1,1, 1,1,1, 0,1,1, 0,1,1, 0,0,1,
               0,0,0, 0,0,1, 1,0,0, 1,0,1, 1,1,0, 1,1,1, 0,1,0, 0,1,1];
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(E), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _seedParticles() {
    const gl = this.gl, s = this.sim;
    const data = new Float32Array(PARTICLE_DIM * PARTICLE_DIM * 4);
    for (let i = 0; i < PARTICLE_DIM * PARTICLE_DIM; i++) {
      data[i * 4 + 0] = Math.random() * s.nx;
      data[i * 4 + 1] = 2 + Math.random() * (s.ny - 4);
      data[i * 4 + 2] = 2 + Math.random() * (s.nz - 4);
      data[i * 4 + 3] = Math.random() * 500;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.pState.textures[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PARTICLE_DIM, PARTICLE_DIM, gl.RGBA, gl.FLOAT, data);
  }

  updateParticles(substeps, time) {
    const gl = this.gl;
    this.particleUpdate.use()
      .tex('uParticles', this.pState.textures[0])
      .tex('uMacro', this.sim.macro)
      .tex('uMask', this.sim.maskTex)
      .f('uDisp', substeps)
      .f('uTime', time % 1000)
      .f('uInVel', this.sim.inVel);
    blitTo(gl, this.quad, this.pState2, PARTICLE_DIM, PARTICLE_DIM);
    [this.pState, this.pState2] = [this.pState2, this.pState];
  }

  _ensureVolumeTarget(w, h) {
    const gl = this.gl;
    const vw = Math.max(2, w >> 1), vh = Math.max(2, h >> 1);
    if (this.volume && vw === this.volW && vh === this.volH) return;
    this.volW = vw; this.volH = vh;
    this.volume = makeFBO(gl, [makeTexture(gl, vw, vh, gl.RGBA16F)]);
  }

  draw(camera, canvasW, canvasH) {
    const gl = this.gl, s = this.sim, th = this.theme;
    this._ensureVolumeTarget(canvasW, canvasH);

    const { eye, fwd, right, up } = camera.basis();
    const aspect = canvasW / canvasH;

    // 1) volume raymarch at half res
    this.raymarchPass.use()
      .tex('uDye', s.dyeTex)
      .tex('uFields', s.fieldsTex)
      .tex('uMask', s.maskTex)
      .f3('uEye', ...eye).f3('uFwd', ...fwd).f3('uRight', ...right).f3('uUp', ...up)
      .f('uTanFov', Math.tan(camera.fov / 2))
      .f('uAspect', aspect)
      .i('uMode', this.mode)
      .f('uInVel', s.inVel)
      .f3('uOrigin', ...this.origin)
      .f('uVoxel', this.voxel)
      .f3('uBg0', ...th.bg0).f3('uBg1', ...th.bg1)
      .f3('uCold', ...th.cold).f3('uHot', ...th.hot)
      .f('uEmis', th.emission ?? 1).f('uAbsorb', th.absorb ?? 1);
    blitTo(gl, this.quad, this.volume, this.volW, this.volH);

    // 2) composite to canvas
    this.compositePass.use().tex('uVolume', this.volume.textures[0]);
    blitTo(gl, this.quad, null, canvasW, canvasH);

    const vp = mul4(perspective(camera.fov, aspect, 0.05, 40), lookAt(eye, camera.target, [0, 1, 0]));

    // 3) wire box
    gl.useProgram(this.wireProg);
    gl.uniformMatrix4fv(this.wireU.uVP, false, vp);
    gl.uniform3f(this.wireU.uOrigin, ...this.origin);
    gl.uniform3f(this.wireU.uSize, ...this.size);
    gl.uniform3f(this.wireU.uColor, ...th.wire);
    gl.bindVertexArray(this.wireVao);
    gl.drawArrays(gl.LINES, 0, 24);
    gl.bindVertexArray(null);

    // 4) tracer streaks (trace mode only), occluded by obstacles
    if (this.mode === 3) {
      gl.useProgram(this.streakProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.pState.textures[0]);
      gl.uniform1i(this.streakU.uParticles, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, s.macro);
      gl.uniform1i(this.streakU.uMacro, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.volume.textures[0]);
      gl.uniform1i(this.streakU.uDepth, 2);
      gl.uniformMatrix4fv(this.streakU.uVP, false, vp);
      gl.uniform3f(this.streakU.uEye, ...eye);
      gl.uniform1f(this.streakU.uVoxel, this.voxel);
      gl.uniform3f(this.streakU.uOrigin, ...this.origin);
      gl.uniform1f(this.streakU.uInVel, s.inVel);
      gl.uniform2f(this.streakU.uViewport, canvasW, canvasH);
      gl.uniform3f(this.streakU.uSlow, ...th.slow);
      gl.uniform3f(this.streakU.uFast, ...th.fast);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.streakVao);
      // draw a third of the pool — full density reads as noise, not flow
      gl.drawArrays(gl.LINES, 0, Math.floor((PARTICLE_DIM * PARTICLE_DIM) / 3) * 2);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
  }
}
