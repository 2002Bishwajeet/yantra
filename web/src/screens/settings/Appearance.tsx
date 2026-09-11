import { useEffect, useState } from 'react'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { Card } from '@/m3/card/Card'
import { Segment, Segmented } from '@/m3/segmented/Segmented'
import { Eyebrow, Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import type { Role, Scheme } from '@/m3/theme/scheme'
import { type Prefs, usePrefs, writePrefs } from '@/shell/prefs'

// The engine's own constant, restated so this chunk does not import the
// engine: brass is null in prefs and loads nothing (ADR-0024 §2).
const BRASS = '#C49A52'

const SEEDS: { name: string; hex: string | null }[] = [
  { name: 'brass', hex: null },
  { name: 'sage', hex: '#48674B' },
  { name: 'beige', hex: '#7A6A45' },
  { name: 'terracotta', hex: '#A85B3C' },
  { name: 'slate', hex: '#4E6A7A' },
  { name: 'plum', hex: '#6B4E7A' },
  { name: 'charcoal', hex: '#3A3D38' },
]

const ROLES: Role[] = ['primary', 'primary-container', 'secondary-container', 'tertiary-container', 'surface']

const HEX = /^#?([0-9a-f]{6})$/i

// Outside the component on purpose: an `import()` in a component body makes
// the React compiler bail out of the whole function (plan §7).
let engine: Promise<typeof import('@/m3/theme/scheme')> | null = null
const loadEngine = () => (engine ??= import('@/m3/theme/scheme'))

const asHex = (typed: string): string | null => {
  const found = HEX.exec(typed.trim())
  return found ? `#${found[1].toUpperCase()}` : null
}

export function Appearance() {
  const { density, seed, theme } = usePrefs()
  const named = SEEDS.some((one) => one.hex === seed)
  const [typed, setTyped] = useState(named ? '' : (seed ?? ''))
  const [scheme, setScheme] = useState<Scheme | null>(null)

  // The chips are the one reader of the engine on this page; the shell
  // applies the scheme itself when `seed` is written.
  useEffect(() => {
    let stale = false
    void loadEngine().then(({ schemeFor }) => {
      if (!stale) setScheme(schemeFor(seed ?? BRASS, false))
    })
    return () => {
      stale = true
    }
  }, [seed])

  const type = (value: string) => {
    setTyped(value)
    const hex = asHex(value)
    if (hex) writePrefs({ seed: hex === BRASS ? null : hex })
  }

  return (
    <>
      <section className="settings__group" aria-labelledby="appearance-layout">
        <Eyebrow render={<h3 />} className="settings__eyebrow" id="appearance-layout">
          Layout
        </Eyebrow>
        <div aria-label="Layout" className="settings__choices" role="group">
          <Choice
            chosen={density === 'clean'}
            label="Clean"
            onChoose={() => writePrefs({ density: 'clean' })}
            why="the default: whitespace, one hero, rows you can tap on a phone"
          >
            <svg aria-hidden="true" className="settings__schematic" viewBox="0 0 120 64">
              <rect fill="var(--md-sys-color-surface-container-high)" height="64" rx="6" width="28" />
              <rect fill="var(--md-sys-color-primary-container)" height="24" rx="6" width="86" x="34" />
              <rect fill="var(--md-sys-color-surface-container-high)" height="34" rx="6" width="86" x="34" y="30" />
            </svg>
          </Choice>
          <Choice
            chosen={density === 'compact'}
            label="Compact"
            onChoose={() => writePrefs({ density: 'compact' })}
            why="denser rows, smaller cards, more on screen; for a wide monitor"
          >
            <svg aria-hidden="true" className="settings__schematic" viewBox="0 0 120 64">
              <rect fill="var(--md-sys-color-surface-container-high)" height="64" rx="6" width="22" />
              <rect fill="var(--md-sys-color-primary-container)" height="30" rx="6" width="45" x="28" />
              <rect fill="var(--md-sys-color-surface-container-high)" height="30" rx="6" width="45" x="75" />
              <rect fill="var(--md-sys-color-surface-container-high)" height="30" rx="6" width="45" x="28" y="34" />
              <rect fill="var(--md-sys-color-surface-container-high)" height="30" rx="6" width="45" x="75" y="34" />
            </svg>
          </Choice>
        </div>
        <Text render={<p />} className="settings__note" scale="body-small" tone="variant">
          rows never drop below 44px in either
        </Text>
      </section>

      <section className="settings__group" aria-labelledby="appearance-colour">
        <Eyebrow render={<h3 />} className="settings__eyebrow" id="appearance-colour">
          Colour
        </Eyebrow>
        <div className="settings__seeds">
          <div aria-label="Colour seed" className="settings__swatches" role="group">
            {SEEDS.map((one) => (
              <button
                aria-pressed={one.hex === seed}
                className="settings__seed m3-interactive"
                key={one.name}
                onClick={() => {
                  setTyped('')
                  writePrefs({ seed: one.hex })
                }}
                type="button"
              >
                <span
                  className="settings__swatch"
                  data-light={one.hex === null || undefined}
                  style={{ background: one.hex ?? BRASS }}
                >
                  {one.hex === seed ? <Check aria-hidden="true" /> : null}
                </span>
                {one.name}
              </button>
            ))}
          </div>
          <TextField
            autoComplete="off"
            className="settings__hex"
            error={typed !== '' && asHex(typed) === null ? 'That is not a colour.' : undefined}
            label="Custom hex"
            onChange={(event) => type(event.target.value)}
            placeholder={BRASS}
            spellCheck={false}
            supporting="six hex digits"
            value={typed}
            variant="filled"
          />
        </div>
        <ul aria-label="Scheme roles" className="settings__roles">
          {ROLES.map((role) => (
            <li className="settings__role" key={role}>
              <span
                aria-hidden="true"
                className="settings__tile"
                style={{ background: scheme ? scheme[role] : `var(--md-sys-color-${role})` }}
              />
              <Mono className="settings__role-name">{role.replace(/-/g, ' ')}</Mono>
              {scheme ? <Mono className="settings__role-hex">{scheme[role]}</Mono> : null}
            </li>
          ))}
        </ul>
        <Text render={<p />} className="settings__note" scale="body-small" tone="variant">
          one seed recolours the whole scheme; state marks keep their shapes so nothing depends on colour alone
        </Text>
      </section>

      <section className="settings__group" aria-labelledby="appearance-theme">
        <Eyebrow render={<h3 />} className="settings__eyebrow" id="appearance-theme">
          Theme
        </Eyebrow>
        <Segmented label="Theme" onValueChange={(value) => writePrefs({ theme: value as Prefs['theme'] })} value={theme}>
          <Segment icon={<Sun />} value="light">
            Light
          </Segment>
          <Segment icon={<Moon />} value="dark">
            Dark
          </Segment>
          <Segment icon={<Monitor />} value="system">
            System
          </Segment>
        </Segmented>
        <div className="settings__previews">
          <Preview scheme="light" />
          <Preview scheme="dark" />
        </div>
        <Text render={<p />} className="settings__note" scale="body-small" tone="variant">
          dark follows the same seed · these are the only preferences; everything else is configuration
        </Text>
      </section>
    </>
  )
}

function Choice(props: { chosen: boolean; label: string; why: string; onChoose: () => void; children: React.ReactNode }) {
  const { chosen, label, why, onChoose, children } = props
  return (
    <button aria-pressed={chosen} className="settings__choice m3-interactive" onClick={onChoose} type="button">
      {children}
      <span className="settings__choice-head">
        <Text scale="title-medium" emphasized>
          {label}
        </Text>
        {chosen ? (
          <Text scale="body-small" tone="variant">
            selected
          </Text>
        ) : null}
      </span>
      <Text scale="body-small" tone="variant">
        {why}
      </Text>
    </button>
  )
}

/** The hero card as it will look, in both schemes at once: `color-scheme`
 *  on the card is what `light-dark()` in the tokens resolves against. */
function Preview(props: { scheme: 'light' | 'dark' }) {
  const { scheme } = props
  return (
    <div className="settings__preview" data-scheme={scheme} style={{ colorScheme: scheme }}>
      <Text scale="label-medium" tone="variant">
        {scheme === 'light' ? 'Light' : 'Dark'}
      </Text>
      <Card className="settings__hero" surface="primary">
        <Eyebrow>Needs you</Eyebrow>
        <Text render={<p />} className="settings__hero-number" scale="display-medium" emphasized>
          3
        </Text>
        <Text scale="body-medium">things are waiting on you</Text>
      </Card>
    </div>
  )
}
