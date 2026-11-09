import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { BackgroundTask } from '@/api/thread'
import { BackgroundWork } from './BackgroundWork'

const sleep: BackgroundTask = {
  taskId: 'b561loltj',
  kind: 'local_bash',
  description: 'Background sleep then echo completion marker',
}
const build: BackgroundTask = { taskId: 'b5cnjn3f7', kind: 'local_bash', description: '' }

afterEach(cleanup)

function draw(tasks: BackgroundTask[], disabled = false) {
  const onStop = vi.fn<(taskId: string) => void>()
  const onStopAll = vi.fn<() => void>()
  render(<BackgroundWork disabled={disabled} onStop={onStop} onStopAll={onStopAll} tasks={tasks} />)
  return { onStop, onStopAll }
}

describe('the background work', () => {
  it('counts one task as T3 Code words it', () => {
    draw([sleep])
    expect(screen.getByRole('region', { name: 'Waiting on a background task' })).toBeTruthy()
  })

  it('draws nothing when no task runs', () => {
    draw([])
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('lists each task under its count, by description or by kind', () => {
    draw([sleep, build])
    const region = screen.getByRole('region', { name: 'Waiting on 2 background tasks' })
    const items = within(region).getAllByRole('listitem')
    expect(items.map((item) => item.querySelector('.chat__background-label')?.textContent)).toEqual([
      'Background sleep then echo completion marker',
      'local_bash',
    ])
  })

  it('stops one task by its id, and Stop all stops every one', () => {
    const { onStop, onStopAll } = draw([sleep, build])
    fireEvent.click(screen.getByRole('button', { name: 'Stop local_bash' }))
    expect(onStop).toHaveBeenCalledWith('b5cnjn3f7')
    fireEvent.click(screen.getByRole('button', { name: 'Stop all' }))
    expect(onStopAll).toHaveBeenCalledOnce()
  })

  it('holds every Stop while the socket is not open', () => {
    draw([sleep], true)
    for (const button of screen.getAllByRole('button')) expect(button).toHaveProperty('disabled', true)
  })
})
