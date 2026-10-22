import { useEffect, useRef, useState } from 'react'
import { AttachError } from '@/api/chat'
import type { Link } from '@/screens/session/useChat'

/** One image in the composer: a local preview, and how its upload went. */
export type Picked = { id: number; url: string } & (
  | { state: 'uploading' }
  | { state: 'attached'; path: string }
  | { state: 'failed'; error: AttachError }
)

/** The composer's images (Y-424). Each uploads as it is added, and its
 *  preview URL is revoked when it goes or the chat does. */
export function useImages(attach: (file: Blob) => Promise<string>, link: Link) {
  const [images, setImages] = useState<Picked[]>([])
  const next = useRef(1)
  const urls = useRef(new Map<number, string>())

  // The daemon removes a socket's images when the socket closes, and Retry
  // opens a socket with none, so a path from the old socket names nothing.
  const [was, setWas] = useState(link)
  if (link !== was) {
    setWas(link)
    if (link !== 'open') {
      setImages((now) =>
        now.map((one) =>
          one.state === 'attached' ? { id: one.id, url: one.url, state: 'failed', error: new AttachError('closed') } : one,
        ),
      )
    }
  }

  useEffect(() => {
    const held = urls.current
    return () => {
      for (const url of held.values()) URL.revokeObjectURL(url)
      held.clear()
    }
  }, [])

  const settle = (id: number, change: (one: Picked) => Picked) =>
    setImages((now) => now.map((one) => (one.id === id ? change(one) : one)))

  const forget = (ids: Iterable<number>) => {
    for (const id of ids) {
      const url = urls.current.get(id)
      if (url) URL.revokeObjectURL(url)
      urls.current.delete(id)
    }
  }

  return {
    images,
    add: (files: Iterable<File>) => {
      for (const file of files) {
        const id = next.current++
        const url = URL.createObjectURL(file)
        urls.current.set(id, url)
        setImages((now) => [...now, { id, url, state: 'uploading' }])
        attach(file).then(
          (path) => settle(id, ({ url }) => ({ id, url, state: 'attached', path })),
          (cause: unknown) =>
            settle(id, ({ url }) => ({
              id,
              url,
              state: 'failed',
              error: cause instanceof AttachError ? cause : new AttachError('unreachable', String(cause)),
            })),
        )
      }
    },
    remove: (id: number) => {
      forget([id])
      setImages((now) => now.filter((one) => one.id !== id))
    },
    clear: () => {
      forget([...urls.current.keys()])
      setImages([])
    },
  }
}
