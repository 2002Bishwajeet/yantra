/* Canvas UI — Flame Wrap + Displacement, ported to plain JS for a bundler-less page and then
   vendored here as a module. The GLSL is verbatim from canvasui.dev; only the content source
   changes: html-in-canvas (drawElementImage) ships in no browser yet, so
   - Flame Wrap runs in its own content-less path (uHasContent = 0): the fire and the sparks draw
     around a rect, the wrapped DOM stays real DOM underneath.
   - Displacement takes a draw callback instead of a captured element, so the texture it shears is
     whatever we paint into a 2D canvas.

   canvas-ui is MIT + Commons Clause: adapting it into a page is allowed, redistributing it as a
   component library is not. This is the former, and Y-202 took the same reading in M4. */

const CanvasFX = (function () {
  'use strict';

  function rectCache(el) {
    let current = el.getBoundingClientRect();
    const read = () => { current = el.getBoundingClientRect(); };
    addEventListener('scroll', read, { passive: true, capture: true });
    addEventListener('resize', read, { passive: true });
    return { get current() { return current; }, read, destroy() {
      removeEventListener('scroll', read, { capture: true });
      removeEventListener('resize', read);
    } };
  }

  const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main () { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FLAME_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uContent;
uniform vec2 uResolution;
uniform float uTime;
uniform vec2 uRectCenter;
uniform vec2 uRectHalf;
uniform float uCorner;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uHeight;
uniform float uSpread;
uniform float uScale;
uniform float uTurbulence;
uniform float uTurbScale;
uniform float uTurbReach;
uniform float uSparks;
uniform float uSparkSize;
uniform float uSparkDensity;
uniform float uSparkSpeed;
uniform float uRim;
uniform float uMelt;
uniform float uDistortion;
uniform float uSmoke;
uniform float uEmber;
uniform float uScorch;
uniform float uHasContent;
#define S(a, b, t) smoothstep(a, b, t)
vec3 permute (vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise (vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm (vec2 p) {
  mat2 m = mat2(0.8, -0.6, 0.6, 0.8);
  float v = 0.5 * snoise(p);
  p = m * p * 2.03 + vec2(11.3, 7.1);
  v += 0.27 * snoise(p);
  p = m * p * 1.97 + vec2(3.7, 19.1);
  v += 0.15 * snoise(p);
  p = m * p * 2.01 + vec2(8.3, 2.9);
  v += 0.08 * snoise(p);
  return v * 0.5 + 0.5;
}
float fbm2 (vec2 p) {
  float v = 0.62 * snoise(p);
  v += 0.31 * snoise(mat2(0.8, -0.6, 0.6, 0.8) * p * 2.13 + vec2(5.2, 1.3));
  return v * 0.54 + 0.5;
}
vec2 turbulence (vec2 p) {
  float freq = 12.0 * clamp(uScale, 0.05, 1.0) * clamp(uTurbScale, 0.2, 3.0);
  mat2 rot = mat2(0.6, -0.8, 0.8, 0.6);
  for (float i = 0.0; i < 7.0; i++) {
    float phase = freq * (p * rot).y + 6.0 * uTime + i;
    p += uTurbulence * rot[0] * sin(phase) / freq;
    rot *= mat2(0.6, -0.8, 0.8, 0.6);
    freq *= 1.2;
  }
  return p;
}
vec3 hash3 (vec2 p) {
  vec3 q = vec3(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)));
  return fract(sin(q) * 43758.5453);
}
float sdRoundRect (vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main () {
  vec2 frag = vUv * uResolution;
  vec2 rel = frag - uRectCenter;
  float unit = max(uHeight, 24.0);
  float corner = min(uCorner, min(uRectHalf.x, uRectHalf.y));
  float spreadPx = max(uSpread, 8.0);
  float t = uTime;
  float detail = clamp(uScale, 0.05, 1.0);
  float d0 = sdRoundRect(rel, uRectHalf, corner);
  float px = rel.x / unit;
  float py = rel.y / unit;
  float yA = max(rel.y - uRectHalf.y, 0.0) / unit;
  float sway = snoise(vec2(px * 1.1, t * 0.5)) * 0.55 + snoise(vec2(px * 2.4, t * 0.9 + 41.0)) * 0.25;
  float sx = px + yA * sway;
  float env = fbm2(vec2(sx * 1.6 * detail + 3.7, t * 0.55 - yA * 0.4));
  float env2 = fbm2(vec2(sx * 3.6 * detail, t * 0.85 + 17.0 - yA * 0.6));
  float tongue = clamp(0.75 * S(0.3, 0.9, env) + 0.5 * S(0.4, 0.95, env2), 0.0, 1.0);
  float meltPx = max(uMelt, 1.0);
  float biteTop = (3.0 + meltPx * 1.4) * (0.35 + 0.65 * tongue) + 2.0 * snoise(vec2(px * 5.0 * detail, t * 1.1 + 5.0));
  float yF = uRectHalf.y - biteTop;
  float frontTop = rel.y - yF;
  float perim = fbm2(rel * (1.9 / unit) * detail + vec2(0.0, t * 0.4) + 31.0);
  float biteSB = 3.0 + meltPx * (0.25 + 0.75 * perim);
  float frontSB = d0 + biteSB;
  float wTop = S(-0.62 * unit, -0.1 * unit, rel.y - uRectHalf.y) * S(10.0, -30.0, abs(rel.x) - (uRectHalf.x - corner));
  float front = mix(frontSB, frontTop, wTop);
  float reach = mix(spreadPx * 0.9, unit * (0.2 + 0.45 * tongue), wTop);
  float q = front / reach;
  vec2 np = vec2(px * 2.3, py * 1.25 - t * 1.85) * detail;
  np = turbulence(np);
  float n = fbm(np);
  float win = S(-0.08, 0.02, q);
  float root = exp(-abs(q) * 5.0);
  float ridge = 1.0 - abs(2.0 * n - 1.0);
  float flameH = mix(1.0, 0.5 + 0.6 * tongue, wTop);
  float g = max(q, 0.0) / flameH;
  float shred = fbm2(np * 1.9 + 63.0);
  g *= 1.0 + 0.7 * (shred - 0.5) * S(0.2, 0.8, g);
  float dens = n * 0.95 + ridge * 0.45 - 0.18 + (1.0 - min(g, 1.0)) * 0.3 - g * (0.9 + 0.25 * n);
  dens = clamp(dens * 2.4, 0.0, 1.0) * win;
  dens *= mix(1.0 - S(0.32, 1.05, q), 1.0 - S(0.9, 1.2, g), wTop);
  float body = dens * dens * (3.0 - 2.0 * dens);
  float emis = clamp(uIntensity, 0.0, 2.0);
  float e = body * (0.55 + 0.75 * root) * (0.45 + 0.55 * n) + win * root * (0.1 + 0.4 * n);
  e *= mix(0.45, 1.0, wTop) * max(emis, 0.001);
  vec3 hot = mix(uColor, vec3(1.0), 0.35);
  vec3 deep = mix(uColor, uColor * uColor, 0.5) * 0.9;
  float ramp = 1.0 - exp(-e * 2.4);
  vec3 fireCol = mix(deep, uColor, S(0.0, 0.55, ramp));
  float core = ramp * (0.45 + 0.55 * exp(-g * 2.2)) * (0.5 + 0.5 * n);
  fireCol = mix(fireCol, hot, S(0.7, 1.05, core));
  fireCol *= 0.8 + 0.4 * ramp;
  float fireA = clamp(1.0 - exp(-e * 3.4), 0.0, 1.0);
  float halo = exp(-max(front, 0.0) / (spreadPx * 1.2)) * S(0.0, 3.0, front) * (0.5 + 0.5 * n) * 0.3 * clamp(uRim, 0.0, 2.0) * mix(1.0, 0.45, wTop);
  vec3 glow = uColor * halo * clamp(uIntensity, 0.0, 2.0);
  if (uSparks > 0.001) {
    float sSpeed = max(uSparkSpeed, 0.05);
    float sCells = 5.0 * clamp(uSparkDensity, 0.3, 2.5);
    float sSize = clamp(uSparkSize, 0.2, 3.0);
    float gate = S(-0.05, 0.1, q) * (1.0 - S(1.3, 2.2, q)) * wTop;
    float spark = 0.0;
    for (float L = 0.0; L < 2.0; L++) {
      float speed = 1.5 * sSpeed * (0.75 + 0.5 * L);
      vec2 ps = vec2(px, py - t * speed);
      ps.x += 0.08 * snoise(vec2(py * 0.9 + L * 5.0, t * 0.5));
      float cells = sCells * (1.0 + 0.6 * L);
      vec2 cl = floor(ps * cells) + L * 19.0;
      vec2 fr = fract(ps * cells);
      vec3 rnd = hash3(cl);
      vec3 rnd2 = hash3(cl + 7.3);
      float on = step(rnd2.x, 0.42);
      float life = fract(rnd.z + t * sSpeed * (0.3 + 0.5 * rnd2.x));
      vec2 ppos = vec2(0.5) + 0.56 * (rnd.xy - 0.5);
      ppos.x += 0.14 * sin(t * (0.7 + rnd.z * 2.8) + rnd.y * 6.2832) + 0.1 * snoise(vec2(t * 0.6 + rnd.x * 9.0, cl.y * 0.7)) + (life - 0.5) * 0.5 * (rnd2.y - 0.5);
      ppos.y += (life - 0.5) * 0.3 * rnd2.y;
      float tw = S(0.02, 0.2, life) * S(1.0, 0.55, life);
      tw *= 0.75 + 0.25 * sin(t * (6.0 + rnd2.z * 9.0) + rnd.x * 6.2832);
      vec2 pd = (fr - ppos) / cells * unit;
      pd.y *= 0.55 + 0.3 * rnd2.z;
      float dp = length(pd);
      float r = (0.004 + 0.014 * rnd.y * rnd.y) * unit * sSize * mix(1.15, 0.55, life);
      float bmask = S(0.5, 0.32, max(abs(fr.x - 0.5), abs(fr.y - 0.5)));
      float sbody = exp(-dp * dp / (r * r));
      float sbloom = exp(-dp * dp / (r * r * 6.0)) * 0.3;
      spark += (sbody + sbloom) * tw * tw * on * bmask * (1.0 - 0.35 * L);
    }
    spark *= gate * uSparks;
    fireCol += mix(uColor, vec3(1.0), 0.55) * spark * 1.6;
    fireA = clamp(fireA + spark * 0.85, 0.0, 1.0);
  }
  vec2 edgePx = min(frag, uResolution - frag);
  float fadeW = max(24.0, spreadPx * 0.75);
  float fade = S(0.0, fadeW, edgePx.x) * S(0.0, fadeW, edgePx.y);
  fireA *= fade;
  glow *= fade;
  halo *= fade;
  float wisp = S(0.45, 0.9, fbm2(np * 0.55 + vec2(0.0, 17.0)));
  float smoke = S(1.55, 1.05, g) * S(0.85, 1.15, g) * (1.0 - body) * wTop * wisp * 0.055 * clamp(uSmoke, 0.0, 2.0) * fade;
  vec3 smokeCol = mix(vec3(0.5), uColor, 0.5);
  if (uHasContent < 0.5) {
    float sA = clamp(smoke, 0.0, 1.0);
    float a = clamp(fireA + sA * (1.0 - fireA), 0.0, 1.0);
    outColor = vec4(fireCol * fireA + glow + smokeCol * sA * (1.0 - fireA), clamp(a + halo * 0.6, 0.0, 1.0));
    return;
  }
  vec2 cUv = (rel + uRectHalf) / (2.0 * uRectHalf);
  float inRect = step(abs(cUv.x - 0.5), 0.5) * step(abs(cUv.y - 0.5), 0.5);
  float heatBand = exp(-abs(front) / max(uTurbReach, 4.0));
  vec2 wob = vec2(snoise(np * 1.7 + 9.0), snoise(np * 1.7 + 27.0));
  vec2 disp = wob * min(uDistortion, 32.0) * heatBand;
  vec2 cUvD = clamp(cUv + disp / (2.0 * uRectHalf), vec2(0.002), vec2(0.998));
  vec4 content = texture(uContent, vec2(cUvD.x, 1.0 - cUvD.y));
  float burn = clamp(uIntensity, 0.0, 1.0);
  float depth = max(-front, 0.0);
  float charPatch = 0.5 + 0.5 * fbm2(rel * (2.6 / unit) * detail + 57.0);
  float charW = mix(4.0, 6.0 + meltPx * 1.6, wTop) * charPatch;
  float charT = (1.0 - S(charW, charW * 2.4, depth));
  content.rgb = mix(content.rgb, content.rgb * vec3(0.22, 0.19, 0.17), clamp(charT * 0.85 * burn * clamp(uScorch, 0.0, 2.0), 0.0, 1.0));
  float emberW = mix(2.5, 5.5, wTop);
  float emberN = 0.3 + 0.7 * fbm2(np * 2.2 + 73.0);
  float emberK = clamp(uEmber, 0.0, 2.0);
  float ember = exp(-depth / emberW) * emberN * emberK;
  float whiteHot = exp(-depth / (emberW * 0.4)) * emberN * emberN * emberK;
  content.rgb = mix(content.rgb, uColor * 1.2, clamp(ember, 0.0, 1.0) * burn);
  content.rgb = mix(content.rgb, mix(uColor, vec3(1.0), 0.3) * 1.2, clamp(whiteHot, 0.0, 1.0) * burn);
  float dn = fbm2(rel * (3.2 / unit) * detail + vec2(0.0, t * 0.5) + 91.0);
  float dw = mix(2.0, 5.0, wTop);
  float dissolve = S(-dw, dw, front + (dn - 0.5) * dw * 2.5);
  float cA = content.a * (1.0 - dissolve) * inRect;
  float smk = smoke * (1.0 - cA);
  float baseA = min(cA + smk, 1.0);
  vec3 base = content.rgb * cA + smokeCol * smk;
  vec3 col = fireCol * fireA + base * (1.0 - fireA) + glow;
  float alpha = clamp(fireA + baseA * (1.0 - fireA) + halo * 0.5, 0.0, 1.0);
  outColor = vec4(col, alpha);
}`;

  const DISP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uContent;
uniform sampler2D uField;
uniform vec2 uResolution;
uniform float uShift;
uniform float uAberration;
uniform float uGrain;
uniform float uGrainPx;
uniform float uGrainTick;
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main () {
  vec2 cuv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 offset = texture(uField, cuv).rg;
  vec2 push = offset * 0.02 * uShift;
  float ab = uAberration * 0.08;
  vec2 lo = vec2(0.001);
  vec2 hi = vec2(0.999);
  vec4 cr = texture(uContent, clamp(cuv - push * (1.0 + ab), lo, hi));
  vec4 cg = texture(uContent, clamp(cuv - push, lo, hi));
  vec4 cb = texture(uContent, clamp(cuv - push * (1.0 - ab), lo, hi));
  float alpha = (cr.a + cg.a + cb.a) / 3.0;
  vec3 col = vec3(cr.r * cr.a, cg.g * cg.a, cb.b * cb.a);
  col = min(col, vec3(alpha));
  float pushPx = length(push * uResolution);
  float gate = smoothstep(1.5, 18.0, pushPx);
  vec2 cell = floor(gl_FragCoord.xy / max(uGrainPx, 1.0));
  float gn = hash(cell + vec2(uGrainTick * 0.37, uGrainTick * 0.113));
  col += (gn - 0.5) * 0.3 * uGrain * gate * alpha;
  col = clamp(col, vec3(0.0), vec3(alpha));
  outColor = vec4(col, alpha);
}`;

  function setup(output, frag, premultiplied) {
    const gl = output.getContext('webgl2', {
      alpha: true, depth: false, stencil: false, antialias: false,
      premultipliedAlpha: premultiplied,
    });
    if (!gl || gl.isContextLost()) return null;
    const compile = (type, text) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('CanvasFX shader:', gl.getShaderInfoLog(s));
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, frag);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    const u = {};
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(program, i);
      u[info.name] = gl.getUniformLocation(program, info.name);
    }
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    return { gl, program, u, quad, vs, fs };
  }

  function blankTexture(gl, filter) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    return tex;
  }

  const FLAME_DEFAULTS = {
    color: [0.91, 0.45, 0.29], intensity: 0.5, height: 170, spread: 8, radius: 40,
    speed: 0.25, scale: 0.75, turbulence: 0.5, turbulenceScale: 0.5, turbulenceReach: 25,
    sparks: 1.5, sparkSize: 0.35, sparkDensity: 1, sparkSpeed: 1, rim: 2.5, melt: 4.5,
    distortion: 10, smoke: 1.5, ember: 2, scorch: 0,
  };

  /** Fire around `target`'s box, drawn onto `output`. No content capture. */
  function createFlameWrap(output, target, options) {
    const config = Object.assign({}, FLAME_DEFAULTS, options || {});
    const ctx = setup(output, FLAME_FRAG, true);
    if (!ctx) return null;
    const { gl, program, u } = ctx;
    const content = blankTexture(gl, gl.LINEAR);
    const rect = { cx: 0, cy: 0, hx: 1, hy: 1 };
    let dpr = 1;

    function sync() {
      dpr = Math.min(devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(output.clientWidth * dpr));
      const h = Math.max(1, Math.round(output.clientHeight * dpr));
      if (output.width !== w || output.height !== h) { output.width = w; output.height = h; }
      const out = output.getBoundingClientRect();
      const box = target.getBoundingClientRect();
      if (out.width > 0 && box.width > 0) {
        rect.cx = (box.left + box.right) / 2 - out.left;
        rect.cy = out.bottom - (box.top + box.bottom) / 2;
        rect.hx = box.width / 2;
        rect.hy = box.height / 2;
      }
    }
    sync();

    let time = 0;
    function render() {
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, content);
      gl.uniform1i(u.uContent, 0);
      gl.uniform2f(u.uResolution, output.width, output.height);
      gl.uniform1f(u.uTime, time);
      gl.uniform2f(u.uRectCenter, rect.cx * dpr, rect.cy * dpr);
      gl.uniform2f(u.uRectHalf, Math.max(rect.hx * dpr, 1), Math.max(rect.hy * dpr, 1));
      gl.uniform1f(u.uCorner, Math.max(config.radius, 0) * dpr);
      gl.uniform3f(u.uColor, config.color[0], config.color[1], config.color[2]);
      gl.uniform1f(u.uIntensity, Math.max(config.intensity, 0));
      gl.uniform1f(u.uHeight, Math.max(config.height, 24) * dpr);
      gl.uniform1f(u.uSpread, Math.max(config.spread, 8) * dpr);
      gl.uniform1f(u.uScale, Math.max(config.scale, 0.05));
      gl.uniform1f(u.uTurbulence, Math.max(config.turbulence, 0));
      gl.uniform1f(u.uTurbScale, Math.max(config.turbulenceScale, 0.2));
      gl.uniform1f(u.uTurbReach, Math.max(config.turbulenceReach, 4) * dpr);
      gl.uniform1f(u.uSparks, Math.max(config.sparks, 0));
      gl.uniform1f(u.uSparkSize, Math.max(config.sparkSize, 0.2));
      gl.uniform1f(u.uSparkDensity, Math.max(config.sparkDensity, 0.3));
      gl.uniform1f(u.uSparkSpeed, Math.max(config.sparkSpeed, 0.05));
      gl.uniform1f(u.uRim, Math.max(config.rim, 0));
      gl.uniform1f(u.uMelt, Math.max(config.melt, 0) * dpr);
      gl.uniform1f(u.uDistortion, Math.max(config.distortion, 0) * dpr);
      gl.uniform1f(u.uSmoke, Math.max(config.smoke, 0));
      gl.uniform1f(u.uEmber, Math.max(config.ember, 0));
      gl.uniform1f(u.uScorch, Math.max(config.scorch, 0));
      gl.uniform1f(u.uHasContent, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, output.width, output.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    let raf = 0, last = performance.now(), dead = false, running = false, visible = true;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    function frame(now) {
      if (dead) return;
      if (!visible) { running = false; return; }
      const delta = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      if (!motion.matches) time += delta * config.speed;
      render();
      if (motion.matches) { running = false; return; }
      raf = requestAnimationFrame(frame);
    }
    function start() { if (dead || running || !visible) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
    start();

    const ro = new ResizeObserver(() => { sync(); start(); });
    ro.observe(output);
    ro.observe(target);
    const io = new IntersectionObserver((e) => {
      visible = e[e.length - 1] ? e[e.length - 1].isIntersecting : true;
      if (visible) start();
    });
    io.observe(output);
    const onScroll = () => { sync(); start(); };
    addEventListener('scroll', onScroll, { passive: true });

    return {
      setOptions(next) { Object.assign(config, next); sync(); start(); },
      resize() { sync(); start(); },
      destroy() {
        dead = true;
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        removeEventListener('scroll', onScroll);
        gl.deleteTexture(content);
        gl.deleteProgram(program);
      },
    };
  }

  const DISP_DEFAULTS = {
    grid: 50, cellAspect: 1, radius: 0.1, strength: 0.1, threshold: 1000,
    relaxation: 0.9, shift: 1, aberration: 1.5, grain: 0.1, grainSize: 1,
    grainSpeed: 1, scramble: 1,
  };

  /** Cell-shear displacement over a texture `draw(ctx, w, h)` paints. */
  function createDisplacement(output, draw, options) {
    const config = Object.assign({}, DISP_DEFAULTS, options || {});
    const ctx = setup(output, DISP_FRAG, true);
    if (!ctx) return null;
    const { gl, program, u } = ctx;
    const contentTex = blankTexture(gl, gl.LINEAR);
    const fieldTex = blankTexture(gl, gl.NEAREST);
    if (!gl.getExtension('EXT_color_buffer_float')) { /* RG32F upload still works */ }

    const source = document.createElement('canvas');
    const source2d = source.getContext('2d');
    let contentDirty = true;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let cols = 0, rows = 0, rowScale = 1, outW = 1, outH = 1, scrambled = false;
    let field = new Float32Array(0), fieldDirty = false, dpr = 1;

    function syncGrid() {
      const nextCols = Math.round(Math.min(Math.max(config.grid, 4), 100));
      const aspect = Math.min(Math.max(config.cellAspect, 0.25), 4);
      const nextRows = Math.max(2, Math.min(Math.round((nextCols * outH * aspect) / outW), 200));
      if (nextCols === cols && nextRows === rows) { rowScale = (outH * cols) / (outW * rows); return; }
      cols = nextCols; rows = nextRows;
      rowScale = (outH * cols) / (outW * rows);
      field = new Float32Array(cols * rows * 2);
      if (!scrambled && !motion.matches && config.scramble > 0) {
        const amp = 40 * Math.min(config.scramble, 3);
        for (let i = 0; i < field.length; i++) field[i] = (Math.random() * 2 - 1) * amp;
      }
      scrambled = true;
      gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, cols, rows, 0, gl.RG, gl.FLOAT, field);
      fieldDirty = false;
    }

    function sync() {
      dpr = Math.min(devicePixelRatio || 1, 2);
      outW = Math.max(1, output.clientWidth);
      outH = Math.max(1, output.clientHeight);
      const w = Math.max(1, Math.round(outW * dpr));
      const h = Math.max(1, Math.round(outH * dpr));
      if (output.width !== w || output.height !== h) { output.width = w; output.height = h; }
      if (source.width !== w || source.height !== h) { source.width = w; source.height = h; contentDirty = true; }
      syncGrid();
    }
    sync();

    function uploadContent() {
      if (!contentDirty) return;
      contentDirty = false;
      source2d.setTransform(1, 0, 0, 1, 0, 0);
      source2d.clearRect(0, 0, source.width, source.height);
      draw(source2d, source.width, source.height, dpr);
      gl.bindTexture(gl.TEXTURE_2D, contentTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    function uploadField() {
      if (!fieldDirty) return;
      fieldDirty = false;
      gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RG, gl.FLOAT, field);
    }

    const mouse = { x: 0, y: 0, prevX: 0, prevY: 0, vX: 0, vY: 0, speed: 0, gate: 0, lastT: 0 };
    let tracking = false;

    function step(delta) {
      const relaxation = Math.min(Math.max(config.relaxation, 0.5), 0.995);
      const decay = Math.pow(relaxation, delta * 60);
      let maxAbs = 0;
      for (let i = 0; i < field.length; i++) {
        const value = field[i] * decay;
        field[i] = value;
        const abs = Math.abs(value);
        if (abs > maxAbs) maxAbs = abs;
      }
      const injecting = tracking && (mouse.vX !== 0 || mouse.vY !== 0);
      if (injecting) {
        const gridX = mouse.x * cols;
        const gridY = mouse.y * rows;
        const maxDist = cols * Math.min(Math.max(config.radius, 0.02), 1);
        const maxSq = maxDist * maxDist;
        const gain = Math.min(Math.max(config.strength, 0), 1) * 100 * mouse.gate;
        for (let j = 0; j < rows; j++) {
          const dy = (gridY - j) * rowScale;
          for (let i = 0; i < cols; i++) {
            const dx = gridX - i;
            const distSq = dx * dx + dy * dy;
            if (distSq < maxSq) {
              const power = Math.min(maxDist / Math.sqrt(distSq), 10);
              const idx = 2 * (i + cols * j);
              field[idx] += gain * mouse.vX * power;
              field[idx + 1] += gain * mouse.vY * power;
            }
          }
        }
      }
      const vDecay = Math.pow(0.9, delta * 60);
      mouse.vX *= vDecay; mouse.vY *= vDecay;
      if (Math.abs(mouse.vX) < 0.0001) mouse.vX = 0;
      if (Math.abs(mouse.vY) < 0.0001) mouse.vY = 0;
      fieldDirty = true;
      const alive = injecting || mouse.vX !== 0 || mouse.vY !== 0 || maxAbs > 0.03;
      if (!alive && maxAbs > 0) field.fill(0);
      return alive;
    }

    let time = 0;
    function render() {
      uploadContent();
      uploadField();
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, contentTex);
      gl.uniform1i(u.uContent, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.uniform1i(u.uField, 1);
      gl.uniform2f(u.uResolution, output.width, output.height);
      gl.uniform1f(u.uShift, Math.min(Math.max(config.shift, 0), 4));
      gl.uniform1f(u.uAberration, Math.min(Math.max(config.aberration, 0), 3));
      gl.uniform1f(u.uGrain, Math.min(Math.max(config.grain, 0), 1));
      gl.uniform1f(u.uGrainPx, Math.max(1, Math.min(Math.max(config.grainSize, 0.5), 4) * dpr * 1.5));
      gl.uniform1f(u.uGrainTick, Math.floor(time * Math.min(Math.max(config.grainSpeed, 0), 4) * 18));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, output.width, output.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    let raf = 0, last = performance.now(), dead = false, running = false, visible = true;
    function frame(now) {
      if (dead) return;
      if (!visible) { running = false; return; }
      const delta = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      time += delta;
      /* The relaxation pass runs even under reduced motion, or a scramble or a
         jolt would freeze on screen instead of settling. Injection is gated in
         the pointer handler and in jolt(). */
      step(delta);
      render();
      /* Kept running while on screen: the texture is ours rather than a DOM
         capture, and a canvas whose size changed under it comes back cleared,
         so a loop that parked on a still frame would park on an empty one. */
      raf = requestAnimationFrame(frame);
    }
    function start() { if (dead || running || !visible) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
    start();

    const host = output.parentElement || output;
    const cache = rectCache(output);
    function onMove(event) {
      if (motion.matches) return;
      const box = cache.current;
      if (box.width < 1 || box.height < 1) return;
      const x = (event.clientX - box.left) / box.width;
      const y = (event.clientY - box.top) / box.height;
      const now = performance.now();
      if (!tracking) {
        tracking = true; mouse.prevX = x; mouse.prevY = y; mouse.speed = 0; mouse.gate = 0; mouse.lastT = now;
      }
      mouse.vX = x - mouse.prevX;
      mouse.vY = y - mouse.prevY;
      const dt = Math.max((now - mouse.lastT) / 1000, 0.001);
      mouse.lastT = now;
      const distPx = Math.hypot(mouse.vX * box.width, mouse.vY * box.height);
      mouse.speed += (distPx / dt - mouse.speed) * Math.min(dt * 25, 1);
      const threshold = Math.max(config.threshold, 0);
      if (threshold <= 0) mouse.gate = 1;
      else {
        const s = Math.min(Math.max((mouse.speed - threshold) / threshold, 0), 1);
        mouse.gate = s * s * (3 - 2 * s);
      }
      mouse.prevX = x; mouse.prevY = y; mouse.x = x; mouse.y = y;
      start();
    }
    function onLeave() { tracking = false; mouse.vX = 0; mouse.vY = 0; mouse.speed = 0; mouse.gate = 0; }
    host.addEventListener('pointermove', onMove, { passive: true });
    host.addEventListener('pointerleave', onLeave, { passive: true });
    host.addEventListener('pointercancel', onLeave, { passive: true });

    const ro = new ResizeObserver(() => { sync(); start(); });
    ro.observe(output);
    const io = new IntersectionObserver((e) => {
      visible = e[e.length - 1] ? e[e.length - 1].isIntersecting : true;
      if (visible) start();
    });
    io.observe(output);

    return {
      setOptions(next) { Object.assign(config, next); syncGrid(); sync(); start(); },
      /** Repaint the texture — call when what `draw` paints has changed. */
      refresh() { contentDirty = true; start(); },
      /** Kick the field, so a beat change shears the cells without a cursor. */
      jolt(amount) {
        if (motion.matches) return;
        const amp = 40 * (amount || 1);
        for (let i = 0; i < field.length; i++) field[i] += (Math.random() * 2 - 1) * amp;
        fieldDirty = true;
        start();
      },
      resize() { sync(); start(); },
      destroy() {
        dead = true;
        cancelAnimationFrame(raf);
        cache.destroy();
        ro.disconnect();
        io.disconnect();
        host.removeEventListener('pointermove', onMove);
        host.removeEventListener('pointerleave', onLeave);
        host.removeEventListener('pointercancel', onLeave);
        gl.deleteTexture(contentTex);
        gl.deleteTexture(fieldTex);
        gl.deleteProgram(program);
      },
    };
  }

  return { createFlameWrap, createDisplacement };
})();

export const { createFlameWrap, createDisplacement } = CanvasFX;
