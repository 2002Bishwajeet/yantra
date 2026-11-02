import type { Prefs } from './prefs'

/** index.html draws both metas; this keeps the one that matches the chosen
 *  theme, because `media` alone follows the OS and not the Appearance choice. */
export function syncThemeColor(theme: Prefs['theme']) {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][data-scheme]')) {
    const scheme = meta.dataset.scheme
    meta.media = theme === 'system' ? `(prefers-color-scheme: ${scheme})` : scheme === theme ? 'all' : 'not all'
  }
}
