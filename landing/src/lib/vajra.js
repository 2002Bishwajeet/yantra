/* The vajra, as pixels. This is the texture Displacement shears, so it is painted into a 2D
   canvas rather than drawn as SVG: the shader wants an image, and the shear reads as metal only
   if what it shears has hard cell edges. Grid and ink are the owner's prototype, unchanged. */

const GRID_W = 27;

/** One row of the sprite: segments written into a blank 27-cell line. */
function row(segments) {
  const cells = new Array(GRID_W).fill('.');
  segments.forEach(([at, body]) => {
    for (let i = 0; i < body.length; i++) cells[at + i] = body[i];
  });
  return cells.join('');
}

const HEAD = [
  row([[7, 'hh'], [12, 'hhh'], [18, 'hh']]),
  row([[7, 'mh'], [12, 'mhh'], [18, 'mh']]),
  row([[7, 'mh'], [12, 'mhh'], [18, 'mh']]),
  row([[7, 'mh'], [12, 'mhh'], [18, 'mh']]),
  row([[7, 'mh'], [12, 'mhh'], [18, 'mh']]),
  row([[7, 'mh'], [12, 'mhh'], [18, 'mh']]),
  row([[6, 'kmh'], [12, 'mhh'], [18, 'mhk']]),
  row([[6, 'kmh'], [12, 'mhh'], [18, 'mhk']]),
  row([[8, 'kmh'], [12, 'mhh'], [16, 'hmk']]),
  row([[9, 'kmmhhhmmk']]),
  row([[5, 'kmmmmhhhhhhhmmmmk']]),
  row([[5, 'kmmmmhhhhhhhmmmmk']]),
  row([[7, 'kmmmhhhhhmmmk']]),
  row([[8, 'kmmhhhhhmmk']]),
  row([[9, 'kmhhhhhmk']]),
  row([[10, 'kmhhhmk']]),
];

const SHAFT = Array.from({ length: 34 }, () => row([[10, 'kdmhmdk']]));

const POINT = [
  row([[8, 'kddmmhmmddk']]),
  row([[6, 'kddmmmhhhmmmddk']]),
  row([[5, 'kddmmmhhhhhmmmddk']]),
  row([[6, 'kddmmmhhhmmmddk']]),
  row([[8, 'kddmmhmmddk']]),
  row([[10, 'kdmhmdk']]),
  row([[11, 'kmhmk']]),
  row([[12, 'khk']]),
  row([[13, 'h']]),
];

const ROWS = [...HEAD, ...SHAFT, ...POINT];

/* The bolt: a triangle wave from col 8 in to col 5, one column per row, so consecutive pixels
   always touch. Three segments, one per beat. */
const BOLT = (() => {
  const wave = [8, 7, 6, 5, 6, 7];
  const out = [];
  for (let y = 18; y <= 47; y++) {
    out.push([y, wave[(y - 18) % wave.length], y < 28 ? 0 : y < 38 ? 1 : 2]);
  }
  return out;
})();

const INK = { h: '#F2E1B8', g: '#D6C59E', m: '#A8935F', d: '#7A6A45', k: '#4A3F27' };

/** Paint the sprite, lit as far as `beat`. A beat of -1 leaves the bolt dark. */
export function drawVajra(ctx, w, h, accent, beat) {
  const cell = Math.min(w / (GRID_W + 8), h / (ROWS.length + 6));
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((-24 * Math.PI) / 180);
  ctx.translate((-GRID_W * cell) / 2, (-ROWS.length * cell) / 2);
  ROWS.forEach((line, y) => {
    for (let x = 0; x < GRID_W; x++) {
      const ch = line[x];
      if (!ch || ch === '.') continue;
      ctx.fillStyle = INK[ch] || INK.g;
      ctx.fillRect(Math.round(x * cell), Math.round(y * cell), Math.ceil(cell), Math.ceil(cell));
    }
  });
  BOLT.forEach(([y, x, segment], i) => {
    if (segment > beat) return;
    [x, GRID_W - 1 - x].forEach((cx, side) => {
      ctx.fillStyle = i % 3 === 0 ? '#FFD9C2' : side === 0 ? accent : '#F59B78';
      ctx.fillRect(Math.round(cx * cell), Math.round(y * cell), Math.ceil(cell), Math.ceil(cell));
    });
  });
  ctx.restore();
}
