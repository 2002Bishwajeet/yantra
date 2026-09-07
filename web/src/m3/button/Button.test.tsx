import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Link } from '@tanstack/react-router'
import { renderRouted } from '@/test/inRouter'
import { Button } from './Button'

describe('Button', () => {
  it('is a native button with the filled defaults', () => {
    render(<Button>Answer</Button>)
    const button = screen.getByRole('button', { name: 'Answer' })
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.dataset.variant).toBe('filled')
    expect(button.dataset.size).toBe('s')
    expect(button.className).toContain('m3-interactive')
  })

  it.each(['filled', 'tonal', 'outlined', 'text'] as const)('draws %s', (variant) => {
    render(<Button variant={variant} tone="error" size="m">Kill</Button>)
    const button = screen.getByRole('button', { name: 'Kill' })
    expect(button.dataset.variant).toBe(variant)
    expect(button.dataset.tone).toBe('error')
    expect(button.dataset.size).toBe('m')
    // The 12 % container rule applies to the two variants that have one.
    expect(button.hasAttribute('data-filled')).toBe(variant === 'filled' || variant === 'tonal')
  })

  /** jsdom fires no click for Enter or Space on a native button, and neither
   *  does Base UI: the browser does. So this proves the click and that the
   *  element is the native button that gives the keys for free. */
  it('fires on click and not when disabled', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Go</Button>)
    const button = screen.getByRole('button', { name: 'Go' })
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    cleanup()
    render(<Button disabled onClick={onClick}>Go</Button>)
    const off = screen.getByRole('button', { name: 'Go' })
    expect(off).toHaveProperty('disabled', true)
    fireEvent.click(off)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('hides a decorative icon and keeps the label as the name', () => {
    render(<Button icon={<svg data-testid="i" />}>New</Button>)
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy()
    expect(screen.getByTestId('i').parentElement?.getAttribute('aria-hidden')).toBe('true')
  })

  it('becomes a link through render, with no button attributes and no warning', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderRouted(<Button render={<Link to="/" />}>Open</Button>)
    const link = screen.getByRole('link', { name: 'Open' })
    expect(link.getAttribute('href')).toBe('/')
    expect(link.className).toContain('m3-button')
    expect(link.hasAttribute('type')).toBe(false)
    expect(link.hasAttribute('role')).toBe(false)
    expect(complained).not.toHaveBeenCalled()
    complained.mockRestore()
  })
})
