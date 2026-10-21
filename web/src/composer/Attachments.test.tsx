import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen, act, waitFor, within } from '@testing-library/react'
import { AttachError } from '@/api/chat'
import { Attachments } from './Attachments'
import { useImages, type Picked } from './useImages'

afterEach(cleanup)

const tile = (id: number, state: Picked['state'], error?: AttachError): Picked => {
  const url = `blob:preview/${id}`
  if (state === 'failed') return { id, url, state, error: error ?? new AttachError('closed') }
  return state === 'attached' ? { id, url, state, path: `/tmp/${id}.png` } : { id, url, state }
}

describe('the attachments', () => {
  it('draws nothing without an image', () => {
    const { container } = render(<Attachments images={[]} onRemove={() => {}} />)
    expect(container.innerHTML).toBe('')
  })

  it('says whether each image is uploading or attached', () => {
    render(<Attachments images={[tile(1, 'uploading'), tile(2, 'attached')]} onRemove={() => {}} />)
    const items = screen.getAllByRole('listitem')
    expect(items.map((one) => one.getAttribute('data-state'))).toEqual(['uploading', 'attached'])
    expect(screen.getByText('Uploading…')).toBeTruthy()
    expect(screen.getByText('Attached')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['notAnImage', 'The chat takes PNG, JPEG, GIF and WebP images only.'],
    ['unreachable', "The workspace's machine did not take the image."],
    ['closed', 'The chat socket closed, so the image is not attached. Add it again.'],
  ] as const)('draws a %s failure as an error surface', (kind, sentence) => {
    render(<Attachments images={[tile(1, 'failed', new AttachError(kind))]} onRemove={() => {}} />)
    const alert = screen.getByRole('alert')
    expect(within(alert).getByRole('heading').textContent).toBe('Image 1 is not attached')
    expect(alert.textContent).toContain(sentence)
    expect(screen.getByRole('listitem').getAttribute('data-state')).toBe('failed')
  })

  it('removes the image it is asked to', () => {
    const onRemove = vi.fn()
    render(<Attachments images={[tile(1, 'attached'), tile(2, 'attached')]} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove image 2' }))
    expect(onRemove).toHaveBeenCalledWith(2)
  })

  it('opens an image large, steps through the others, and closes', async () => {
    render(<Attachments images={[tile(1, 'attached'), tile(2, 'attached')]} onRemove={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview image 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Image 1' })
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('blob:preview/1')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next image' }))
    await screen.findByRole('dialog', { name: 'Image 2' })
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }))
    await screen.findByRole('dialog', { name: 'Image 2' })
    fireEvent.click(screen.getByRole('button', { name: 'Close the preview' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('useImages', () => {
  it('revokes the object URL of an image that is removed', async () => {
    const revoked: string[] = []
    URL.createObjectURL = (() => 'blob:preview/1') as typeof URL.createObjectURL
    URL.revokeObjectURL = (url: string) => void revoked.push(url)
    const { result } = renderHook(() => useImages(() => Promise.resolve('/tmp/1.png'), 'open'))
    act(() => result.current.add([new File(['x'], 'a.png', { type: 'image/png' })]))
    await waitFor(() => expect(result.current.images[0]?.state).toBe('attached'))
    act(() => result.current.remove(result.current.images[0]!.id))
    expect(revoked).toEqual(['blob:preview/1'])
    expect(result.current.images).toEqual([])
  })
})
