import { vi } from 'vitest'

/** A `Response` as `yantrad` shapes one: JSON on a 2xx, a bare string on a
 *  refusal, and the body read the way `fetchJson` reads it. `text` always
 *  answers; `json` rejects for a string body the way a real parse would. */
export function answer(status: number, body?: unknown) {
  return {
    ok: status < 400,
    status,
    json: () =>
      typeof body === 'string'
        ? Promise.reject(new SyntaxError('Unexpected token'))
        : Promise.resolve(body),
    text: () =>
      Promise.resolve(typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response
}

/** Stubs `fetch` to answer every call the same way, and returns the spy so a
 *  test can read what was asked. */
export function daemon(status: number, body?: unknown) {
  const asked = vi.fn((_path: string, _init?: RequestInit) => Promise.resolve(answer(status, body)))
  vi.stubGlobal('fetch', asked)
  return asked
}
