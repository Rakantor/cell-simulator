'use strict';
// Small WebGL2 helpers: programs with reflected uniforms, float textures, framebuffers.

const GLU = {
  gl: null,
  emptyVAO: null,

  init(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) return null;
    if (!gl.getExtension('EXT_color_buffer_float')) return null;
    this.gl = gl;
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.emptyVAO = gl.createVertexArray();
    return gl;
  },

  compile(type, src, name) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(sh);
      const src2 = src.split('\n');
      const ctx = [];
      for (const m of log.matchAll(/0:(\d+)/g)) {
        const n = +m[1];
        for (let k = Math.max(1, n - 2); k <= Math.min(src2.length, n + 2); k++) ctx.push(k + ': ' + src2[k - 1]);
      }
      console.error('Shader compile failed (' + name + '):\n' + log + '\n' + ctx.join('\n'));
      throw new Error('shader compile failed: ' + name);
    }
    return sh;
  },

  // Builds a program and reflects its active uniforms so they can be set by name.
  program(vsSrc, fsSrc, name) {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, this.compile(gl.VERTEX_SHADER, vsSrc, name + '.vs'));
    gl.attachShader(prog, this.compile(gl.FRAGMENT_SHADER, fsSrc, name + '.fs'));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
      console.error('Program link failed (' + name + '):\n' + gl.getProgramInfoLog(prog));
      throw new Error('program link failed: ' + name);
    }
    const uniforms = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      const key = info.name.replace(/\[0\]$/, '');
      uniforms[key] = { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size };
    }
    return new Program(gl, prog, uniforms, name);
  },

  floatTex(w, h, data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data || null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t.w = w; t.h = h;
    return t;
  },

  fbo(textures, depthRB) {
    const gl = this.gl;
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    const bufs = [];
    textures.forEach((t, i) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    });
    if (depthRB) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRB);
    gl.drawBuffers(bufs);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
      console.error('Framebuffer incomplete: 0x' + status.toString(16));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    f.bufs = bufs;
    return f;
  },

  // Attribute-less fullscreen triangle.
  drawFullscreen() {
    const gl = this.gl;
    gl.bindVertexArray(this.emptyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  },
};

class Program {
  constructor(gl, prog, uniforms, name) {
    this.gl = gl;
    this.prog = prog;
    this.u = uniforms;
    this.name = name;
    this.units = 0;
  }

  use() {
    this.gl.useProgram(this.prog);
    this.units = 0;
    return this;
  }

  has(name) { return !!this.u[name]; }

  // Sets a uniform by name; unknown names (optimised away) are ignored.
  set(name, v) {
    const u = this.u[name];
    if (!u) return this;
    const gl = this.gl;
    switch (u.type) {
      case gl.FLOAT: if (u.size > 1) gl.uniform1fv(u.loc, v); else gl.uniform1f(u.loc, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      case gl.INT: case gl.BOOL: if (u.size > 1) gl.uniform1iv(u.loc, v); else gl.uniform1i(u.loc, v); break;
      case gl.INT_VEC2: gl.uniform2iv(u.loc, v); break;
      case gl.INT_VEC4: gl.uniform4iv(u.loc, v); break;
      case gl.FLOAT_MAT2: gl.uniformMatrix2fv(u.loc, false, v); break;
      default: gl.uniform1i(u.loc, v);
    }
    return this;
  }

  // Binds a texture to the next free unit and points the sampler at it.
  tex(name, texture, target) {
    const u = this.u[name];
    if (!u) return this;
    const gl = this.gl;
    const unit = this.units++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target || gl.TEXTURE_2D, texture);
    gl.uniform1i(u.loc, unit);
    return this;
  }
}
