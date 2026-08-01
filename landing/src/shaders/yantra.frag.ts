/* The navayoni: nine interlocking triangles (four up, five down), a spoked chakra band,
   an enclosing circle and a bindu. Signed-distance fields, not paths, so the linework stays
   one pixel at any size — the same rule §5 of the design system puts on the painted motifs. */
export const YANTRA_FRAG = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 uRes; uniform float uTime; uniform vec3 uLine; uniform vec3 uAlt;
uniform float uStill; uniform vec2 uCentre;

float triSDF(vec2 p, float r){
  const float k = sqrt(3.0);
  p.x = abs(p.x) - r;
  p.y = p.y + r/k;
  if(p.x + k*p.y > 0.0) p = vec2(p.x - k*p.y, -k*p.x - p.y)/2.0;
  p.x -= clamp(p.x, -2.0*r, 0.0);
  return -length(p)*sign(p.y);
}
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
float stroke(float d, float w, float px){ return 1.0 - smoothstep(w-px, w+px, abs(d)); }

void main(){
  vec2 uv = (gl_FragCoord.xy - uCentre*uRes) / min(uRes.x, uRes.y);
  float px = 1.3 / min(uRes.x, uRes.y);
  float t = uTime * uStill;
  // scaling px with uv keeps the linework a constant weight on screen as the figure shrinks
  const float S = 1.62;
  uv *= S; px *= S;
  uv *= rot(0.012*t);

  float ink = 0.0, alt = 0.0;
  for(int i=0;i<4;i++){ float f=float(i);
    ink = max(ink, stroke(triSDF(uv, 0.300 - 0.052*f), 0.0013, px)); }
  for(int i=0;i<5;i++){ float f=float(i);
    alt = max(alt, stroke(triSDF(vec2(uv.x, -uv.y), 0.318 - 0.050*f), 0.0013, px)); }

  float r = length(uv), a = atan(uv.y, uv.x);
  const float R0 = 0.345, R1 = 0.415;
  ink = max(ink, stroke(r - R0, 0.0013, px));
  ink = max(ink, stroke(r - R1, 0.0013, px));
  if (r > R0 && r < R1) {
    float sp = mod(a + 0.02*t, 6.28318/24.0) - 6.28318/48.0;
    alt = max(alt, 1.0 - smoothstep(0.0016, 0.0016 + px*1.6, abs(sp)*r));
  }
  ink = max(ink, stroke(r - 0.478, 0.0018, px));

  float pulse = 0.0125 + 0.003*sin(t*0.8);
  alt = max(alt, 1.0 - smoothstep(pulse, pulse + px*2.2, r));

  float vig = 1.0 - smoothstep(0.50, 0.63, r);
  vec3 col = uLine*ink + uAlt*alt;
  float A = clamp(max(ink, alt), 0.0, 1.0) * vig;
  o = vec4(col*A, A);   // premultiplied: no bright fringe against the halo
}
`;
