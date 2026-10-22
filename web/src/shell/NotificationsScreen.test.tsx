import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, screen } from '@testing-library/react'
import { mount, unmount } from './harness'

afterEach(() => {
  cleanup()
  unmount()
})

describe('the /notifications route (N1)', () => {
  it('titles the page with the PageHeader h1 every other route draws', async () => {
    mount('desktop', '/notifications')
    const heading = await screen.findByRole('heading', { level: 1, name: 'Notifications' })
    expect(heading.className).toContain('m3-page-header__h1')
  })
})
