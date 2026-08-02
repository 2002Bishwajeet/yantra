/* Pattachitra border, generated from the Nabagunjara patta's outer band.
 *
 * What the reference actually shows, cell by cell (nabagunjara.jpg, top/left/bottom bands,
 * cell pitch ~36 px, measured at 900–1600% nearest-neighbour):
 *   - a modular grid of square cells, ONE cell deep, each boxed by its own heavy black rule
 *     with a ~2 px cream gutter between neighbours, so the run reads as a continuous ruled grid;
 *   - four DOMINANT petals on the DIAGONALS, reaching the cell corners: rounded almonds with
 *     blunt outer ends, cream, black-outlined, each carrying one muted brick-rose lac almond
 *     in its outer half;
 *   - four SMALL leaves on the AXES, tucked in the gaps between petals at the edge midpoints —
 *     roughly a fifth of a petal's area, never a second set of points;
 *   - the ground the petals sit on is black; it survives only as narrow wedges along the four
 *     axes, which is where the cell's ~35% dark comes from;
 *   - a small orpiment lozenge at the centre;
 *   - inside the band, a double rule (cell rule, cream gap, heavy rule) and then the cloth.
 *     There is NO creeper/vine band anywhere in this border — see the note on borderFrame.
 *
 * Every shape below is derived from `size`; there is no hand-authored path data anywhere.
 * Colour is exclusively CSS custom properties from tokens.css.
 */

type Variant = 0 | 1;

const f = (n: number): string => (Math.round(n * 1000) / 1000).toString();

/** Unit vector / perpendicular for an angle in degrees (0 = +x, clockwise in SVG space). */
function dir(deg: number): [number, number, number, number] {
  const r = (deg * Math.PI) / 180;
  const ux = Math.cos(r);
  const uy = Math.sin(r);
  return [ux, uy, -uy, ux];
}

/** Catmull-Rom through `pts`, emitted as cubics. Ends are clamped, so a repeated first/last
 *  point stays a corner — which is how an almond keeps its point at the flower's centre. */
function spline(pts: Array<[number, number]>): string {
  const at = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + 'Z';
}

/**
 * One closed almond, symmetric about the axis `deg`: a point at r0, swelling to `halfW` at
 * `bulge` of the way out, then a rounded cap of radius halfW*`blunt` closing it at r1.
 *
 * The width is a beta profile w(t) ∝ t^A (1-t)^B rather than a pair of Béziers aimed at the tip.
 * That is the whole fix over the previous teardrop: a Bézier pulled towards its endpoint always
 * arrives as a spike and the cell read as thorns, whereas this profile leaves the point, opens
 * smoothly, and is truncated by a real circular cap. `blunt` 0.5 is the reference's petal.
 * The shape never reaches past r1 along its own axis, so r1 alone bounds it.
 */
function almond(
  cx: number,
  cy: number,
  deg: number,
  r0: number,
  r1: number,
  halfW: number,
  blunt = 0.5,
  bulge = 0.55,
  sharp = 0.62,
): string {
  const [ux, uy, px, py] = dir(deg);
  const at = (r: number, o: number): [number, number] => [cx + ux * r + px * o, cy + uy * r + py * o];
  const A = sharp;
  const B = (A * (1 - bulge)) / bulge; // puts the widest point exactly at t = bulge
  const w = (t: number) => (t / bulge) ** A * ((1 - t) / (1 - bulge)) ** B;

  const rho = halfW * blunt;
  // where the profile has narrowed to the cap radius: that is where the cap takes over
  let lo = bulge;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const t = (lo + hi) / 2;
    if (w(t) > blunt) lo = t;
    else hi = t;
  }
  const tE = (lo + hi) / 2;
  const rc = r1 - rho;
  const span = rc - r0;

  const N = 6;
  const side: Array<[number, number]> = [];
  for (let i = 1; i <= N; i++) {
    const t = (tE * i) / N;
    side.push([r0 + (span * t) / tE, halfW * w(t)]);
  }
  const cap: Array<[number, number]> = [];
  for (let i = 1; i <= 4; i++) {
    const th = (Math.PI * i) / 5;
    cap.push([rc + rho * Math.sin(th), rho * Math.cos(th)]);
  }

  const pts: Array<[number, number]> = [[r0, 0]];
  for (const [u, v] of side) pts.push([u, v]);
  for (const [u, v] of cap) pts.push([u, v]);
  for (let i = side.length - 1; i >= 0; i--) pts.push([side[i][0], -side[i][1]]);
  pts.push([r0, 0]);

  return spline(pts.map(([u, v]) => at(u, v)));
}

/**
 * The rosette that fills a cell: four dominant almond petals plus four small axial leaves, on a
 * black ground. Returns markup only, no wrapper.
 *
 * The ground is painted ink and the petals are cream shapes cut out of it — not outlines on
 * cream. That is what the photograph shows, and it is also what keeps the cell near the
 * reference's dark fraction: the surviving black is exactly the four wedges along the axes.
 */
function rosette(size: number, spin: number): string {
  const c = size / 2;
  // Each family is sized against the room available in its own direction — corner-ward lobes get
  // the half-diagonal, edge-ward lobes the half-side — so spinning cannot make a lobe overshoot.
  const diag = size * Math.SQRT1_2;
  const side = size * 0.5;
  const pMax = spin === 0 ? diag : side; // petals
  const lMax = spin === 0 ? side : diag; // leaves

  const r0 = size * 0.02;
  // the petals run all the way to the cell's corners, so along the edges they are cut off square
  // by cell()'s viewport — the reference's petals do the same against the rule.
  const pR1 = pMax;
  const pW = pMax * 0.37;
  const lR0 = lMax * 0.58;
  const lR1 = lMax;
  const lW = lMax * 0.125;
  // the lac sits in the petal's outer half and is a scaled copy of it, so the drop reads as the
  // same almond seen twice rather than as a foreign shape dropped inside a flower.
  const dR0 = r0 + (pR1 - r0) * 0.34;
  const dR1 = r0 + (pR1 - r0) * 0.82;
  const dW = pW * 0.32;

  let cream = '';
  let lac = '';
  for (let k = 0; k < 4; k++) {
    const a = spin + 90 * k;
    cream +=
      `<path d="${almond(c, c, a + 45, r0, pR1, pW, 0.5, 0.6, 0.65)}"/>` +
      `<path d="${almond(c, c, a, lR0, lR1, lW, 0.45, 0.55)}"/>`;
    lac += `<path d="${almond(c, c, a + 45, dR0, dR1, dW, 0.4, 0.55)}"/>`;
  }

  return (
    `<rect width="${f(size)}" height="${f(size)}" fill="var(--ink)"/>` +
    `<g fill="var(--band)" stroke="var(--ink)" stroke-width="var(--line-pen)" ` +
    `stroke-linejoin="round">${cream}</g>` +
    `<g fill="var(--lac-rose)" stroke="var(--ink)" stroke-width="var(--line-hair)">${lac}</g>` +
    lozenge(c, c, size * 0.062, 'var(--haritala)')
  );
}

/** The orpiment pip at the centre of a cell, and the lac pips of the corner panel. */
function lozenge(cx: number, cy: number, d: number, fill: string): string {
  return (
    `<path d="M${f(cx)} ${f(cy - d)}L${f(cx + d)} ${f(cy)}L${f(cx)} ${f(cy + d)}L${f(cx - d)} ${f(cy)}Z" ` +
    `fill="${fill}" stroke="var(--ink)" stroke-width="var(--line-hair)"/>`
  );
}

/**
 * The ruled panel a rosette sits in, inset so a hair of band ground is left between neighbouring
 * cells. In the reference the box is a heavy rule — at a 36 px pitch it measures ~2 px of black
 * either side of a ~2 px cream gutter — so it takes --line-rule, not --line-pen, and the frame
 * goes on top of the rosette so nothing eats into it.
 */
const GUTTER = 0.06;

function cell(size: number, inner: string): string {
  const g = size * GUTTER;
  const s = size - 2 * g;
  const box = `x="${f(g)}" y="${f(g)}" width="${f(s)}" height="${f(s)}"`;
  // a nested <svg> rather than a transform: it establishes a viewport, so it clips. The petals
  // are drawn oversize and the box cuts them, which is what the painter did — the reference's
  // petals run flat into the rule instead of tapering away from it, and no id is needed to say so.
  return (
    `<g>` +
    `<rect width="${f(size)}" height="${f(size)}" fill="var(--band)"/>` +
    `<svg ${box} viewBox="0 0 ${f(size)} ${f(size)}" preserveAspectRatio="none">${inner}</svg>` +
    `<rect ${box} fill="none" stroke="var(--ink)" stroke-width="var(--line-rule)"/>` +
    `</g>`
  );
}

/**
 * One border cell, origin 0,0, ready to drop inside a <symbol>.
 * variant 0 is the reference tile; variant 1 spins the rosette 45° (lac petals on the axes)
 * for callers who want an alternating rhythm — the reference itself does not alternate.
 */
export function floretTile(o: { size?: number; variant?: Variant } = {}): string {
  const s = o.size ?? 46;
  return cell(s, rosette(s, (o.variant ?? 0) === 1 ? 45 : 0));
}

/**
 * The corner cell: the same rosette, boxed by a second rule with four lac lozenges set in the
 * margin between the two.
 *
 * NOT USED BY borderFrame, and not in the reference. All four corners of the Nabagunjara border
 * are ordinary florets belonging to the horizontal run; this export is an invention kept only
 * because a page imports it. Reach for it deliberately or not at all.
 */
export function cornerPanel(o: { size?: number } = {}): string {
  const s = o.size ?? 46;
  const m = s * 0.11;   // margin between the cell's rule and the inner rule
  const d = s * 0.036;  // half-diagonal of each lozenge, set in the margin's corners

  let lozenges = '';
  for (let k = 0; k < 4; k++) {
    const cx = k === 0 || k === 3 ? m / 2 : s - m / 2;
    const cy = k < 2 ? m / 2 : s - m / 2;
    lozenges += lozenge(cx, cy, d, 'var(--lac-rose)');
  }

  const rule =
    `<rect x="${f(m)}" y="${f(m)}" width="${f(s - 2 * m)}" height="${f(s - 2 * m)}" fill="none" ` +
    `stroke="var(--ink)" stroke-width="var(--line-pen)"/>`;
  const k = (s - 2 * m) / s;

  return cell(
    s,
    lozenges + `<g transform="translate(${f(m)} ${f(m)}) scale(${f(k)})">${rosette(s, 0)}</g>` + rule,
  );
}

/**
 * The full four-edge frame, corners included, sized to w × h.
 *
 * REMAINDER: the run between two corners is never left with a half-tile. Each run is divided
 * by a whole cell count n = max(1, round(run / tile)) and then every cell on that run gets
 * exactly run / n. The leftover is therefore spread evenly across the whole edge instead of
 * being dumped next to a corner: the worst-case distortion is tile / (2n), i.e. under 3% for a
 * 900×1200 frame at tile 46. Horizontal and vertical runs are quantised independently, so a
 * top cell and a side cell can differ by a couple of percent in one dimension — far less than
 * the hand-painted reference varies. The tile is stretched, not clipped, via
 * preserveAspectRatio="none" on its <symbol>.
 *
 * NO CREEPER BAND. The floret row is the whole border: outside it a single pen rule, inside it a
 * cream gap and one heavy rule, then the cloth. The leafy vine visible above the arch in the
 * photograph is the arch's own spandrel foliage — it curls out of the arch's springing points and
 * is absent from the left, right and bottom edges. Cropping the top edge tightly makes it look
 * like a second band; it is not one.
 */
export function borderFrame(o: { w: number; h: number; band?: number; tile?: number }): string {
  const { w, h } = o;
  const tile = o.tile ?? 46;
  const band = o.band ?? tile;

  // ids carry the geometry so two frames with different parameters cannot collide,
  // while two identical frames on one page harmlessly share one definition.
  const key = `${f(tile)}`;
  const idT = `patta-floret-${key}`;

  const sym = (id: string, body: string) =>
    `<symbol id="${id}" viewBox="0 0 ${f(tile)} ${f(tile)}" preserveAspectRatio="none">${body}</symbol>`;

  const defs = `<defs>${sym(idT, floretTile({ size: tile }))}</defs>`;

  const runW = Math.max(0, w - 2 * band);
  const runH = Math.max(0, h - 2 * band);
  const nW = Math.max(1, Math.round(runW / tile));
  const nH = Math.max(1, Math.round(runH / tile));
  const cw = runW / nW;
  const ch = runH / nH;

  // Cells are placed upright on the top edge and rotated a quarter turn per edge, so the
  // tile's own x-axis always runs *along* the edge — which is what keeps the stretch uniform
  // on all four sides. (The rosette is four-fold symmetric, so the rotation is invisible; it
  // is here because the stretch axis, not the motif, has to follow the edge.)
  const use = (id: string, x: number, y: number, ww: number, hh: number, quarter: number) => {
    const t =
      quarter === 0
        ? `translate(${f(x)} ${f(y)})`
        : quarter === 1
          ? `translate(${f(x + ww)} ${f(y)}) rotate(90)`
          : quarter === 2
            ? `translate(${f(x + ww)} ${f(y + hh)}) rotate(180)`
            : `translate(${f(x)} ${f(y + hh)}) rotate(270)`;
    const uw = quarter % 2 === 0 ? ww : hh;
    const uh = quarter % 2 === 0 ? hh : ww;
    return `<g transform="${t}"><use href="#${id}" x="0" y="0" width="${f(uw)}" height="${f(uh)}"/></g>`;
  };

  let cells = '';
  for (let i = 0; i < nW; i++) {
    const x = band + i * cw;
    cells += use(idT, x, 0, cw, band, 0);
    cells += use(idT, x, h - band, cw, band, 2);
  }
  for (let i = 0; i < nH; i++) {
    const y = band + i * ch;
    cells += use(idT, 0, y, band, ch, 3);
    cells += use(idT, w - band, y, band, ch, 1);
  }

  // the reference has no special corner: each corner is an ordinary floret, and it belongs to
  // the horizontal run, which is why the top and bottom rows are two cells longer than the sides.
  const corners =
    use(idT, 0, 0, band, band, 0) +
    use(idT, w - band, 0, band, band, 0) +
    use(idT, w - band, h - band, band, band, 0) +
    use(idT, 0, h - band, band, band, 0);

  // band ground: a cream ring under the cells, so the ruled gaps read as --shankha
  const ring =
    `<path fill="var(--band)" fill-rule="evenodd" d="M0 0H${f(w)}V${f(h)}H0Z` +
    `M${f(band)} ${f(band)}H${f(w - band)}V${f(h - band)}H${f(band)}Z"/>`;

  // the double rule that parts the band from the cloth: heavy inner line, cream gap,
  // then the cells' own pen-weight edge supplies the thin outer line.
  const gap = band * 0.11;
  const inner =
    `<rect x="${f(band + gap)}" y="${f(band + gap)}" width="${f(w - 2 * (band + gap))}" ` +
    `height="${f(h - 2 * (band + gap))}" fill="none" stroke="var(--ink)" stroke-width="var(--line-rule)"/>`;

  // the band's outer edge is one unbroken rule in the reference, not the cells' own boxes
  const outer =
    `<rect x="1" y="1" width="${f(w - 2)}" height="${f(h - 2)}" fill="none" ` +
    `stroke="var(--ink)" stroke-width="var(--line-pen)"/>`;

  return `<g class="patta-frame">${defs}${ring}${cells}${corners}${outer}${inner}</g>`;
}
