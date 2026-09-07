import type { Prefs } from '@/shell/prefs'

/** General's rows, browser-local (plan §5.2). `time` is a preference the Age
 *  component reads later; nothing draws a clock yet. `defaultMachine: null`
 *  is the first machine in the list. */
export type General = {
  cloneHome: '~/Github' | '~/Gitlab'
  defaultMachine: string | null
  time: 'age' | 'clock'
}

export const CLONE_HOMES: General['cloneHome'][] = ['~/Github', '~/Gitlab']

export function readGeneral(prefs: Prefs): General {
  const held = prefs.general
  return {
    cloneHome: held.cloneHome === '~/Gitlab' ? '~/Gitlab' : '~/Github',
    defaultMachine: typeof held.defaultMachine === 'string' ? held.defaultMachine : null,
    time: held.time === 'clock' ? 'clock' : 'age',
  }
}
