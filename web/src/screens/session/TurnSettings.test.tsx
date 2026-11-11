import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CONTEXT_LENGTHS, MODES } from '@/api/thread'
import { TurnSettings, type TurnSettingsProps } from './TurnSettings'

const base: TurnSettingsProps = {
  mode: 'supervised',
  onMode: () => {},
  claude: true,
  model: null,
  onModel: () => {},
  effort: null,
  onEffort: () => {},
  lengths: CONTEXT_LENGTHS,
  context: null,
  onContext: () => {},
}

const media = (matches: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches, media: query, addEventListener() {}, removeEventListener() {} }))

beforeEach(() => media(true))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const chip = () => screen.getByRole('button', { name: /^Turn settings/ })
const label = () => chip().querySelector('.composer-control__label')?.textContent ?? null

describe('TurnSettings', () => {
  it('shows the icon alone when every value is the default, and names every value for a reader', () => {
    render(<TurnSettings {...base} />)
    expect(label()).toBeNull()
    expect(chip().getAttribute('aria-label')).toBe('Turn settings: Supervised, model Default, effort Default, context Default')
  })

  it('lists only the values that differ', () => {
    render(<TurnSettings {...base} effort="high" model="opus" />)
    expect(label()).toBe('Opus · High')
    render(<TurnSettings {...base} context={400_000} mode="auto" />)
    expect(screen.getAllByRole('button', { name: /^Turn settings/ })[1].textContent).toBe('Auto · 400K')
  })

  it('sets the warning tone for Full access only', () => {
    const { rerender } = render(<TurnSettings {...base} />)
    expect(chip().getAttribute('data-tone')).toBeNull()
    rerender(<TurnSettings {...base} mode="full-access" />)
    expect(chip().getAttribute('data-tone')).toBe('warning')
  })

  it("lists T3 Code's four modes with their descriptions", async () => {
    render(<TurnSettings {...base} />)
    fireEvent.click(chip())
    const group = await screen.findByRole('radiogroup', { name: 'Permissions' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((one) => one.getAttribute('aria-label'))).toEqual(MODES.map((one) => one.label))
    radios.forEach((one, at) => {
      // aria-describedby is a list of ids split on whitespace, as a screen reader resolves it.
      const text = (one.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .map((token) => document.getElementById(token)?.textContent)
        .join(' ')
      expect(text).toBe(MODES[at].description)
    })
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
  })

  it('changes each group on its own, and Default sends none', async () => {
    const on = { onMode: vi.fn(), onModel: vi.fn(), onEffort: vi.fn(), onContext: vi.fn() }
    render(<TurnSettings {...base} {...on} context={512_000} effort="low" model="sonnet" />)
    fireEvent.click(chip())
    const pick = async (group: string, name: string) =>
      fireEvent.click(within(await screen.findByRole('radiogroup', { name: group })).getByRole('radio', { name }))
    await pick('Permissions', 'Full access')
    await pick('Model', 'Haiku')
    await pick('Effort', 'Default')
    await pick('Context', '1M')
    await pick('Context', 'Default')
    await waitFor(() => expect(on.onMode).toHaveBeenCalledWith('full-access'))
    expect(on.onModel).toHaveBeenCalledWith('haiku')
    expect(on.onEffort).toHaveBeenCalledWith(null)
    expect(on.onContext).toHaveBeenNthCalledWith(1, 1_000_000)
    expect(on.onContext).toHaveBeenNthCalledWith(2, null)
  })

  it('draws no Context group without lengths, and no Model or Effort for another harness', async () => {
    render(<TurnSettings {...base} claude={false} lengths={[]} />)
    expect(chip().getAttribute('aria-label')).toBe('Turn settings: Supervised')
    fireEvent.click(chip())
    await screen.findByRole('radiogroup', { name: 'Permissions' })
    for (const name of ['Model', 'Effort', 'Context']) expect(screen.queryByRole('radiogroup', { name })).toBeNull()
  })

  it('locks the Context group and leaves the others usable', async () => {
    render(<TurnSettings {...base} contextLocked />)
    fireEvent.click(chip())
    const context = await screen.findByRole('radiogroup', { name: 'Context' })
    expect(within(context).getAllByRole('radio').every((one) => one.hasAttribute('data-disabled'))).toBe(true)
    const modes = screen.getByRole('radiogroup', { name: 'Permissions' })
    expect(within(modes).getAllByRole('radio').some((one) => one.hasAttribute('data-disabled'))).toBe(false)
  })

  it('cannot open while the chat is not connected', () => {
    render(<TurnSettings {...base} disabled />)
    expect(chip()).toHaveProperty('disabled', true)
  })

  it('opens as a bottom sheet on a phone', async () => {
    media(false)
    render(<TurnSettings {...base} />)
    fireEvent.click(chip())
    expect(await screen.findByRole('dialog', { name: 'Turn settings' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Effort' })).toBeTruthy()
  })
})
