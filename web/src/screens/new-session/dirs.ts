/** `/ home ~ Github yantra`: every segment is a way back up, to `/` itself
 *  (Y-414). The segment that is `$HOME` reads `~`. */
export function crumbs(here: string, home: string | null): { label: string; path: string }[] {
  const out = [{ label: '/', path: '/' }]
  let path = ''
  for (const segment of here.split('/').filter(Boolean)) {
    path = `${path}/${segment}`
    out.push({ label: path === home ? '~' : segment, path })
  }
  return out
}

/** `name` under `dir`, with one slash at the root rather than two. */
export const under = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`)
