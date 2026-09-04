import { useEffect, useState } from 'react'
import today from './options/today.css?raw'
import kalam from './options/kalam.css?raw'
import patta from './options/patta.css?raw'
import neela from './options/neela.css?raw'
import plex from './options/plex.css?raw'

const OPTIONS = [
  { id: 'today', css: today, says: 'the stock shadcn sheet — the control' },
  { id: 'kalam', css: kalam, says: 'ink on paper; the accent is the ink, and cinnabar means trouble and nothing else' },
  { id: 'patta', css: patta, says: 'the cloth ground and the soot line; indigo for action, cinnabar for trouble' },
  { id: 'neela', css: neela, says: 'a cool white ground; indigo for action, and cinnabar the only warm note' },
  { id: 'plex', css: kalam + plex, says: 'kalam’s colours set in IBM Plex, so numbers get a face with tabular figures' },
] as const

type Id = (typeof OPTIONS)[number]['id']
type Ground = 'auto' | 'light' | 'dark'

function fromHash(): { id: Id; ground: Ground } {
  const [id, ground] = location.hash.slice(1).split(',')
  return {
    id: OPTIONS.some((one) => one.id === id) ? (id as Id) : 'today',
    ground: ground === 'light' || ground === 'dark' ? ground : 'auto',
  }
}

const sheet = document.createElement('style')
document.head.append(sheet)

export function Switcher() {
  const [chosen, setChosen] = useState(fromHash)

  useEffect(() => {
    const option = OPTIONS.find((one) => one.id === chosen.id)!
    sheet.textContent = option.css
    const root = document.documentElement
    if (chosen.ground === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', chosen.ground)
    history.replaceState(null, '', `#${chosen.id},${chosen.ground}`)
  }, [chosen])

  const option = OPTIONS.find((one) => one.id === chosen.id)!
  const button = (on: boolean): React.CSSProperties => ({
    font: 'inherit',
    padding: '0.35rem 0.6rem',
    border: '1px solid currentColor',
    borderRadius: '999px',
    background: on ? 'currentColor' : 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  })
  const label = (on: boolean): React.CSSProperties => ({
    color: on ? 'var(--background)' : 'inherit',
  })

  return (
    <div
      style={{
        position: 'fixed',
        insetInline: 0,
        bottom: 0,
        zIndex: 50,
        padding: '0.6rem 1rem calc(0.6rem + env(safe-area-inset-bottom))',
        background: 'var(--background)',
        color: 'var(--foreground)',
        borderTop: '1px solid var(--border)',
        font: '500 0.8125rem/1.3 ui-monospace, SFMono-Regular, monospace',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.5rem',
      }}
    >
      {OPTIONS.map((one) => (
        <button
          key={one.id}
          onClick={() => setChosen({ ...chosen, id: one.id })}
          style={button(one.id === chosen.id)}
          type="button"
        >
          <span style={label(one.id === chosen.id)}>{one.id}</span>
        </button>
      ))}
      <span style={{ opacity: 0.5 }}>·</span>
      {(['auto', 'light', 'dark'] as const).map((ground) => (
        <button
          key={ground}
          onClick={() => setChosen({ ...chosen, ground })}
          style={button(ground === chosen.ground)}
          type="button"
        >
          <span style={label(ground === chosen.ground)}>{ground}</span>
        </button>
      ))}
      <span style={{ flexBasis: '100%', opacity: 0.7, fontWeight: 400 }}>
        {option.says}
      </span>
    </div>
  )
}
