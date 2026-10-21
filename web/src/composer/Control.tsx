/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/ComposerControl.tsx
 * (ComposerControl, Icon, Chevron, Separator), on Yantra's M3 tokens:
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/ComposerControl.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import type { ComponentType, SVGProps } from 'react'
import { Button as Base } from '@base-ui/react/button'
import { clsx } from 'clsx'
import { ChevronDown } from 'lucide-react'

/** A footer control: 32 px drawn, with the 48 px hit area every `m3-interactive` has. */
export function Control(props: Base.Props) {
  const { className, ...rest } = props
  return <Base className={clsx('composer-control', 'm3-interactive', className)} {...rest} />
}

export function Icon(props: { icon: ComponentType<SVGProps<SVGSVGElement>> }) {
  const { icon: Glyph } = props
  return <Glyph aria-hidden="true" className="composer-control__icon" />
}

export function Chevron() {
  return <ChevronDown aria-hidden="true" className="composer-control__chevron" strokeWidth={2.25} />
}

export function Separator() {
  return <span aria-hidden="true" className="composer-separator" />
}

/** The words of a control; they go under the container query and the aria-label stays. */
export function Label(props: { children: string }) {
  return <span className="composer-control__label">{props.children}</span>
}
