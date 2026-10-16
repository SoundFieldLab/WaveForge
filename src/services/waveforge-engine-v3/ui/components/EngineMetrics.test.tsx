// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { EngineV3 } from '../../src/engine/EngineV3'
import type { EngineStats } from '../../src/types'
import { createV3UiBridge } from '../bridge'
import { useHSETheme } from '../hse-theme'
import { EngineMetrics } from './EngineMetrics'

function makeMetrics(stats: EngineStats) {
  const bridge = createV3UiBridge(new EngineV3(48000, 2), 48000)
  const getStats = vi.spyOn(bridge, 'getStats').mockReturnValue(stats)
  const setParams = vi.spyOn(bridge, 'setParams')
  function Harness() {
    return <EngineMetrics bridge={bridge} theme={useHSETheme()} />
  }
  return { bridge, getStats, setParams, view: render(<Harness />) }
}

const measured: EngineStats = {
  lufsIntegrated: -14.3,
  lufsMomentary: -12.5,
  lra: 6.7,
  peakDb: -2.4,
  truePeakDb: -1.8,
  limiterReductionDb: -0.6,
  engineLatencySamples: 240,
}

describe('首页音频读数', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('主指标和补充读数来自引擎，显示对应单位', () => {
    makeMetrics(measured)
    const primary = within(screen.getByLabelText('引擎实时指标'))
    expect(primary.getByText('-14.3')).toBeTruthy()
    expect(primary.getByText('LUFS')).toBeTruthy()
    expect(primary.getByText('5.0')).toBeTruthy()
    expect(primary.getByText('ms')).toBeTruthy()
    expect(primary.getByText('-0.6')).toBeTruthy()
    const secondary = within(screen.getByLabelText('补充音频读数'))
    expect(secondary.getByText('峰值')).toBeTruthy()
    expect(secondary.getByText('-2.4')).toBeTruthy()
    expect(secondary.getByText('真峰值')).toBeTruthy()
    expect(secondary.getByText('-1.8')).toBeTruthy()
    expect(secondary.getAllByText('dBFS')).toHaveLength(2)
    expect(secondary.getByText('响度范围')).toBeTruthy()
    expect(secondary.getByText('6.7')).toBeTruthy()
    expect(secondary.getByText('LU')).toBeTruthy()
  })

  it('读数独立定时更新，不写配置，卸载后停止轮询', () => {
    const { bridge, getStats, setParams, view } = makeMetrics(measured)
    const params = bridge.getParams()
    getStats.mockReturnValue({ ...measured, lufsIntegrated: -16.2, peakDb: -3.1, truePeakDb: -2.8, lra: 8.4 })
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getByText('-16.2')).toBeTruthy()
    expect(screen.getByText('-3.1')).toBeTruthy()
    expect(screen.getByText('-2.8')).toBeTruthy()
    expect(screen.getByText('8.4')).toBeTruthy()
    expect(setParams).not.toHaveBeenCalled()
    expect(bridge.getParams()).toEqual(params)
    view.unmount()
    getStats.mockClear()
    act(() => { vi.advanceTimersByTime(900) })
    expect(getStats).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('静音或测量不足时显示占位，异常采样率不显示无穷延迟', () => {
    const unavailable = {
      ...measured, lufsIntegrated: NaN, peakDb: -Infinity, truePeakDb: -Infinity, lra: NaN,
    }
    const { bridge, getStats, view } = makeMetrics(unavailable)
    vi.spyOn(bridge, 'getSampleRate').mockReturnValue(0)
    getStats.mockReturnValue({ ...unavailable })
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.getAllByText('—')).toHaveLength(5)
    expect(view.container.textContent).not.toMatch(/NaN|Infinity/)
  })
})
