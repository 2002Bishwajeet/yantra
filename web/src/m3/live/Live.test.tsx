import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ApiError } from '@/api/errors'
import { ErrorSurface } from '../error-surface/ErrorSurface'
import { LiveRegion } from './Live'

afterEach(cleanup)

const WORDS = 'Nothing here can be reached. The daemon did not answer.'
const network = new ApiError('network', 'fetch failed')

/** The shell mounts the region at boot; a screen draws its error under it. */
function Page({ failing }: { failing: boolean }) {
  return (
    <>
      <LiveRegion />
      {failing ? (
        <ErrorSurface.Card error={network} title="Nothing here can be reached" />
      ) : (
        <p>Trying again.</p>
      )}
    </>
  )
}

const regions = () => Array.from(document.querySelectorAll<HTMLElement>('p[aria-live="assertive"]'))
const speaking = () => regions().findIndex((one) => one.textContent !== '')

describe('the live region', () => {
  it('is mounted empty and says the error a surface drew', () => {
    const { rerender } = render(<Page failing={false} />)
    expect(regions()).toHaveLength(2)
    expect(speaking()).toBe(-1)
    rerender(<Page failing />)
    expect(regions()[speaking()]?.textContent).toBe(WORDS)
  })

  /** Finding 111: the same sentence written into the same region twice is not
   *  a change, so the two take turns and a second identical error is a change
   *  in whichever gains it. */
  it('says a second identical error, in the other region', () => {
    const { rerender } = render(<Page failing />)
    const first = speaking()
    expect(regions()[first]?.textContent).toBe(WORDS)

    rerender(<Page failing={false} />)
    rerender(<Page failing />)
    const second = speaking()
    expect(second).not.toBe(first)
    expect(regions()[second]?.textContent).toBe(WORDS)
    expect(regions()[first]?.textContent).toBe('')
  })

  /** One announcement, not two: the surface keeps the role it is, and the
   *  region is the only thing live. */
  it('leaves the surface with nothing live of its own', () => {
    render(<Page failing />)
    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('off')
  })
})
