/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ImmersiveControls from '../src/components/ImmersiveControls'
import type { TrackStemControlModel } from '../src/components/StemMixerPopover'

let tvMode = false
let remoteCursorMode = false

vi.mock('../src/tv/tvCore', () => ({
  useTvMode: () => tvMode,
  useRemoteCursorMode: () => remoteCursorMode,
}))

vi.mock('../src/components/QuickSettings', () => ({
  default: () => <button type="button" aria-label="快速设置" />,
}))

function stemControl(): TrackStemControlModel {
  return {
    status: 'ready',
    gains: { vocals: 1, drums: 1, bass: 1, other: 1 },
    availableStems: ['vocals', 'drums', 'bass', 'other'],
    active: true,
    onEnable: vi.fn(),
    onVocalChange: vi.fn(),
    onStemChange: vi.fn(),
    onReturnOriginal: vi.fn(),
  }
}

const baseProps = {
  onHomeClick: vi.fn(),
  onTranslationToggle: vi.fn(),
  translationEnabled: false,
  hasTranslation: true,
  onRomanToggle: vi.fn(),
  romanEnabled: false,
  hasRoman: true,
  onMvBackgroundToggle: vi.fn(),
}

beforeEach(() => {
  tvMode = false
  remoteCursorMode = false
})

afterEach(cleanup)

describe('ImmersiveControls', () => {
  it('renders the optional stem control after feature rows and grows the desktop rail', () => {
    const { container } = render(<ImmersiveControls {...baseProps} stemControl={stemControl()} />)

    const stemButton = screen.getByRole('button', { name: '人声与乐器调节' })
    expect(stemButton.className).toContain('p-3')
    expect(stemButton.parentElement?.parentElement?.style.top).toBe('16rem')
    expect(screen.getByRole('button', { name: '快速设置' }).parentElement?.style.top).toBe('20rem')
    expect((container.firstElementChild as HTMLElement).style.height).toBe('414px')
  })

  it('omits the stem row when no control is provided', () => {
    render(<ImmersiveControls {...baseProps} />)

    expect(screen.queryByRole('button', { name: '人声与乐器调节' })).toBeNull()
    expect(screen.getByRole('button', { name: '快速设置' }).parentElement?.style.top).toBe('16rem')
  })

  it('uses compact TV row spacing and trigger sizing', () => {
    tvMode = true
    const { container } = render(<ImmersiveControls {...baseProps} stemControl={stemControl()} />)

    const stemButton = screen.getByRole('button', { name: '人声与乐器调节' })
    expect(stemButton.className).toContain('p-2.5')
    expect(stemButton.parentElement?.parentElement?.style.top).toBe('12.8rem')
    expect(screen.getByRole('button', { name: '快速设置' }).parentElement?.style.top).toBe('16rem')
    expect((container.firstElementChild as HTMLElement).style.height).toBe('310px')
  })
})
