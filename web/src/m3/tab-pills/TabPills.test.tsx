import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TabPanel, TabPill, TabPills, TabsRoot } from './TabPills'

afterEach(cleanup)

function Session() {
  return (
    <TabsRoot defaultValue="chat">
      <TabPills label="Session views">
        <TabPill value="chat">Chat</TabPill>
        <TabPill value="terminal">Terminal</TabPill>
        <TabPill value="spend">Spend</TabPill>
      </TabPills>
      <TabPanel value="chat">the chat</TabPanel>
      <TabPanel value="terminal">the terminal</TabPanel>
      <TabPanel value="spend">the spend</TabPanel>
    </TabsRoot>
  )
}

describe('TabPills', () => {
  it('is a tablist whose selected tab owns the visible panel', () => {
    render(<Session />)
    expect(screen.getByRole('tablist', { name: 'Session views' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Chat', selected: true })).toBeTruthy()
    expect(screen.getByRole('tabpanel').textContent).toBe('the chat')
  })

  it('moves with the arrow keys and selects on click', async () => {
    render(<Session />)
    const chat = screen.getByRole('tab', { name: 'Chat' })
    chat.focus()
    fireEvent.keyDown(chat, { key: 'ArrowRight' })
    const terminal = screen.getByRole('tab', { name: 'Terminal' })
    await waitFor(() => expect(document.activeElement).toBe(terminal))
    fireEvent.click(terminal)
    expect(terminal.getAttribute('aria-selected')).toBe('true')
    expect(chat.getAttribute('aria-selected')).toBe('false')
    // The panel swap waits on a transition jsdom never runs; the browser
    // swaps it, and the gallery screenshot shows that.
  })
})
