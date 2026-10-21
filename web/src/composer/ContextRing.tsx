/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/ContextWindowMeter.tsx,
 * without the Compact button and the cost:
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/ContextWindowMeter.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { Popover, PopoverPopup, PopoverTrigger } from '@/m3/popover/Popover'
import { formatPercentage, formatTokens, isOverloaded, usedShare, type Usage } from './contextRing'

const RADIUS = 9.75
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** How full the context window is: a 24 px ring, and the numbers in a popover.
 *  It draws nothing before the first usage event. */
export function ContextRing(props: { usage: Usage | null }) {
  const { usage } = props
  if (!usage) return null
  const share = usedShare(usage)
  const percent = formatPercentage(share)
  const over = isOverloaded(usage)
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Context window ${percent} used`}
        className="composer-control m3-interactive"
        closeDelay={0}
        delay={150}
        openOnHover
        style={{ width: 32, padding: 0 }}
      >
        <span className="composer-ring" data-over={over ? '' : undefined}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle className="composer-ring__track" cx="12" cy="12" fill="none" r={RADIUS} strokeWidth="3" />
            <circle
              className="composer-ring__value"
              cx="12"
              cy="12"
              fill="none"
              r={RADIUS}
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - share / 100)}
              strokeLinecap="round"
              strokeWidth="3"
            />
          </svg>
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="composer-ring-popup"
        data-over={over ? '' : undefined}
        side="top"
        title="Context window"
      >
        <div className="composer-ring-popup__row">
          <span>Context window</span>
          <span>{percent}</span>
        </div>
        <div
          aria-label="Context window usage"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={Math.round(share)}
          className="composer-ring-popup__bar"
          role="progressbar"
        >
          <span style={{ width: `${share}%` }} />
        </div>
        <p className="composer-ring-popup__line">
          <span>Used</span>
          <span>{formatTokens(usage.used)} tokens</span>
        </p>
        <p className="composer-ring-popup__line">
          <span>Window</span>
          <span>{formatTokens(usage.max)} tokens</span>
        </p>
      </PopoverPopup>
    </Popover>
  )
}
