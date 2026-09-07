import type { ComponentPropsWithRef, ReactNode } from 'react'
import { clsx } from 'clsx'
import { tileColor } from './tileColor'
import './Tile.css'

export type TileProps = ComponentPropsWithRef<'span'> & {
  /** The workspace name; its first letter is drawn and its colour derived. */
  name: string
  /** The 28 px tile for a single-line row. */
  size?: 'default' | 'small'
}

/** A workspace's letter on its colour. The colour is data about the
 *  workspace, not a role, which is why it is the one inline colour here. */
export function Tile(props: TileProps) {
  const { name, size, className, style, ...rest } = props
  return (
    <span
      className={clsx('m3-tile', className)}
      data-size={size ?? 'default'}
      style={{ background: tileColor(name), ...style }}
      aria-hidden="true"
      {...rest}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

export type IconTileProps = ComponentPropsWithRef<'span'> & {
  size?: 'default' | 'small'
  children: ReactNode
}

/** The same square holding an icon, for a GitHub item beside workspaces. */
export function IconTile(props: IconTileProps) {
  const { size, className, children, ...rest } = props
  return (
    <span
      className={clsx('m3-tile', 'm3-tile--icon', className)}
      data-size={size ?? 'default'}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </span>
  )
}
