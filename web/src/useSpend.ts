import { useState } from 'react'
import type { Workspace } from './api'
import { type Asked, read } from './lib/spend'

/** One workspace's spend, read on request (D5 §6.1). `/usage` calls it with the
 *  workspace its picker chose; `/w/{name}` calls it with the one in the URL.
 *
 *  **On `/w/{name}` it lives above the tab.** Only the open tab is mounted (D5
 *  §3.5), so a tab holding its own answer would spend a second ssh every time a
 *  reader came back from the terminal. Nothing is fetched until `ask` is
 *  called. */
export function useSpend() {
  const [asked, setAsked] = useState<Asked>({ asked: 'no' })

  const ask = async (workspace: Workspace) => {
    setAsked({ asked: 'asking', workspace })
    setAsked(await read(workspace))
  }

  return { asked, ask }
}
