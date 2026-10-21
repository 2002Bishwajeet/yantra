import { readGeneral } from '@/screens/settings/general'
import { usePrefs } from '@/shell/prefs'
import { useFormFactor } from '@/shell/formFactor'

/** Whether a bare Enter sends: the owner's setting, or a phone's keyboard having no Shift+Enter. */
export function useEnterSends(): boolean {
  const held = readGeneral(usePrefs()).enterSends
  const phone = useFormFactor() === 'phone'
  return held ?? !phone
}
