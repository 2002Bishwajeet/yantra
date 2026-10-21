import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import * as Composer from './Composer'
import { PrimaryAction, type PrimaryActionProps } from './PrimaryAction'

afterEach(cleanup)

function Harness(props: {
  enterSends?: boolean
  onSend?: () => void
  value?: string
  action?: Partial<PrimaryActionProps>
}) {
  const [value, setValue] = useState(props.value ?? '')
  const send = props.onSend ?? (() => {})
  return (
    <Composer.Root empty={value === ''} onSubmit={(event) => event.preventDefault()}>
      <Composer.Input
        aria-label="Message"
        enterSends={props.enterSends ?? true}
        onChange={(event) => setValue(event.target.value)}
        onSend={send}
        value={value}
      />
      <Composer.Footer actions={<PrimaryAction label="Send" reason={null} {...props.action} />} />
    </Composer.Root>
  )
}

const box = () => screen.getByLabelText<HTMLTextAreaElement>('Message')
const type = (value: string) => fireEvent.change(box(), { target: { value } })

describe('the keys', () => {
  it('sends on Enter and writes a new line on Shift+Enter', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    type('hello')
    expect(fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })).toBe(true)
    expect(onSend).not.toHaveBeenCalled()
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false)
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('with Enter sends off, writes a new line on Enter and sends on Mod+Enter', () => {
    const onSend = vi.fn()
    render(<Harness enterSends={false} onSend={onSend} />)
    type('hello')
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(true)
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true })
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('asks for Mod+Enter inside an open code fence', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    type('run:\n```sh\ncargo test')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('does not send while an input method composes', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    type('こんにちは')
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('the field', () => {
  it('grows with its words and takes no more than 40vh', () => {
    // jsdom has no layout, so the height a browser would measure is stood in for.
    const scroll = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
    scroll.mockReturnValue(56)
    render(<Harness />)
    type('one line')
    const first = parseInt(box().style.height, 10)
    scroll.mockReturnValue(168)
    type('one\ntwo\nthree\nfour\nfive')
    expect(parseInt(box().style.height, 10)).toBeGreaterThan(first)
    scroll.mockRestore()
  })
})

describe('the primary action', () => {
  it('is Send, and says why it is off in its description', () => {
    render(<Harness action={{ reason: 'Type a message to send it.' }} />)
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toHaveProperty('disabled', true)
    const why = document.getElementById(send.getAttribute('aria-describedby')!)
    expect(why?.textContent).toBe('Type a message to send it.')
  })

  it('spins while an image uploads, and keeps its place', () => {
    const { rerender } = render(<Harness action={{ reason: 'An image is still uploading.', pending: true }} />)
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send.getAttribute('aria-busy')).toBe('true')
    expect(send.querySelector('.composer-spinner')).not.toBeNull()
    rerender(<Harness action={{ reason: null }} />)
    expect(screen.getByRole('button', { name: 'Send' })).toBe(send)
    expect(send).toHaveProperty('disabled', false)
  })

  it('is a Stop while a turn runs, and calls it', () => {
    const onStop = vi.fn()
    render(<Harness action={{ running: { agent: 'Claude', stopping: false, onStop, reason: 'Claude is answering. Stop it to send something else.' } }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop Claude' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    const why = document.getElementById(screen.getByRole('button', { name: 'Stop Claude' }).getAttribute('aria-describedby')!)
    expect(why?.textContent).toBe('Claude is answering. Stop it to send something else.')
  })

  it('holds the Stop while it stops, with a spinner', () => {
    render(<Harness action={{ running: { agent: 'Claude', stopping: true, onStop: () => {}, reason: 'Claude is answering.' } }} />)
    const stop = screen.getByRole('button', { name: 'Stop Claude' })
    expect(stop).toHaveProperty('disabled', true)
    expect(within(stop).getByText('', { selector: '.composer-spinner' })).toBeTruthy()
  })
})

describe('the card', () => {
  it('rests while it is empty, and says so for the stylesheet', () => {
    render(<Harness />)
    const shell = document.querySelector('[data-slot="composer-shell"]')!
    expect(shell.hasAttribute('data-empty')).toBe(true)
    type('words')
    expect(shell.hasAttribute('data-empty')).toBe(false)
  })
})
