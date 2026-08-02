/* torana.ts — the cusped arch that spans the head of a Pattachitra field.
   Framework-free, no imports, no DOM. Every function returns an SVG fragment string in
   userSpaceOnUse coordinates; colour comes only from the custom properties in tokens.css. */

export interface ToranaOpts {
  w: number;
  h: number;
  /** jamb length: how far the vertical legs run below the springing. default h*0.30 */
  spring?: number;
  /** foil count. MUST be even — an odd count scoops the apex into a dome. default 4 */
  lobes?: number;
  /** thickness of the pearl band. default min(w*0.026, h*0.05) — see the note in torana() */
  bandW?: number;
  /** coordinate decimals. 1 is invisible at these sizes; 0 halves the markup. default 1 */
  dp?: number;
}

export interface LampOpts {
  /** stem length in user units, from the cusp to the fork. default 34 */
  drop?: number;
  /** bell size: the main bell is 12*scale tall. never scales the stem. default 1 */
  scale?: number;
  dp?: number;
}

export interface RosetteOpts {
  /** petal-tip radius. default 40 */
  r?: number;
  dp?: number;
}

type Pt = [number, number];

/* Profile constants. AMP is how deep a cusp bites; PEAK is the apex point; TAPER is how far
   from the springing the foiling fades so the curve meets the jamb tangentially. */
const AMP = 0.17;
const FLAT = 0.12;
/* The apex point has to be LOCAL. A broad (1 - PEAK*|cos t|) term kinks by only a few degrees
   and still reads as a dome; a tent of half-width SIG gives a real 150-degree vertex. */
const PEAK = 0.06;
const SIG = 0.15;
const TAPER = 0.55;
const WARP = 0.12;
/* The reference cusps BOTH rims of the band equally — they are parallel offsets. What stays calm
   there is the creeper outside it, which glides past the cusps on half the amplitude (VINE_DAMP);
   give the creeper the full foiling and its radial offset dives through the band at the shallow
   cusps near the springing. */
const VINE_DAMP = 0.5;

const PI = Math.PI;

function n(v: number, dp: number): string {
  const f = Math.pow(10, dp);
  const r = Math.round(v * f) / f;
  return String(r === 0 ? 0 : r);
}

function pts(list: Pt[], dp: number, from = 0, to = list.length - 1): string {
  const step = to >= from ? 1 : -1;
  let s = '';
  for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
    s += 'L' + n(list[i][0], dp) + ' ' + n(list[i][1], dp);
  }
  return s;
}

/** A circle as path data, so several can share one <path>. */
function disc(x: number, y: number, r: number, dp: number): string {
  return 'M' + n(x - r, dp) + ' ' + n(y, dp) +
    'a' + n(r, dp) + ' ' + n(r, dp) + ' 0 1 0 ' + n(2 * r, dp) + ' 0' +
    'a' + n(r, dp) + ' ' + n(r, dp) + ' 0 1 0 ' + n(-2 * r, dp) + ' 0Z';
}

/** Stretches the crown at the expense of the outer foils; fixed at the apex and both springings.
    Measured off the reference, whose cusps sit 35° and 76° from the apex, not 22.5° and 67.5°. */
function warp(t: number): number {
  return t + WARP * Math.sin(2 * t);
}

/** warp is monotonic (WARP < 0.5), so bisection inverts it. */
function unwarp(phi: number): number {
  let lo = 0, hi = PI;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (warp(m) < phi) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/** r(θ) in units of the ellipse radii. Corner-max at the apex, corner-min at each cusp,
    round between, and flat-zero modulation at both springings. */
function profile(t: number, lobes: number, amp: number): number {
  const e = Math.min(t, PI - t) / TAPER;
  const taper = e >= 1 ? 1 : e * e * (3 - 2 * e);
  const foil = 1 - Math.abs(Math.cos(lobes * warp(t)));
  const tent = 1 - PEAK * Math.min(1, Math.abs(t - PI / 2) / SIG);
  return (1 - amp * taper * foil) * (1 - FLAT * Math.abs(Math.cos(t))) * tent;
}

/** Samples the profile onto an ellipse along the given angles. */
function sweep(
  cx: number, baseY: number, rx: number, ry: number,
  lobes: number, amp: number, ts: number[],
): Pt[] {
  return ts.map((t) => {
    const r = profile(t, lobes, amp);
    return [cx + rx * r * Math.cos(t), baseY - ry * r * Math.sin(t)] as Pt;
  });
}

/** θ = π → 0, dense, with every cusp and the apex hit exactly so no vertex gets chamfered. */
function angles(lobes: number, steps: number): number[] {
  const set = [PI / 2];
  for (let i = 0; i <= steps; i++) set.push(PI * (1 - i / steps));
  for (let j = 0; j < lobes; j++) set.push(unwarp((PI / 2 + j * PI) / lobes));
  return set.sort((a, b) => b - a);
}

/** Walks a polyline at fixed arc-length, symmetric about its midpoint. Tangents are taken
    between neighbouring stations, not from the underlying segment: at 400 samples a single
    segment near a cusp is shorter than the noise in it, and the leaves fan out at random. */
function walk(path: Pt[], spacing: number): { p: Pt; a: number; i: number }[] {
  const seg: number[] = [0];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    seg.push(total);
  }
  const count = Math.max(1, Math.round(total / spacing));
  const step = total / count;
  const out: { p: Pt; a: number; i: number }[] = [];
  let k = 1;
  for (let j = 0; j < count; j++) {
    const d = (j + 0.5) * step;
    while (k < seg.length - 1 && seg[k] < d) k++;
    const f = (d - seg[k - 1]) / Math.max(1e-6, seg[k] - seg[k - 1]);
    const a = path[k - 1], b = path[k];
    out.push({
      p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
      a: Math.atan2(b[1] - a[1], b[0] - a[0]),
      i: j,
    });
  }
  for (let j = 0; j < out.length; j++) {
    const a = out[Math.max(0, j - 1)].p, b = out[Math.min(out.length - 1, j + 1)].p;
    if (a !== b) out[j].a = Math.atan2(b[1] - a[1], b[0] - a[0]);
  }
  return out;
}

/** Pushes a polyline d to its left-hand side — outward, for a curve run π→0 over the crown.
    A radial offset (bigger ellipse radii) is not this: on a flat ellipse it clears the band by
    `d` only at the crown and at the springings, and by several times `d` on the shoulders. */
function outset(path: Pt[], d: number): Pt[] {
  return path.map((p, i) => {
    const a = path[Math.max(0, i - 3)], b = path[Math.min(path.length - 1, i + 3)];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const m = Math.hypot(dx, dy) || 1;
    return [p[0] + (dy / m) * d, p[1] - (dx / m) * d] as Pt;
  });
}

/** A pointed patta leaf: base at (x,y), tip len away along ang. */
function leaf(x: number, y: number, ang: number, len: number, wid: number, dp: number): string {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const nx = -dy, ny = dx;
  const mx = x + dx * len * 0.42, my = y + dy * len * 0.42;
  const tx = x + dx * len, ty = y + dy * len;
  return 'M' + n(x, dp) + ' ' + n(y, dp) +
    'Q' + n(mx + nx * wid, dp) + ' ' + n(my + ny * wid, dp) + ' ' + n(tx, dp) + ' ' + n(ty, dp) +
    'Q' + n(mx - nx * wid, dp) + ' ' + n(my - ny * wid, dp) + ' ' + n(x, dp) + ' ' + n(y, dp) + 'Z';
}

/* ------------------------------------------------------------------ lamp */

/** Crown knob, flared skirt, bead clapper — hung from (x,y), u tall to the mouth.
    The reference draws these as five thin spikes; at page size that reads as a star, so the
    skirt is given a solid silhouette instead and the spikes are dropped. */
function bell(x: number, y: number, u: number, dp: number): string {
  const q = (a: number, b: number) => n(x + a * u, dp) + ' ' + n(y + b * u, dp);
  return 'M' + q(-0.17, 0) +
    'C' + q(-0.31, 0.44) + ' ' + q(-0.62, 0.64) + ' ' + q(-0.66, 1) +
    'Q' + q(0, 1.27) + ' ' + q(0.66, 1) +
    'C' + q(0.62, 0.64) + ' ' + q(0.31, 0.44) + ' ' + q(0.17, 0) + 'Z' +
    disc(x, y - 0.06 * u, 0.17 * u, dp) +
    disc(x, y + 1.31 * u, 0.19 * u, dp);
}

/** Two outriggers, kept short so the centre bell stays the thing you see first. */
const SIDE = [
  { dx: -1.25, dy: 0.52, bow: -0.8 },
  { dx: 1.25, dy: 0.52, bow: 0.8 },
];

/**
 * A hanging lamp, drawn from (0,0) at the cusp it hangs off, growing downward.
 * The stem is `drop` user units; only the bells take `scale`.
 */
export function lamp(o: LampOpts = {}): string {
  const dp = o.dp ?? 1;
  const drop = o.drop ?? 34;
  const u = 12 * (o.scale ?? 1);

  const neck = drop + u * 0.85;
  let stems = 'M0 0L0 ' + n(neck, dp);
  let bells = bell(0, neck, u, dp);
  for (const f of SIDE) {
    const ex = f.dx * u, ey = drop + f.dy * u;
    stems += 'M0 ' + n(drop, dp) +
      'Q' + n(f.bow * u, dp) + ' ' + n(drop + f.dy * u * 0.75, dp) +
      ' ' + n(ex, dp) + ' ' + n(ey, dp);
    bells += bell(ex, ey, u * 0.6, dp);
  }
  return '<g fill="none" stroke="var(--ink)" style="stroke-width:var(--line-hair)">' +
    '<path d="' + stems + '"/>' +
    '<path d="' + disc(0, drop, u * 0.12, dp) + bells + '" fill="var(--ink)" stroke="none"/>' +
    '</g>';
}

/* -------------------------------------------------------------- rosette */

/** The spandrel flower: cream petals outlined in ink, an accent eye, ink pips between the tips. */
export function spandrelRosette(o: RosetteOpts = {}): string {
  const dp = o.dp ?? 1;
  const r = o.r ?? 40;
  const petals = 8;
  let outer = '', inner = '', pips = '';
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * 2 * PI - PI / 2;
    outer += leaf(0, 0, a, r, r * 0.5, dp);
    inner += leaf(0, 0, a + PI / petals, r * 0.52, r * 0.2, dp);
    const b = a + PI / petals;
    pips += disc(Math.cos(b) * r * 0.86, Math.sin(b) * r * 0.86, r * 0.07, dp);
  }
  return '<g stroke="var(--ink)" style="stroke-width:var(--line-pen)" stroke-linejoin="round">' +
    '<path d="' + outer + '" fill="var(--band)"/>' +
    '<path d="' + inner + '" fill="var(--band)" style="stroke-width:var(--line-hair)"/>' +
    '<circle r="' + n(r * 0.3, dp) + '" fill="var(--band)"/>' +
    '<circle r="' + n(r * 0.13, dp) + '" fill="var(--accent)" style="stroke-width:var(--line-hair)"/>' +
    '<path d="' + pips + '" fill="var(--ink)" stroke="none"/>' +
    '</g>';
}

/* --------------------------------------------------------------- torana */

/** Every measurement `torana` works from. Shared with `toranaOpening` so the two cannot drift. */
function geom(o: ToranaOpts) {
  const { w, h } = o;
  /* The reference band is 0.026 of the field's width AND 0.05 of its height — the same 10px,
     because that field is 0.53 as tall as it is wide. Spanning a viewport at h≈0.30w the two
     disagree by 1.7x, and the width reading bloats the band, the pearls and everything keyed to
     them. Take the smaller: it is the measured value at the reference aspect and stays honest
     when the panel goes flat. */
  const bandW = o.bandW ?? Math.min(w * 0.026, h * 0.05);
  const spring = o.spring ?? h * 0.3;
  /* even only: an odd count puts a smooth maximum at θ=π/2 and domes the apex */
  const lobes = Math.max(2, 2 * Math.round((o.lobes ?? 4) / 2));

  /* reference: jamb inset = 3 band widths. That is a width; used as a head margin too it eats a
     quarter of the height once h drops to 0.30w, so the crown gets its own, smaller inset. */
  const padX = bandW * 3;
  const padY = Math.min(padX, h * 0.12);
  const baseY = h - spring;            // springing line
  const cx = w / 2;
  const k = (1 - FLAT) * (1 - PEAK);   // profile radius at the springings
  const rxOut = (cx - padX) / k;
  const ryOut = baseY - padY;
  const rxIn = rxOut - bandW / k;
  const ryIn = ryOut - bandW;
  const ts = angles(lobes, 400);
  const outer = sweep(cx, baseY, rxOut, ryOut, lobes, AMP, ts);
  const inner = sweep(cx, baseY, rxIn, ryIn, lobes, AMP, ts);

  /* Lamp scale is capped against the arch rise: at full-viewport width the band is twice as thick
     relative to the rise as it is in the reference, and a band-only scale hangs lamps halfway
     down the opening. */
  const lampU = Math.min(bandW * 0.62, ryIn * 0.085);
  const lampH = lampU * 3.69;          // foot lamp, stem included

  /* The jambs do not reach the bottom edge: in the reference they close in a rounded pendant foot
     with the pearl course running into it, and a tassel hangs below. */
  const footY = Math.max(baseY + bandW * 1.2, h - lampH - bandW * 0.15);

  return { w, h, bandW, lobes, padX, padY, baseY, cx, rxOut, ryOut, rxIn, ryIn, ts, outer, inner,
    lampU, footY, fr: bandW * 0.45 };
}

export interface ToranaOpening {
  cx: number;
  /** the springing line — below it the opening is a plain rectangle from x0 to x1 */
  baseY: number;
  /** inside faces of the two jambs */
  x0: number;
  x1: number;
  /** the highest point of the opening, under the apex */
  headTop: number;
  /** where the jambs close in their pendant feet */
  footY: number;
  /** The head's inner boundary, springing to springing. Given rather than summarised because
   *  the opening is cusped: its clearance is nowhere near its half-width, and the two upper
   *  cusps bind long before the widest point does. */
  edge: Array<[number, number]>;
}

/**
 * Where the arch's opening is, so a caller can put something inside it. Must be given the *same*
 * options as the `torana` call it describes — the two share their geometry rather than agreeing
 * on it, which is the only way a caller can place anything without restating the profile
 * constants.
 */
export function toranaOpening(o: ToranaOpts): ToranaOpening {
  const g = geom(o);
  let headTop = Infinity;
  for (const p of g.inner) if (p[1] < headTop) headTop = p[1];
  return { cx: g.cx, baseY: g.baseY, x0: g.padX + g.bandW, x1: o.w - g.padX - g.bandW, headTop,
    footY: g.footY, edge: g.inner };
}

/**
 * The whole arch: pearl band on foiled jambs that close in pendant feet, a creeper running the
 * whole outside from foot to foot, a rosette anchored on it in each spandrel, and lamps hanging
 * off every inner cusp. Returns a fragment — the caller supplies <svg viewBox="0 0 w h">.
 */
export function torana(o: ToranaOpts): string {
  const dp = o.dp ?? 1;
  const { w, h, bandW, lobes, padX, padY, baseY, cx, rxOut, ryOut, rxIn, ryIn, ts, outer, inner,
    lampU, footY, fr } = geom(o);
  const last = ts.length - 1;

  const band =
    'M' + n(padX, dp) + ' ' + n(footY - fr, dp) + pts(outer, dp) +
    'L' + n(w - padX, dp) + ' ' + n(footY - fr, dp) +
    'Q' + n(w - padX, dp) + ' ' + n(footY, dp) + ' ' + n(w - padX - fr, dp) + ' ' + n(footY, dp) +
    'L' + n(w - padX - bandW + fr, dp) + ' ' + n(footY, dp) +
    'Q' + n(w - padX - bandW, dp) + ' ' + n(footY, dp) +
    ' ' + n(w - padX - bandW, dp) + ' ' + n(footY - fr, dp) +
    pts(inner, dp, last, 0) +
    'L' + n(padX + bandW, dp) + ' ' + n(footY - fr, dp) +
    'Q' + n(padX + bandW, dp) + ' ' + n(footY, dp) + ' ' + n(padX + bandW - fr, dp) + ' ' + n(footY, dp) +
    'L' + n(padX + fr, dp) + ' ' + n(footY, dp) +
    'Q' + n(padX, dp) + ' ' + n(footY, dp) + ' ' + n(padX, dp) + ' ' + n(footY - fr, dp) + 'Z';

  // pearl course: band mid-line, running down into both feet
  const mid: Pt[] = [[padX + bandW / 2, footY - fr * 0.9]];
  for (let i = 0; i <= last; i++) {
    mid.push([(outer[i][0] + inner[i][0]) / 2, (outer[i][1] + inner[i][1]) / 2]);
  }
  mid.push([w - padX - bandW / 2, footY - fr * 0.9]);
  const pearlR = bandW * 0.24;
  let pearls = '';
  for (const s of walk(mid, pearlR * 2.1)) {
    pearls += '<ellipse cx="' + n(s.p[0], dp) + '" cy="' + n(s.p[1], dp) +
      '" rx="' + n(pearlR * 0.86, dp) + '" ry="' + n(pearlR, dp) +
      '" transform="rotate(' + n((s.a * 180) / PI, dp) + ' ' + n(s.p[0], dp) + ' ' + n(s.p[1], dp) +
      ')"/>';
  }

  /* creeper: one wheat-ear vine, offset outside the band, from the left foot over the crown to
     the right foot. It used to be three runs trimmed at the ends, which is what made it thin out
     and wander near the springing; a single run keeps one rhythm and stops on a bud. */
  const gap = bandW * 0.95;
  const vine = outset(sweep(cx, baseY, rxOut, ryOut, lobes, AMP * VINE_DAMP, ts), gap);
  const vTip = footY - fr * 0.4;
  const run: Pt[] = [[vine[0][0], vTip], ...vine, [vine[last][0], vTip]];

  /* the rosette is not free-floating in the reference: it sits on the creeper at the corner where
     the jamb run turns into the arch run, tucked against the band. Anchor it at the first vine
     station clear of the springing so it caps the corner instead of swallowing the jamb. */
  const rosR = Math.min(padX * 0.55, (baseY - padY) * 0.3);
  let ri = 0;
  while (ri < vine.length - 1 && vine[ri][1] > baseY - rosR * 1.25) ri++;
  const rosX = vine[ri][0], rosY = vine[ri][1];

  const leafLen = bandW * 0.8;
  const nodes = walk(run, leafLen * 0.5);
  let stemD = 'M' + n(nodes[0].p[0], dp) + ' ' + n(nodes[0].p[1], dp) +
    pts(nodes.map((q) => q.p), dp, 1);
  let leaves = '', dots = '';
  for (const s of nodes) {
    const dx = Math.min(Math.abs(s.p[0] - rosX), Math.abs(s.p[0] - (w - rosX)));
    if (Math.hypot(dx, s.p[1] - rosY) < rosR * 0.8) continue;
    const out = s.a - PI / 2;            // away from the field: up over the crown, out beside the jambs
    const side = s.i % 2 ? 0 : PI;       // leaves alternate across the stem
    leaves += leaf(s.p[0], s.p[1], out + side - 0.62, leafLen, leafLen * 0.34, dp);
    if (s.i % 6 === 2) dots += disc(s.p[0] + Math.cos(out) * leafLen * 1.15,
      s.p[1] + Math.sin(out) * leafLen * 1.15, bandW * 0.085, dp);
  }
  // both ends stop on a bud rather than fading out mid-stroke
  for (const e of [nodes[0], nodes[nodes.length - 1]]) {
    const away = e === nodes[0] ? e.a + PI : e.a;
    leaves += leaf(e.p[0], e.p[1], away, leafLen * 0.75, leafLen * 0.3, dp);
    dots += disc(e.p[0] + Math.cos(away) * leafLen * 0.9,
      e.p[1] + Math.sin(away) * leafLen * 0.9, leafLen * 0.17, dp);
  }

  // lamps at every inner cusp, mirrored about the apex by construction
  let lamps = '';
  for (let j = 0; j < lobes; j++) {
    const phi = (PI / 2 + j * PI) / lobes;
    const t = unwarp(phi);
    if (t <= 0.02 || t >= PI - 0.02) continue;
    const r = profile(t, lobes, AMP);
    const x = cx + rxIn * r * Math.cos(t);
    const y = baseY - ryIn * r * Math.sin(t);
    // rank counts outward from the apex, so the two halves get matched drops
    const rank = Math.round((Math.abs(phi - PI / 2) * lobes) / PI - 0.5);
    lamps += '<g transform="translate(' + n(x, dp) + ' ' + n(y, dp) + ')">' +
      lamp({ drop: lampU * 1.5 * (1 + 0.18 * rank), scale: lampU / 12, dp }) + '</g>';
  }
  // and one under each foot, as the reference hangs beneath the jamb terminal
  const footLamp = lamp({ drop: lampU * 1.2, scale: lampU / 12, dp });
  for (const fx of [padX + bandW / 2, w - padX - bandW / 2]) {
    lamps += '<g transform="translate(' + n(fx, dp) + ' ' + n(footY, dp) + ')">' + footLamp + '</g>';
  }

  const rosette = spandrelRosette({ r: rosR, dp });

  return '<g class="torana">' +
    '<g fill="var(--ink)" stroke="var(--ink)" stroke-linejoin="round" ' +
    'style="stroke-width:var(--line-pen)">' +
    '<path d="' + stemD + '" fill="none" style="stroke-width:var(--line-hair)"/>' +
    '<path d="' + leaves + '" stroke="none"/>' +
    '<path d="' + dots + '" stroke="none"/>' +
    '<path d="' + band + '" fill-rule="evenodd"/>' +
    '<g fill="var(--band)" stroke="none">' + pearls + '</g>' +
    '</g>' +
    lamps +
    '<g transform="translate(' + n(rosX, dp) + ' ' + n(rosY, dp) + ')">' + rosette + '</g>' +
    '<g transform="translate(' + n(w - rosX, dp) + ' ' + n(rosY, dp) + ') scale(-1 1)">' +
    rosette + '</g>' +
    '</g>';
}
