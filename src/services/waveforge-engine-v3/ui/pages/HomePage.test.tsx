// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EngineV3 } from '../../src/engine/EngineV3'
import type { V3EngineParams } from '../../src/types'
import type { HSETheme } from '../hse-theme'
import { createV3UiBridge } from '../bridge'
import { useV3Params } from '../hooks'
import HomePage from './HomePage'

const theme = {
  accentColor: '#006A63',
  textPrimary: 'text-primary',
  textSecondary: 'text-secondary',
  sliderTrack: (value: number, min: number, max: number) => `linear-gradient(to right, #006A63 ${((value - min) / (max - min)) * 100}%, #dce9e4 0)`,
} as HSETheme

function makePage(options?: {
  autoNormalize?: boolean
  sceneId?: string
  manualGain?: Partial<V3EngineParams['loudnessNormalization']>
}) {
  const bridge = createV3UiBridge(new EngineV3(48000, 2), 48000)
  if (options?.sceneId) bridge.applyScene(options.sceneId)
  if (options?.autoNormalize) {
    const params = bridge.getParams()
    bridge.setParams({
      ...params,
      loudnessNormalization: { ...params.loudnessNormalization, enabled: true, useRealtimeMeter: true },
    })
  }
  if (options?.manualGain) {
    const params = bridge.getParams()
    bridge.setParams({
      ...params,
      loudnessNormalization: {
        ...params.loudnessNormalization,
        enabled: true,
        useRealtimeMeter: false,
        ...options.manualGain,
      },
    })
  }
  const onOpenEffect = vi.fn()
  const onNavigate = vi.fn()

  function Harness() {
    const controller = useV3Params(bridge)
    return <HomePage bridge={bridge} controller={controller} theme={theme} onOpenEffect={onOpenEffect} onNavigate={onNavigate} />
  }

  return { bridge, onOpenEffect, onNavigate, view: render(<Harness />) }
}

describe('HSE 首页', () => {
  beforeEach(() => {
    localStorage.clear()
    // 本组只验证首页控制行为，不在 jsdom 中绘制 Canvas。
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('默认场景模式有明确状态，点击快捷模式应用真实场景', () => {
    const { bridge } = makePage()
    const studio = screen.getByRole('button', { name: 'Hi-Fi模式' })
    expect(studio.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(studio)
    expect(bridge.getParams().sceneId).toBe('studio')
    expect(studio.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '增强模式' }))
    expect(bridge.getParams().sceneId).toBe('enhanced')
    expect(screen.getByRole('button', { name: '增强模式' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('手动滑块按 externalGainDb 公式写入并且应用场景保留该通道', () => {
    const { bridge } = makePage()
    const slider = screen.getByRole('slider', { name: '输出音量' })
    fireEvent.change(slider, { target: { value: '20' } })

    expect(bridge.getParams().loudnessNormalization).toMatchObject({
      enabled: true,
      useRealtimeMeter: false,
      externalGainDb: -48,
      minGainDb: -60,
      maxGainDb: 12,
    })
    fireEvent.click(screen.getByRole('button', { name: '影院模式' }))
    expect(bridge.getParams().loudnessNormalization.externalGainDb).toBe(-48)
  })

  it('音量调整保留场景身份，百分比不损失小数增益', () => {
    const { bridge } = makePage({ sceneId: 'studio' })
    fireEvent.change(screen.getByRole('slider', { name: '输出音量' }), { target: { value: '81' } })

    expect(bridge.getParams().loudnessNormalization.externalGainDb).toBeCloseTo(-11.4)
    expect(bridge.getParams().customized).toBe(false)
    expect(screen.getByRole('button', { name: 'Hi-Fi模式' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('输出增益 -11.4 dB')).toBeTruthy()
  })

  it('自动响度时禁用百分比滑块，显式切到手动后可调', () => {
    const { bridge } = makePage({ autoNormalize: true, sceneId: 'studio' })
    const slider = screen.getByRole('slider', { name: '输出音量' }) as HTMLInputElement
    expect(slider.disabled).toBe(true)
    expect(screen.getByText(/自动响度/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '切换到手动音量' }))
    expect(slider.disabled).toBe(false)
    expect(bridge.getParams().loudnessNormalization.useRealtimeMeter).toBe(false)
    expect(bridge.getParams().loudnessNormalization.externalGainDb).toBe(0)
    expect(bridge.getParams().customized).toBe(false)
  })

  it('显示引擎限幅后的手动增益，并保留超出百分比范围的正增益', () => {
    makePage({ manualGain: { externalGainDb: 9, minGainDb: -12, maxGainDb: 6 } })
    const slider = screen.getByRole('slider', { name: '输出音量' }) as HTMLInputElement

    expect(screen.getByText('输出增益 +6.0 dB')).toBeTruthy()
    expect(slider.getAttribute('aria-valuetext')).toContain('当前输出增益 +6.0 dB')
    expect(screen.queryByText('100%')).toBeNull()
    expect(slider.value).toBe('100')
    expect(slider.disabled).toBe(false)
  })

  it('负增益也按 minGainDb 显示，最小音量明确标出 -60 dB', () => {
    const { bridge } = makePage({ manualGain: { externalGainDb: -48, minGainDb: -12, maxGainDb: 6 } })
    const slider = screen.getByRole('slider', { name: '输出音量' }) as HTMLInputElement
    expect(screen.getByText('输出增益 -12.0 dB')).toBeTruthy()
    expect(slider.value).toBe('80')

    fireEvent.change(slider, { target: { value: '0' } })
    expect(bridge.getParams().loudnessNormalization.externalGainDb).toBe(-60)
    expect(screen.getByText('0% 对应 -60 dB 最小输出电平，不是静音。')).toBeTruthy()
  })

  it('系统音效开关显示真实状态并可恢复关闭前的音效参数', () => {
    const { bridge } = makePage({ sceneId: 'enhanced' })
    const before = bridge.getParams()
    const master = screen.getByRole('switch', { name: '系统音效' })
    expect(master.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('已开启')).toBeTruthy()

    fireEvent.click(master)
    expect(master.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('已关闭')).toBeTruthy()
    expect(bridge.getParams().bassEnhancer.enabled).toBe(false)
    expect(bridge.getParams().reverb.enabled).toBe(false)
    expect(screen.queryByText('引擎运行中')).toBeNull()

    fireEvent.click(master)
    expect(master.getAttribute('aria-checked')).toBe('true')
    expect(bridge.getParams().bassEnhancer).toEqual(before.bassEnhancer)
    expect(bridge.getParams().reverb).toEqual(before.reverb)
  })

  it('音效关闭时调音量保持关闭，选择环境时恢复音效并保留音量', () => {
    const { bridge } = makePage({ sceneId: 'enhanced' })
    const master = screen.getByRole('switch', { name: '系统音效' })
    fireEvent.click(master)
    fireEvent.change(screen.getByRole('slider', { name: '输出音量' }), { target: { value: '50' } })

    expect(master.getAttribute('aria-checked')).toBe('false')
    expect(bridge.getParams().loudnessNormalization.externalGainDb).toBe(-30)
    expect(bridge.getParams().bassEnhancer.enabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '音乐厅' }))
    expect(master.getAttribute('aria-checked')).toBe('true')
    expect(bridge.getParams().loudnessNormalization.externalGainDb).toBe(-30)
    expect(bridge.getParams().reverb.algorithmic.type).toBe('hall')
    expect(bridge.getParams().customized).toBe(true)
  })

  it('环境选项写入混响模式并标记自定义，关闭选项真实旁路', () => {
    const { bridge } = makePage({ sceneId: 'studio' })
    fireEvent.click(screen.getByRole('button', { name: '音乐厅' }))
    expect(bridge.getParams().reverb).toMatchObject({
      enabled: true,
      mode: 'algorithmic',
      algorithmic: { type: 'hall' },
    })
    expect(bridge.getParams().customized).toBe(true)
    expect(screen.getByRole('button', { name: 'Hi-Fi模式' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '音乐厅' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '无混响' }))
    expect(bridge.getParams().reverb.enabled).toBe(false)
  })

  it('场景、详细调节与自定义混响入口保持真实路由', () => {
    const { onNavigate, onOpenEffect } = makePage()
    fireEvent.click(screen.getByRole('button', { name: '管理场景' }))
    expect(onNavigate).toHaveBeenLastCalledWith('scenes')
    fireEvent.click(screen.getByRole('button', { name: '详细调节' }))
    expect(onNavigate).toHaveBeenLastCalledWith('eq')
    fireEvent.click(screen.getByRole('button', { name: '自定义' }))
    expect(onOpenEffect).toHaveBeenLastCalledWith('reverb')
    fireEvent.click(screen.getByRole('button', { name: '调整环境' }))
    expect(onOpenEffect).toHaveBeenCalledTimes(2)
  })

  it('缺少 waveform bridge 时显示等待态且不生成装饰波形', () => {
    makePage()
    expect(screen.getByText('等待音频信号')).toBeTruthy()
    const canvas = screen.getByRole('img', { name: '实时立体声音频波形，左声道 L，右声道 R' }) as HTMLCanvasElement
    expect(canvas).toBeTruthy()
  })

  it('精细调节入口导航到真实页面，查看页面不会修改音效参数', () => {
    const { bridge, onNavigate } = makePage()
    const before = bridge.getParams()
    for (const [label, page] of [
      ['均衡器', 'eq'],
      ['空间音效', 'spatial'],
      ['空间音频', 'spatial-audio'],
      ['动态调音', 'dynamics'],
      ['分析', 'analysis'],
    ]) {
      fireEvent.click(screen.getByRole('button', { name: `打开${label}` }))
      expect(onNavigate).toHaveBeenLastCalledWith(page)
    }
    expect(bridge.getParams()).toEqual(before)
    expect(screen.getByRole('button', { name: '打开动态调音' }).textContent).toContain('1 项动态处理启用')
    expect(screen.getByRole('button', { name: '打开空间音效' }).textContent).toContain('空间效果未启用')
    fireEvent.click(screen.getByRole('button', { name: '音乐厅' }))
    expect(screen.getByRole('button', { name: '打开空间音效' }).textContent).toContain('空间效果已启用')
    fireEvent.click(screen.getByRole('switch', { name: '系统音效' }))
    expect(screen.getByRole('button', { name: '打开空间音效' }).textContent).toContain('空间效果未启用')
    // 总开关关闭时引擎仍保留限幅保护，入口状态必须与实际处理链一致。
    expect(bridge.getParams().limiter.enabled).toBe(true)
    expect(screen.getByRole('button', { name: '打开动态调音' }).textContent).toContain('1 项动态处理启用')
  })
})
