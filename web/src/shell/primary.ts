import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useRouterState } from '@tanstack/react-router'

/** D7 §3.6: the one next action a page's FAB carries on the phone and the
 *  tablet. The desktop keeps it in the page. */
export type Primary =
  | { kind: 'new-session' }
  | { kind: 'add-device' }
  | { kind: 'install'; machine: string; press: () => void }

/** What a route declares in `staticData`, for when no screen says otherwise. */
export type RoutePrimary = 'new-session' | 'add-device'

// A screen's claim beats its route's; the newest claim beats an older one.
let route: Primary | null = null
const claims: { action: Primary | null }[] = []
let current: Primary | null = null
let drawn = false
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const changed = () => {
  current = claims.length > 0 ? claims[claims.length - 1]!.action : route
  for (const listener of listeners) listener()
}

export const keyOf = (action: Primary | null) =>
  action === null ? 'none' : action.kind === 'install' ? `install ${action.machine}` : action.kind

/** A screen's action while it is drawn; `null` says the page has none. The
 *  press goes through a ref, so a new function each render is not a new claim. */
export function usePrimaryAction(action: Primary | null) {
  const latest = useRef(action)
  useEffect(() => {
    latest.current = action
  })
  const key = keyOf(action)
  useEffect(() => {
    const given = latest.current
    const claim = {
      action:
        given?.kind === 'install'
          ? {
              ...given,
              press: () => {
                const now = latest.current
                if (now?.kind === 'install') now.press()
              },
            }
          : given,
    }
    claims.push(claim)
    changed()
    return () => {
      claims.splice(claims.indexOf(claim), 1)
      changed()
    }
  }, [key])
}

/** The open route's own action, off its `staticData`. A route that failed to
 *  load is an error page, and an error page carries none (D7 §3.6). */
export function useRouteAction(): RoutePrimary | null {
  return useRouterState({
    select: (state) => {
      const match = state.matches.at(-1)
      return match?.status === 'error' ? null : (match?.staticData.primary ?? null)
    },
  })
}

export function usePublishRoute(kind: RoutePrimary | null) {
  useEffect(() => {
    route = kind === null ? null : { kind }
    changed()
    return () => {
      route = null
      changed()
    }
  }, [kind])
}

/** The action the shell would draw, before it decides whether this width and
 *  route draw a FAB at all. */
export const usePrimary = () => useSyncExternalStore(subscribe, () => current, () => null)

/** Before paint, so a screen never shows its own copy filled beside the FAB. */
export function usePublishDrawn(shown: boolean) {
  useLayoutEffect(() => {
    drawn = shown
    changed()
    return () => {
      drawn = false
      changed()
    }
  }, [shown])
}

/** What the shell's FAB carries now, or null when none is drawn. A screen uses
 *  it to drop its own copy of that action from filled to tonal (D7 §3.1). */
export function useFab(): Primary | null {
  const action = usePrimary()
  const shown = useSyncExternalStore(subscribe, () => drawn, () => false)
  return shown ? action : null
}
