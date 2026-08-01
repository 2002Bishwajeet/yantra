import { useEffect, useRef } from 'react';
import { YANTRA_FRAG } from '../shaders/yantra.frag';

/* A full-screen triangle from gl_VertexID alone — no buffers, no VAO, no attributes. */
const VERT = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2);
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }
`;

type RGB = [number, number, number];

const KALAM_FALLBACK: RGB = [0.063, 0.063, 0.063];
const HINGULA_FALLBACK: RGB = [0.733, 0.122, 0.082];

function pigment(style: CSSStyleDeclaration, name: string, fallback: RGB): RGB {
  const hex = style.getPropertyValue(name).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

export default function YantraShader({
  centre = [0.5, 0.66],
  className,
}: {
  centre?: [number, number];
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [cx, cy] = centre;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    if (!gl) return; // no WebGL2: the page degrades to the painted arch alone

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, YANTRA_FRAG);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uLine = gl.getUniformLocation(prog, 'uLine');
    const uAlt = gl.getUniformLocation(prog, 'uAlt');
    const uStill = gl.getUniformLocation(prog, 'uStill');

    // The shader emits premultiplied alpha; SRC_ALPHA here would darken the line twice.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(gl.getUniformLocation(prog, 'uCentre'), cx, cy);

    const root = getComputedStyle(document.documentElement);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0;
    let visible = true;
    let lost = false;

    const draw = (ms: number) => {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, ms / 1000);
      gl.uniform1f(uStill, reduce.matches ? 0 : 1);
      // Re-read each frame: the ground switch rewrites only tokens, so this is all the wiring it needs.
      gl.uniform3fv(uLine, pigment(root, '--kalam', KALAM_FALLBACK));
      gl.uniform3fv(uAlt, pigment(root, '--hingula', HINGULA_FALLBACK));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const frame = (ms: number) => {
      draw(ms);
      raf = requestAnimationFrame(frame);
    };

    const sync = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      if (lost || !visible) return;
      if (reduce.matches) draw(0); // one static frame; blanking it would be a regression
      else raf = requestAnimationFrame(frame);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (w === canvas.width && h === canvas.height) return;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    };

    const ro = new ResizeObserver(() => {
      resize();
      sync();
    });
    try {
      ro.observe(canvas, { box: 'device-pixel-content-box' }); // Chromium-only
    } catch {
      ro.observe(canvas);
    }

    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
      sync();
    });
    io.observe(canvas);

    // Without preventDefault the context is never restorable.
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
      cancelAnimationFrame(raf);
      raf = 0;
    };
    canvas.addEventListener('webglcontextlost', onLost);
    reduce.addEventListener('change', sync);

    resize();
    sync();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      reduce.removeEventListener('change', sync);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [cx, cy]);

  return <canvas ref={ref} aria-hidden className={className} />;
}
