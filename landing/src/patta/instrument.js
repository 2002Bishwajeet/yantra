/* The Jai Prakash Yantra: a hemispherical bowl sunk in the ground, its rim ruled with
   azimuth lines and its interior with declination circles. A crosswire is stretched across
   the mouth, and the shadow of its centre bead falls somewhere in the bowl — you read the
   sun's position off where it lands.
 *
 * Chosen over the Samrat Yantra because a torana niche is TALL and a Samrat gnomon is a long
 * shallow ramp: at latitude 26.9 the heel lands ~2x the height away, which is why it overran
 * the frame in every earlier sketch. A bowl is round, so it sits in a niche without fighting it.
 *
 * Pure: returns an SVG string. Colour comes from custom properties only. */

const TAU = Math.PI * 2;
const r2 = (n) => Math.round(n * 100) / 100;

/** Solar position, good enough to place a bead — this is a landing page, not an almanac.
 *  Returns altitude/azimuth in degrees, and `up` false when the sun is below the horizon. */
export function sunPosition(date, latDeg, lonDeg) {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const day = (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 864e5;
  const decl = -23.44 * Math.cos(rad * (360 / 365) * (day + 10));
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const solarH = utcH + lonDeg / 15;
  const ha = (solarH - 12) * 15;
  const sinAlt = Math.sin(rad * decl) * Math.sin(rad * latDeg)
               + Math.cos(rad * decl) * Math.cos(rad * latDeg) * Math.cos(rad * ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / rad;
  const cosAz = (Math.sin(rad * decl) - Math.sin(rad * alt) * Math.sin(rad * latDeg))
              / (Math.cos(rad * alt) * Math.cos(rad * latDeg) || 1e-6);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / rad;
  if (ha > 0) az = 360 - az;
  return { alt, az, ha, decl, up: alt > 0 };
}

/**
 * @param {object} o
 * @param {number} o.r        outer radius of the bowl mouth
 * @param {Date}   o.now
 * @param {number} o.lat      site latitude, degrees north
 * @param {number} o.lon      site longitude, degrees east
 */
export function jaiPrakash(o) {
  const R = o.r;
  const { alt, az, up } = sunPosition(o.now, o.lat, o.lon);
  const p = [];

  // The bowl. Filled with the cream, not the cloth: a bowl the same colour as the field it is
  // sunk in has no edge except its outline, and the bead needs a lighter ground to fall on.
  p.push(`<circle cx="0" cy="0" r="${r2(R)}" fill="var(--band)" stroke="var(--ink)" stroke-width="var(--line-rule)"/>`);

  // Declination circles: concentric, unevenly spaced because they are a projection of
  // equal angular steps onto a hemisphere — even spacing would be the giveaway that this
  // is decoration rather than a scale.
  for (let a = 15; a < 90; a += 15) {
    const rr = R * Math.cos(a * Math.PI / 180);
    p.push(`<circle cx="0" cy="0" r="${r2(rr)}" fill="none" stroke="var(--ink)" stroke-width="var(--line-pen)" opacity=".62"/>`);
  }

  // Azimuth rays every 15° (one hour of rotation), with the cardinals drawn heavier.
  for (let i = 0; i < 24; i++) {
    const th = (i * 15) * Math.PI / 180;
    const card = i % 6 === 0;
    const r0 = card ? 0 : R * 0.62;
    p.push(`<line x1="${r2(Math.cos(th) * r0)}" y1="${r2(Math.sin(th) * r0)}"`
         + ` x2="${r2(Math.cos(th) * R)}" y2="${r2(Math.sin(th) * R)}"`
         + ` stroke="var(--ink)" stroke-width="${card ? 'var(--line-pen)' : 'var(--line-hair)'}"`
         + ` opacity="${card ? .92 : .5}"/>`);
  }

  // Graduated rim.
  for (let i = 0; i < 72; i++) {
    const th = (i * 5) * Math.PI / 180;
    const r0 = R * (i % 3 === 0 ? 0.945 : 0.968);
    p.push(`<line x1="${r2(Math.cos(th) * r0)}" y1="${r2(Math.sin(th) * r0)}"`
         + ` x2="${r2(Math.cos(th) * R)}" y2="${r2(Math.sin(th) * R)}"`
         + ` stroke="var(--ink)" stroke-width="var(--line-pen)" opacity=".78"/>`);
  }
  p.push(`<circle cx="0" cy="0" r="${r2(R * 0.945)}" fill="none" stroke="var(--ink)" stroke-width="var(--line-pen)" opacity=".78"/>`);

  // The crosswire across the mouth, and its centre bead.
  p.push(`<line x1="${r2(-R)}" y1="0" x2="${r2(R)}" y2="0" stroke="var(--lac)" stroke-width="var(--line-pen)" opacity=".95"/>`);
  p.push(`<line x1="0" y1="${r2(-R)}" x2="0" y2="${r2(R)}" stroke="var(--lac)" stroke-width="var(--line-pen)" opacity=".95"/>`);

  if (up) {
    // Bead shadow: azimuth sets the bearing, altitude how far in from the rim. At the
    // horizon it sits on the rim; at the zenith it sits under the bead at the centre.
    const rr = R * Math.cos(alt * Math.PI / 180);
    const th = (az - 90) * Math.PI / 180;
    const x = r2(Math.cos(th) * rr), y = r2(Math.sin(th) * rr);
    p.push(`<circle cx="${x}" cy="${y}" r="${r2(R * 0.055)}" fill="var(--kalam)" opacity=".9"/>`);
    // Ringed in lac, not orpiment: yellow on the cream bowl is barely a mark, and the one
    // thing on the instrument that changes is the one thing that should carry the hot colour.
    p.push(`<circle cx="${x}" cy="${y}" r="${r2(R * 0.105)}" fill="none" stroke="var(--accent)" stroke-width="var(--line-pen)"/>`);
  } else {
    // Night. The instrument does not invent a reading it cannot take — the bowl simply
    // sits empty, which is what it does, and the bead is drawn unlit.
    p.push(`<circle cx="0" cy="0" r="${r2(R * 0.045)}" fill="none" stroke="var(--ink)" stroke-width="var(--line-pen)" opacity=".55"/>`);
  }

  p.push(`<circle cx="0" cy="0" r="${r2(R * 0.018)}" fill="var(--lac)"/>`);
  return p.join('');
}
