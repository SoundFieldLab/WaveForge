/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DesktopSettingsModal from '../src/components/DesktopSettingsModal'

let tvBackHandler: (() => boolean) | null = null
vi.mock('../src/tv/tvCore', () => ({
  useTvBack: (handler: () => boolean) => { tvBackHandler = handler },
}))
vi.mock('../src/components/MirroredGlobalSettings', () => ({
  MirroredGlobalSettings: () => null,
  makeSkin: () => ({}),
}))

const props = {
  show: true,
  onClose: vi.fn(),
  weWallpapers: [],
  weLoading: false,
  weError: null,
  selectedWeWallpaper: null,
  wallpaperSyncEnabled: false,
  onScanWeWallpapers: vi.fn(),
  onSelectWeWallpaper: vi.fn(),
  wallpaperRotation: { enabled: false, intervalMinutes: 30, order: 'sequential' as const },
  onWallpaperRotationChange: vi.fn(),
  onWallpaperSyncToggle: vi.fn(),
  onOpenCustomizer: vi.fn(),
}

afterEach(() => {
  cleanup()
  tvBackHandler = null
  props.onClose.mockReset()
})

describe('Desktop settings TV back', () => {
  it('returns from a submenu before closing the settings modal', async () => {
    render(<DesktopSettingsModal {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /自定义壁纸/ }))
    expect(screen.getByRole('heading', { level: 2, name: '自定义壁纸' })).toBeTruthy()

    expect(tvBackHandler?.()).toBe(true)
    expect(props.onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('heading', { name: '桌面模式设置' })).toBeTruthy())

    expect(tvBackHandler?.()).toBe(true)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})
