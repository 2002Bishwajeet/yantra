import { isApiError } from '@/api/errors'

/** React 19 logs every caught error itself. An `ApiError` reaching a boundary
 *  is the designed path — the boundary draws it — so only the rest is real. */
export function onCaughtError(error: unknown, info: { componentStack?: string }) {
  if (isApiError(error)) return
  console.error(error, info.componentStack)
}
