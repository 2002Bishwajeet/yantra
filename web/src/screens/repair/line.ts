/** The line a daemon error names, or null. Both shapes the daemon writes
 *  carry it: `missing field 'machine' at line 7` and
 *  `TOML parse error at line 2, column 7`. */
export function errorLine(error: string): number | null {
  const found = /\bat line (\d+)/.exec(error)
  return found ? Number(found[1]) : null
}

/** The words worth drawing beside the line: the last clause, without the
 *  position the gutter already shows. */
export function shortError(error: string): string {
  const clause = error.split(': ').at(-1) ?? error
  return clause.replace(/\s*\bat line \d+.*$/s, '').trim() || clause.trim()
}
