# `web/src/api/` — how the dashboard talks to `yantrad`

`keys.ts` makes every query key. `queries.ts` is one `queryOptions` per read; `mutations.ts` one
`useMutation` per write, each invalidating by key. `hooks.ts` is what a route calls. `socket.ts` is
the two terminal sockets. `client.ts` holds `fetchJson`, the `Looked` envelope, and the
`QueryClient` defaults. `fixtures.ts` is for tests only.

## Errors

Everything here rejects with one class, `ApiError` (`errors.ts`), and nothing else. A surface reads
`error.kind`, draws `error.describe()` as the sentence, and the daemon's own words, `error.said`,
beneath it in mono. `error.status` is there where a code arrived.

| kind | from | draw |
| --- | --- | --- |
| `network` | `fetch` rejected; nothing answered | "The daemon did not answer." Asked again twice, with backoff. |
| `refused` | a non-2xx with the daemon's bare-string body (403, 503, 409, 400…) | the status sentence; the body under it, verbatim |
| `missing` | 404 | "The daemon knows nothing by that name." |
| `contract` | a body that is not JSON, or not the envelope | "The daemon answered something this dashboard cannot read." |
| `socket` | a terminal socket's text frame | "The terminal could not be opened."; the frame under it |

A `looked: failed` reading is **data, not an error** (R-23): the section draws it in place.
`fromReading()` turns one into an `ApiError` for a surface that wants a boundary instead.

Errors stay in `error` by default. A route component under `ErrorBoundary` wraps its options in
`queryOptionsThrowing()`, and spreads `useResetOnRouteChange()` onto the boundary so a navigation
clears both the boundary and Query's own error state.
