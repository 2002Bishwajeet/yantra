/** `~ / Github / yantra`: every segment is a way back up. Outside `$HOME`
 *  the first crumb is `/`. */
export function crumbs(here: string, home: string | null): { label: string; path: string }[] {
  const inside = home !== null && (here === home || here.startsWith(`${home}/`))
  const base = inside ? home : '/'
  const out = [{ label: inside ? '~' : '/', path: base }]
  const rest = here.slice(base.length).split('/').filter(Boolean)
  let path = base === '/' ? '' : base
  for (const segment of rest) {
    path = `${path}/${segment}`
    out.push({ label: segment, path })
  }
  return out
}
