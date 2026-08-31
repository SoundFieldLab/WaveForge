/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { StemMixerPopover, type TrackStemControlModel } from '../src/components/StemMixerPopover'

afterEach(cleanup)

function control(overrides: Partial<TrackStemControlModel> = {}): TrackStemControlModel {
  return {
    status: 'ready',
    gains: { vocals: 1, drums: 1, bass: 1, other: 1 },
    availableStems: ['vocals', 'drums', 'bass', 'other'],
    progress: 1,
    active: true,
    onEnable: vi.fn(), onVocalChange: vi.fn(), onStemChange: vi.fn(), onReturnOriginal: vi.fn(),
    ...overrides,
  }
}

describe('StemMixerPopover', () => {
  it('defaults the vocal macro to original 100%', () => {
    render(<StemMixerPopover control={control()} accentColor="#3b82f6" theme="dark" />)
    fireEvent.click(screen.getByRole('button', { name: '人声与乐器调节' }))
    expect((screen.getByRole('slider', { name: '人声音量' }) as HTMLInputElement).value).toBe('100')
    expect(screen.getByText('人声 100%')).toBeTruthy()
  })

  it('opens while unavailable, explains why, and re-probes installation once', () => {
    const model = control({ status: 'unavailable', active: false, reason: '请先安装 HTDemucs', availableStems: [] })
    render(<StemMixerPopover control={model} accentColor="#3b82f6" theme="light" />)
    fireEvent.click(screen.getByRole('button', { name: '人声与乐器调节' }))
    expect(screen.getByText('请先安装 HTDemucs')).toBeTruthy()
    expect(model.onEnable).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重新检测并准备分轨' }))
    expect(model.onEnable).toHaveBeenCalledOnce()
    expect((screen.getByRole('slider', { name: '人声音量' }) as HTMLInputElement).disabled).toBe(true)
  })

  it('changes vocal macro and exposes custom stem sliders up to 120%', () => {
    const model = control()
    render(<StemMixerPopover control={model} accentColor="#3b82f6" theme="dark" />)
    fireEvent.click(screen.getByRole('button', { name: '人声与乐器调节' }))
    fireEvent.change(screen.getByRole('slider', { name: '人声音量' }), { target: { value: '35' } })
    expect(model.onVocalChange).toHaveBeenCalledWith(0.35)
    fireEvent.click(screen.getByRole('button', { name: '自定义' }))
    const bass = screen.getByRole('slider', { name: '贝斯增益' })
    expect((bass as HTMLInputElement).max).toBe('120')
    fireEvent.change(bass, { target: { value: '120' } })
    expect(model.onStemChange).toHaveBeenCalledWith('bass', 1.2)
  })

  it('locks all controls while AutoMix owns the stem gains', () => {
    render(<StemMixerPopover control={control({ locked: true })} accentColor="#3b82f6" theme="dark" />)
    expect((screen.getByRole('button', { name: '人声与乐器调节' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
