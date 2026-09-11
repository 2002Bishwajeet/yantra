/**
 * The colour engine behind Appearance's seed picker. ADR-0024 §2: this module
 * is reached by `import()` only, never from tokens.css or the `/` chunk, because
 * the brass scheme is already precomputed there and the engine is 20 kB gzip.
 */
import {
  DynamicScheme,
  Hct,
  SchemeExpressive,
  TonalPalette,
  Variant,
  argbFromHex,
  hexFromArgb,
} from '@material/material-color-utilities'

export const SAGE = '#48674B'
export const BRASS = '#C49A52'

// Y-383: the owner's dark palette, verbatim. docs/design/palette-brass.json
// records it beside the scheme scripts/brass.mjs builds from it.
export const OWNER = {
  charcoal: '#151714',
  surface: '#1D201B',
  elevated: '#25231C',
  ivory: '#E8E2D0',
  parchment: '#B7AF99',
  terracotta: '#C96843',
  ember: '#D77A4E',
  brass: BRASS,
  green: '#718565',
  ochre: '#B58A43',
  vermilion: '#A94B3D',
  bronze: '#38352B',
}

export const roles = [
  'primary',
  'on-primary',
  'primary-container',
  'on-primary-container',
  'primary-fixed',
  'primary-fixed-dim',
  'on-primary-fixed',
  'on-primary-fixed-variant',
  'inverse-primary',
  'secondary',
  'on-secondary',
  'secondary-container',
  'on-secondary-container',
  'secondary-fixed',
  'secondary-fixed-dim',
  'on-secondary-fixed',
  'on-secondary-fixed-variant',
  'tertiary',
  'on-tertiary',
  'tertiary-container',
  'on-tertiary-container',
  'tertiary-fixed',
  'tertiary-fixed-dim',
  'on-tertiary-fixed',
  'on-tertiary-fixed-variant',
  'error',
  'on-error',
  'error-container',
  'on-error-container',
  'surface',
  'surface-dim',
  'surface-bright',
  'surface-container-lowest',
  'surface-container-low',
  'surface-container',
  'surface-container-high',
  'surface-container-highest',
  'on-surface',
  'surface-variant',
  'on-surface-variant',
  'inverse-surface',
  'inverse-on-surface',
  'outline',
  'outline-variant',
  'shadow',
  'scrim',
  'surface-tint',
  'background',
  'on-background',
] as const

export type Role = (typeof roles)[number]
export type Scheme = Record<Role, string>

const getter = (role: Role) =>
  role.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

// R14 §2.3: sage is no stock variant. These five pairs were fitted to
// palette-sage.json (fit.txt in the Y-338 PR); the tertiary group still lands
// 6 to 13 hex units away because the file's tertiary sits at tone 45, not 40.
function sage(dark: boolean) {
  return new DynamicScheme({
    sourceColorHct: Hct.fromInt(argbFromHex(SAGE)),
    variant: Variant.TONAL_SPOT,
    contrastLevel: 0,
    isDark: dark,
    primaryPalette: TonalPalette.fromHueAndChroma(148.95, 23.7),
    secondaryPalette: TonalPalette.fromHueAndChroma(146.7, 15.5),
    tertiaryPalette: TonalPalette.fromHueAndChroma(88, 19.5),
    neutralPalette: TonalPalette.fromHueAndChroma(145.7, 5.25),
    neutralVariantPalette: TonalPalette.fromHueAndChroma(146.2, 7.5),
  })
}

const hct = (hex: string) => Hct.fromInt(argbFromHex(hex))
const from = (hex: string, chroma?: number) =>
  TonalPalette.fromHueAndChroma(hct(hex).hue, chroma ?? hct(hex).chroma)
const tone = (palette: TonalPalette, t: number) => hexFromArgb(palette.tone(t)).toUpperCase()

// The neutrals take the ivory's hue, not the charcoal's: at tone 95 the
// charcoal's green reads as sage again, and the light ground is meant to be ivory.
const palettes = {
  primary: from(OWNER.terracotta),
  quiet: from(OWNER.brass, 10),
  secondary: from(OWNER.brass),
  tonal: from(OWNER.brass, 22),
  aged: from(OWNER.brass, 16),
  tertiary: from(OWNER.green),
  neutral: from(OWNER.ivory, 6),
  neutralVariant: from(OWNER.bronze, 8),
  error: from(OWNER.vermilion),
  ochre: from(OWNER.ochre),
}

function brass(dark: boolean) {
  return new DynamicScheme({
    sourceColorHct: hct(BRASS),
    variant: Variant.TONAL_SPOT,
    contrastLevel: 0,
    isDark: dark,
    primaryPalette: palettes.primary,
    secondaryPalette: palettes.secondary,
    tertiaryPalette: palettes.tertiary,
    neutralPalette: palettes.neutral,
    neutralVariantPalette: palettes.neutralVariant,
    errorPalette: palettes.error,
  })
}

// Terracotta is an accent. The hero cards are primary-container and are the
// largest thing on a page, so they are brass at low chroma, not terracotta.
function pinned(dark: boolean): Partial<Scheme> {
  const { primary, quiet, secondary, tonal, tertiary, neutral, neutralVariant } = palettes
  if (dark) {
    return {
      background: OWNER.charcoal,
      surface: OWNER.charcoal,
      'surface-dim': OWNER.charcoal,
      'surface-container-lowest': tone(neutral, 4),
      'surface-container-low': tone(neutral, 9),
      'surface-container': OWNER.surface,
      'surface-container-high': OWNER.elevated,
      'surface-container-highest': tone(neutral, 18),
      'surface-bright': tone(neutral, 20),
      'surface-variant': tone(neutralVariant, 25),
      'on-surface': OWNER.ivory,
      'on-background': OWNER.ivory,
      'on-surface-variant': OWNER.parchment,
      'outline-variant': OWNER.bronze,
      // #C96843 is 4.35:1 as text on `surface-container`; the owner's hover is 5.3:1.
      primary: OWNER.ember,
      'surface-tint': OWNER.ember,
      'on-primary': tone(primary, 15),
      // A card on these two carries primary text buttons (the hero, the unclaimed
      // sessions), and #D77A4E needs a background at tone 17 or darker for 4.5:1.
      'primary-container': tone(quiet, 17),
      'on-primary-container': tone(primary, 90),
      'tertiary-container': tone(tertiary, 17),
      secondary: OWNER.brass,
      'secondary-container': tone(tonal, 30),
      'on-secondary-container': tone(secondary, 90),
    }
  }
  return {
    background: tone(neutral, 95),
    surface: tone(neutral, 95),
    'surface-bright': tone(neutral, 97),
    'surface-dim': tone(neutral, 87),
    'surface-container-lowest': tone(neutral, 98),
    'surface-container-low': tone(neutral, 93),
    'surface-container': tone(neutral, 91),
    'surface-container-high': tone(neutral, 89),
    'surface-container-highest': tone(neutral, 87),
    'surface-variant': tone(neutralVariant, 87),
    'outline-variant': tone(neutralVariant, 78),
    'primary-container': tone(quiet, 90),
    'on-primary-container': tone(primary, 25),
    'secondary-container': tone(tonal, 84),
    'on-secondary-container': tone(secondary, 25),
  }
}

/** Seed-independent state colours: the owner's machine-state materials. Each
 *  clears 3:1 against every surface tier it can sit on (WCAG 1.4.11). */
export function states(dark: boolean) {
  const { primary, aged, tertiary, error, ochre } = palettes
  if (dark) {
    return {
      running: OWNER.ember,
      idle: OWNER.brass,
      done: OWNER.green,
      needs: OWNER.ochre,
      // #A94B3D is 2.8:1 on `surface-container-high`; tone 55 of its own palette clears 3.
      failed: tone(error, 55),
    }
  }
  return {
    running: tone(primary, 45),
    // Brass and ochre are 2° of hue apart, so at tone 45 only chroma tells them apart.
    idle: tone(aged, 45),
    done: tone(tertiary, 45),
    needs: tone(ochre, 45),
    failed: tone(error, 40),
  }
}

export function schemeFor(seed: string, dark: boolean): Scheme {
  const upper = seed.toUpperCase()
  const scheme =
    upper === SAGE
      ? sage(dark)
      : upper === BRASS
        ? brass(dark)
        : new SchemeExpressive(Hct.fromInt(argbFromHex(seed)), dark, 0)
  const values = scheme as unknown as Record<string, number>
  const out = {} as Scheme
  for (const role of roles) {
    out[role] = hexFromArgb(values[getter(role)]).toUpperCase()
  }
  return upper === BRASS ? { ...out, ...pinned(dark) } : out
}

/** Writes both schemes as one `light-dark()` pair per role, the shape
 *  tokens.css uses, so System keeps following the OS after a seed change. */
export function applyScheme(
  light: Scheme,
  dark: Scheme,
  root: HTMLElement = document.documentElement,
) {
  for (const role of roles) {
    root.style.setProperty(
      `--md-sys-color-${role}`,
      `light-dark(${light[role]}, ${dark[role]})`,
    )
  }
}

export function clearScheme(root: HTMLElement = document.documentElement) {
  for (const role of roles) root.style.removeProperty(`--md-sys-color-${role}`)
}
