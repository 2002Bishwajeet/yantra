import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import type { Harness } from '@/api/thread'
import type { Target } from '@/api/socket'
import { renderInApp } from '@/test/inApp'
import type { Tool } from './timeline'
import { WorkLog } from './WorkLog'

/* Y-702. A sudo command in the Chat is offered to the owner's own shell. The
   terminal is `Terminal.test.tsx`'s, against a real socket; here it records the
   target and the text it was told to type. */

const opened: { target: Target; typeIn?: string }[] = []

vi.mock('@/screens/session/Terminal', () => ({
  Terminal: (props: { target: Target; typeIn?: string }) => {
    opened.push({ target: props.target, typeIn: props.typeIn })
    return <div>the shell</div>
  },
}))

beforeEach(() => {
  opened.length = 0
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: 1440 >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllGlobals()
})

const tool = (title: string, id = 'a'): Tool => ({
  kind: 'tool',
  id,
  turn: 1,
  itemType: 'command_execution',
  status: 'completed',
  title,
  output: null,
})

async function draw(title: string, harness: Harness = 'claude', machine = 'pi') {
  await renderInApp(
    <WorkLog
      harness={harness}
      machine={machine}
      said={() => null}
      work={{ kind: 'work', id: 'work:1', turn: 1, items: [tool(title)], label: 'Worked', state: 'running', calls: 1 }}
    />,
  )
}

const run = () => screen.queryByRole('button', { name: 'Run in owner terminal' })
const type = (text: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: 'Admin account' }), { target: { value: text } })

describe('Run in owner terminal', () => {
  it('is offered on a sudo command and not on another', async () => {
    await draw('sudo systemctl restart sshd')
    expect(run()).toBeTruthy()
    cleanup()
    await draw('ls -la')
    expect(run()).toBeNull()
  })

  it('is not offered on a Codex thread', async () => {
    await draw('sudo ls', 'codex')
    expect(run()).toBeNull()
  })

  it('is disabled while the thread has no machine', async () => {
    await draw('sudo ls', 'claude', '')
    expect((run() as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens the thread machine as the kept admin, with the command typed in', async () => {
    localStorage.setItem('yantra.owner.pi', 'biswa')
    await draw('sudo systemctl restart sshd')
    fireEvent.click(run()!)
    const sheet = within(await screen.findByRole('complementary', { name: 'biswa on pi' }))
    expect(sheet.getByText('The command is typed in. Read it, press Enter, then type your password.')).toBeTruthy()
    expect(await sheet.findByText('the shell')).toBeTruthy()
    expect(opened.at(-1)).toEqual({
      target: { machine: 'pi', owner: 'biswa' },
      typeIn: 'sudo systemctl restart sshd',
    })
  })

  it('asks for the admin name first, refuses a bad one, then opens and remembers it', async () => {
    await draw('sudo ls')
    fireEvent.click(run()!)
    expect(await screen.findByRole('complementary', { name: 'Owner terminal on pi' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Get the line on pi/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open owner terminal' }))
    expect(screen.getByText('Name the admin account first')).toBeTruthy()
    type('a b')
    expect(screen.getByText('Use letters, digits, ., _ and - only')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open owner terminal' }))
    expect(opened).toHaveLength(0)

    type('biswa')
    fireEvent.click(screen.getByRole('button', { name: 'Open owner terminal' }))
    expect(await screen.findByText('the shell')).toBeTruthy()
    expect(opened.at(-1)).toEqual({ target: { machine: 'pi', owner: 'biswa' }, typeIn: 'sudo ls' })
    expect(localStorage.getItem('yantra.owner.pi')).toBe('biswa')
  })

  it.each([
    ['a newline', 'sudo ls\nrm -rf /'],
    ['ESC', 'sudo ls \u001b[2J'],
  ])('refuses a command with %s and offers no button', async (_, command) => {
    await draw(command)
    expect(run()).toBeNull()
    expect(screen.getByText(/holds a control character, so Yantra will not type it/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy the command' })).toBeTruthy()
  })
})
