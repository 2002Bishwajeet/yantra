import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
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

  it('holds the Stop while it stops, with a spinner, and keeps the focus on it', () => {
    const onStop = vi.fn()
    render(<Harness action={{ running: { agent: 'Claude', stopping: true, onStop, reason: 'Claude is answering.' } }} />)
    const stop = screen.getByRole('button', { name: 'Stop Claude' })
    // aria-disabled, not disabled: a disabled button drops the keyboard's focus to the body.
    expect(stop.getAttribute('aria-disabled')).toBe('true')
    expect(stop).toHaveProperty('disabled', false)
    stop.focus()
    fireEvent.click(stop)
    expect(onStop).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(stop)
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

  it('puts the caret in the field when a press lands on the card and on no control', () => {
    render(<Harness action={{ reason: null }} />)
    const card = document.querySelector('.composer__card')!
    expect(fireEvent.mouseDown(card)).toBe(false)
    expect(document.activeElement).toBe(box())
    box().blur()
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Send' }))
    expect(document.activeElement).not.toBe(box())
  })

  it('leaves a press on an error alone, so its words can be selected', () => {
    render(
      <Composer.Root empty onSubmit={(event) => event.preventDefault()}>
        <Composer.Input aria-label="Message" enterSends onSend={() => {}} value="" />
        <section className="m3-error">
          <p data-testid="said">The image is too large.</p>
        </section>
      </Composer.Root>,
    )
    expect(fireEvent.mouseDown(screen.getByTestId('said'))).toBe(true)
    expect(document.activeElement).not.toBe(box())
  })

  it('leaves a press in a menu portalled out of the card alone', () => {
    render(
      <Composer.Root empty onSubmit={(event) => event.preventDefault()}>
        <Composer.Input aria-label="Message" enterSends onSend={() => {}} value="" />
        {createPortal(<div data-testid="menu">item</div>, document.body)}
      </Composer.Root>,
    )
    expect(fireEvent.mouseDown(screen.getByTestId('menu'))).toBe(true)
    expect(document.activeElement).not.toBe(box())
  })
})

describe('the footer', () => {
  it('marks a footer with no controls, so the action sits beside the field', () => {
    const { container, rerender } = render(<Composer.Footer actions={<button type="button">Post</button>} />)
    expect(container.querySelector('.composer__footer')?.hasAttribute('data-bare')).toBe(true)
    rerender(<Composer.Footer actions={<button type="button">Post</button>} controls={<button type="button">Attach</button>} />)
    expect(container.querySelector('.composer__footer')?.hasAttribute('data-bare')).toBe(false)
  })
})

describe('the status line', () => {
  it('stays in the page when quiet, so the words are still said', () => {
    render(<Composer.Status quiet>Claude is waiting for your answer.</Composer.Status>)
    const line = screen.getByRole('status')
    expect(line.textContent).toBe('Claude is waiting for your answer.')
    expect(line.classList.contains('m3-sr-only')).toBe(true)
  })
})
