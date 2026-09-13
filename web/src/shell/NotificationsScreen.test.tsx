import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import { mount, unmount } from './harness'

afterEach(() => {
  cleanup()
  unmount()
})

describe('the /notifications route (N1)', () => {
  it('titles the page the same display-small h1 as every other route', async () => {
    mount('desktop', '/notifications')
    const heading = await screen.findByRole('heading', { level: 1, name: 'Notifications' })
    expect(heading.getAttribute('data-scale')).toBe('display-small')
  })
})
