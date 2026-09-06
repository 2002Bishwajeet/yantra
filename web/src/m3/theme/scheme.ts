/**
 * The colour engine behind Appearance's seed picker. ADR-0024 §2: this module
 * is reached by `import()` only, never from tokens.css or the `/` chunk, because
 * the sage scheme is already precomputed there and the engine is 20 kB gzip.
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

export function schemeFor(seed: string, dark: boolean): Scheme {
  const scheme =
    seed.toUpperCase() === SAGE
      ? sage(dark)
      : new SchemeExpressive(Hct.fromInt(argbFromHex(seed)), dark, 0)
  const values = scheme as unknown as Record<string, number>
  const out = {} as Scheme
  for (const role of roles) {
    out[role] = hexFromArgb(values[getter(role)]).toUpperCase()
  }
  return out
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
