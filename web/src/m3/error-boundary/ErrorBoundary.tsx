import type { ReactNode } from 'react'
import { ErrorBoundary as Boundary, type FallbackProps } from 'react-error-boundary'
import { useQueryErrorResetBoundary } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { isApiError } from '@/api/errors'
import { ErrorSurface, type Described } from '../error-surface/ErrorSurface'

/** A throw that is not the API's: the page broke, and the reader gets the
 *  sentence and the error's name, never a stack or a component. */
function describe(error: unknown): Described {
  if (isApiError(error)) return error
  const name = error instanceof Error && error.name ? error.name : 'Error'
  return {
    kind: 'contract',
    said: name,
    retryable: true,
    describe: () => 'Something in this part of the page broke.',
  }
}

export type ErrorBoundaryProps = {
  /** Which surface the fallback takes. */
  layout?: 'page' | 'card' | 'inline'
  title?: string
  eyebrow?: string
  /** A change here resets the boundary, as a route param does. */
  resetKeys?: readonly unknown[]
  children: ReactNode
}

function Fallback(props: FallbackProps & Omit<ErrorBoundaryProps, 'children' | 'resetKeys'>) {
  const { error, resetErrorBoundary, layout, title, eyebrow } = props
  const query = useQueryErrorResetBoundary()
  const router = useRouter()
  const Surface = layout === 'page' ? ErrorSurface.Page : layout === 'inline' ? ErrorSurface.Inline : ErrorSurface
  return (
    <Surface
      eyebrow={eyebrow}
      title={title ?? 'This could not be drawn'}
      error={describe(error)}
      reset={() => {
        query.reset()
        void router.invalidate()
        resetErrorBoundary()
      }}
      autoFocus
    />
  )
}

/** Wraps a region so one broken read draws an ErrorSurface in its place.
 *  Try again resets Query, the router and the boundary together. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  const { layout, title, eyebrow, resetKeys, children } = props
  return (
    <Boundary
      resetKeys={resetKeys as unknown[] | undefined}
      fallbackRender={(fallback) => <Fallback {...fallback} layout={layout} title={title} eyebrow={eyebrow} />}
    >
      {children}
    </Boundary>
  )
}

/** For a route's `errorComponent`: the router hands over `{ error, reset }`. */
export function RouteError(props: { error: Error; reset: () => void }) {
  const { error, reset } = props
  return <Fallback error={error} resetErrorBoundary={reset} layout="page" />
}
