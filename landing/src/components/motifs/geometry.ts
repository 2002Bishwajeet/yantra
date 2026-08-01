/** Half-ellipse whose radius is modulated by `1 - amp·|sin(lobes·th)|` to produce a multifoil.
 *
 * `lobes` must be EVEN: `|sin(N·th)|` then vanishes at th = 0, PI/2, PI, putting a cusp at both
 * springings and at the apex. An odd N scoops the apex into a dome instead.
 * `h` is carried for callers that normalise against it; the curve itself never uses it. */
export function archPoints(opts: {
  w: number;
  h: number;
  spring: number;
  lobes: number;
  inset: number;
  amp?: number;
}): Array<[number, number]> {
  const { w, spring, lobes, inset, amp = 0 } = opts;
  const cx = w / 2;
  const rx = w / 2 - 6;
  const ry = spring - 14;

  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= 400; i++) {
    const th = Math.PI * (1 - i / 400);
    const k = 1 - amp * Math.abs(Math.sin(lobes * th));
    pts.push([
      cx + Math.cos(th) * (rx - inset) * k,
      spring - Math.sin(th) * (ry - inset) * k,
    ]);
  }
  return pts;
}

/** `dp` is raised by callers working in objectBoundingBox units, where 2dp quantises the
 * curve to 1% of the box and the arch visibly stair-steps. */
export function toPath(pts: Array<[number, number]>, dp = 2): string {
  return pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(dp)} ${y.toFixed(dp)}`)
    .join(' ');
}
