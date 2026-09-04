/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { FoliaTransitionOverlay } from '../src/components/folia/FoliaTransitionOverlay'
import { FoliaUpNextCard } from '../src/components/folia/FoliaUpNextCard'

afterEach(cleanup)

describe('Folia transition presentation components', () => {
  it('renders next track and calls the shared skip action', () => {
    const onActivate = vi.fn()
    render(<FoliaUpNextCard visible isTransitioning progress={0.42} current={{ title: 'A', artist: 'AA' }} next={{ title: 'B', artist: 'BB' }} onActivate={onActivate} theme="dark" accentColor="#3b82f6" />)
    expect(screen.getByText('接下来播放')).toBeTruthy()
    expect(screen.getByText('B')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(onActivate).toHaveBeenCalledOnce()
  })

  it('hides the central overlay when the card border owns progress', () => {
    const { rerender } = render(<FoliaTransitionOverlay visible suppressed progress={0.4} duration={10} accentColor="#3b82f6" theme="dark" />)
    expect(screen.queryByTestId('folia-transition-overlay')).toBeNull()
    rerender(<FoliaTransitionOverlay visible progress={0.4} duration={10} accentColor="#3b82f6" theme="light" />)
    expect(screen.getByLabelText('AutoMix 过渡进行中')).toBeTruthy()
    expect(screen.getByText('40%')).toBeTruthy()
  })

  it('suppresses short transitions and supports dismissal', () => {
    const dismiss = vi.fn()
    const { rerender } = render(<FoliaTransitionOverlay visible progress={0.2} duration={4.9} accentColor="#3b82f6" theme="dark" onDismiss={dismiss} />)
    expect(screen.queryByTestId('folia-transition-overlay')).toBeNull()
    rerender(<FoliaTransitionOverlay visible progress={0.2} duration={8} accentColor="#3b82f6" theme="dark" onDismiss={dismiss} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dismiss).toHaveBeenCalledOnce()
  })
})
