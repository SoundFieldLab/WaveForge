// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EngineV3 } from '../src/engine/EngineV3'
import { createV3UiBridge } from './bridge'
import { EqPanel } from './eqPanel'
import { toLegacyTheme, useHSETheme } from './hse-theme'
import { useV3Params } from './hooks'

function makePanel() {
  const bridge = createV3UiBridge(new EngineV3(48000, 2), 48000)
  const params = bridge.getParams()
  bridge.setParams({ ...params, eq: { ...params.eq, enabled: true, mode: 'pro' } })
  function Harness() {
    return <EqPanel controller={useV3Params(bridge)} theme={toLegacyTheme(useHSETheme())} />
  }
  const view = render(<Harness />)
  return { bridge, view }
}

describe('HSE 均衡器编辑', () => {
  it('可增减自定义频段，段数与分享串保持一致', () => {
    const { bridge } = makePanel()
    fireEvent.click(screen.getByRole('button', { name: '添加频段' }))
    expect(bridge.getParams().eq.bandCount).toBe(11)
    expect(bridge.getParams().eq.proBands).toHaveLength(11)
    fireEvent.click(screen.getByRole('button', { name: '删除选中频段' }))
    expect(bridge.getParams().eq.bandCount).toBe(10)
    expect(bridge.getParams().eq.proBands).toHaveLength(10)
  })
  beforeEach(() => localStorage.clear())
  afterEach(() => cleanup())

  it('频段列表、曲线选中态与三个数值输入保持同步', () => {
    makePanel()
    fireEvent.click(screen.getByRole('button', { name: '250 Hz' }))
    expect(screen.getByRole('spinbutton', { name: '频率 Hz' }).getAttribute('value')).toBe('250.0')
    expect(screen.getByRole('button', { name: '选择 250 Hz 频段' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.keyDown(screen.getByRole('button', { name: '选择 1000 Hz 频段' }), { key: 'Enter' })
    expect(screen.getByRole('spinbutton', { name: '频率 Hz' }).getAttribute('value')).toBe('1000.0')
    expect(screen.getByRole('button', { name: '1000 Hz' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('20 段缩回 10 段后保留选择、Q 值与滤波器类型', () => {
    const { bridge } = makePanel()
    fireEvent.click(screen.getByRole('button', { name: '16000 Hz' }))
    const qInput = screen.getByRole('spinbutton', { name: 'Q 值' })
    fireEvent.focus(qInput)
    fireEvent.change(qInput, { target: { value: '1.67' } })
    fireEvent.blur(qInput)
    fireEvent.change(screen.getByRole('combobox', { name: '滤波器类型' }), { target: { value: 'notch' } })
    fireEvent.click(screen.getByRole('button', { name: '20 段' }))
    fireEvent.click(screen.getByRole('button', { name: '16000 Hz' }))
    fireEvent.click(screen.getByRole('button', { name: '10 段' }))

    expect(bridge.getParams().eq.proBands).toHaveLength(10)
    expect(screen.getByRole('spinbutton', { name: '频率 Hz' }).getAttribute('value')).toBe('16000.0')
    expect(screen.getByRole('spinbutton', { name: 'Q 值' }).getAttribute('value')).toBe('1.67')
    expect((screen.getByRole('combobox', { name: '滤波器类型' }) as HTMLSelectElement).value).toBe('notch')
    expect(screen.getByRole('button', { name: '选择 16000 Hz 频段' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('Enter 加失焦只提交一次，增益与 Q 分别按一位和两位小数显示', () => {
    const { bridge } = makePanel()
    const setParams = vi.spyOn(bridge, 'setParams')
    const gain = screen.getByRole('spinbutton', { name: '增益 dB' })
    fireEvent.focus(gain)
    fireEvent.change(gain, { target: { value: '3.456' } })
    fireEvent.keyDown(gain, { key: 'Enter' })
    fireEvent.blur(gain)
    expect(setParams).toHaveBeenCalledTimes(1)
    expect(bridge.getParams().eq.proBands[0].gain).toBe(3.5)
    expect(gain.getAttribute('value')).toBe('3.5')

    const q = screen.getByRole('spinbutton', { name: 'Q 值' })
    fireEvent.focus(q)
    fireEvent.change(q, { target: { value: '1.6789' } })
    fireEvent.blur(q)
    expect(bridge.getParams().eq.proBands[0].q).toBe(1.68)
    expect(q.getAttribute('value')).toBe('1.68')
  })

  it('锁定保留 Q 补偿控制且禁止数值、滑杆和曲线键盘改值', () => {
    const { bridge } = makePanel()
    const compensation = screen.getByRole('switch', { name: '级联 Q 补偿' })
    fireEvent.click(compensation)
    expect(bridge.getParams().eq.qCompensation).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '锁定' }))
    expect((screen.getByRole('spinbutton', { name: '增益 dB' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('slider', { name: '31.5 Hz 增益' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('button', { name: '选择 31.5 Hz 频段' }), { key: 'ArrowUp' })
    expect(bridge.getParams().eq.proBands[0].gain).toBe(0)
    fireEvent.click(compensation)
    expect(bridge.getParams().eq.qCompensation).toBe(true)
  })

  it('64 段布局一键生成 64 个对数频点（20Hz–16kHz），新频段默认 Q 9.4', () => {
    const { bridge } = makePanel()
    fireEvent.click(screen.getByRole('button', { name: '64 段' }))
    const eq = bridge.getParams().eq
    expect(eq.bandCount).toBe(64)
    expect(eq.proBands).toHaveLength(64)
    expect(eq.proBands[0].frequency).toBeCloseTo(20, 1)
    expect(eq.proBands[63].frequency).toBeCloseTo(16000, 0)
    expect(eq.proBands[32].q).toBeCloseTo(9.4, 5)
    expect(screen.getByText(/64 \/ 64 段/)).toBeTruthy()
  })

  it('20 段清空仍保留段数和 Q，并且专业增益支持引擎的正负 20 dB', () => {
    const { bridge } = makePanel()
    fireEvent.click(screen.getByRole('button', { name: '20 段' }))
    const gain = screen.getByRole('spinbutton', { name: '增益 dB' })
    fireEvent.focus(gain)
    fireEvent.change(gain, { target: { value: '99' } })
    fireEvent.blur(gain)
    expect(bridge.getParams().eq.proBands.some((band) => band.gain === 20)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(bridge.getParams().eq.bandCount).toBe(20)
    expect(bridge.getParams().eq.proBands).toHaveLength(20)
    expect(bridge.getParams().eq.proBands.every((band) => band.gain === 0)).toBe(true)
  })

  it('陷波类型禁用无效增益控件，清空后恢复平直峰值段', () => {
    const { bridge } = makePanel()
    fireEvent.change(screen.getByRole('combobox', { name: '滤波器类型' }), { target: { value: 'notch' } })
    expect((screen.getByRole('spinbutton', { name: '增益 dB' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('slider', { name: '31.5 Hz 增益' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    expect(bridge.getParams().eq.proBands[0].type).toBe('peaking')
    expect((screen.getByRole('slider', { name: '31.5 Hz 增益' }) as HTMLInputElement).disabled).toBe(false)
  })
})
