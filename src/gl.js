// Minimal WebGL2 helpers: shader compilation, float textures, MRT framebuffers.

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    alpha: false,
    preserveDrawingBuffer: true, // allows screenshots of the canvas
  });
  if (!gl) throw new Error('WebGL2 not supported');
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('EXT_color_buffer_float not supported (required for float render targets)');
  }
  return gl;
}

export const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export function compileProgram(gl, vsSrc, fsSrc) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile error:\n' + gl.getShaderInfoLog(sh) + '\n--- source ---\n' + src);
    }
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
  }
  return prog;
}

// A compiled fragment program with cached uniform locations and a use/bind API.
export class Pass {
  constructor(gl, fsSrc) {
    this.gl = gl;
    this.prog = compileProgram(gl, QUAD_VS, fsSrc);
    this.uniforms = {};
    const n = gl.getProgramParameter(this.prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(this.prog, i);
      this.uniforms[info.name] = gl.getUniformLocation(this.prog, info.name);
    }
  }
  use() {
    this.gl.useProgram(this.prog);
    this._unit = 0;
    return this;
  }
  tex(name, texture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + this._unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uniforms[name], this._unit);
    this._unit++;
    return this;
  }
  f(name, x)        { this.gl.uniform1f(this.uniforms[name], x); return this; }
  f2(name, x, y)    { this.gl.uniform2f(this.uniforms[name], x, y); return this; }
  f3(name, x, y, z) { this.gl.uniform3f(this.uniforms[name], x, y, z); return this; }
  i(name, x)        { this.gl.uniform1i(this.uniforms[name], x); return this; }
  i2(name, x, y)    { this.gl.uniform2i(this.uniforms[name], x, y); return this; }
}

export function makeQuad(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // single fullscreen triangle
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

export function makeTexture(gl, w, h, internalFormat, filter = gl.NEAREST) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

// Framebuffer with one or more color attachments.
export function makeFBO(gl, textures) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const drawBuffers = [];
  textures.forEach((tex, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
    drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
  });
  gl.drawBuffers(drawBuffers);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('Framebuffer incomplete: 0x' + status.toString(16));
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, textures };
}

export function blitTo(gl, quad, target, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
  gl.viewport(0, 0, w, h);
  gl.bindVertexArray(quad);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
