import { useState, type ReactNode } from 'react'
import type { Connection } from '@/api'
import './Avatar.css'

/** The GitHub profile image over `children`, the icon it falls back to. The
 *  image is decorative and absolute, so a failed load moves nothing. The host
 *  must be positioned and round. */
export function Avatar(props: { connection: Connection | undefined; children: ReactNode }) {
  const { connection, children } = props
  const [failed, setFailed] = useState<string | null>(null)
  const src = connection?.connected ? connection.avatar_url : null
  return (
    <>
      {children}
      {src && src !== failed ? (
        <img alt="" className="avatar" decoding="async" onError={() => setFailed(src)} src={src} />
      ) : null}
    </>
  )
}
