import { readPrefs, writePrefs, type Prefs } from '@/shell/prefs'

// ADR-0024 §5's one preferences key; `general` holds what no settings row edits.
const KEY = 'finishSetup'

export const setupCardHidden = (prefs: Prefs) => prefs.general[KEY] === 'hidden'

export const hideSetupCard = () => writePrefs({ general: { ...readPrefs().general, [KEY]: 'hidden' } })

/** Settings → General's way back to a card someone hid. */
export function showSetupCard() {
  const general = { ...readPrefs().general }
  delete general[KEY]
  writePrefs({ general })
}
