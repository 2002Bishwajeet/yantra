import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { MISSING, type OneAgent } from '@/api/queries'
import { phrase } from './phrase'

const wordsOf = (answer: OneAgent | undefined): string | null => {
  if (answer === undefined || answer === MISSING) return null
  return phrase(answer.looked === 'ok' ? answer.data : null).words
}

/** 4.1.3: a session going running → crashed changes three lists that redraw on
 *  a poll — the dashboard's, the fleet's and the rail's — and none of them is a
 *  live region. This is the one region for all three, and it reads the cache
 *  rather than the lists: it announces the transition, never the list, and it
 *  asks the daemon for nothing of its own. */
export function StatusAnnouncer() {
  const client = useQueryClient()
  const [said, setSaid] = useState('')

  useEffect(() => {
    const before = new Map<string, string>()
    return client.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return
      const key = event.query.queryKey
      if (key[0] !== 'workspaces' || key[2] !== 'status') return
      const words = wordsOf(event.query.state.data as OneAgent | undefined)
      if (words === null) return
      const name = String(key[1])
      const was = before.get(name)
      before.set(name, words)
      if (was !== undefined && was !== words) setSaid(`${name} is ${words}.`)
    })
  }, [client])

  return (
    <p aria-live="polite" className="m3-sr-only">
      {said}
    </p>
  )
}
