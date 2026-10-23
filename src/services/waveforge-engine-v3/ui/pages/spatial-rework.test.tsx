// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { EngineV3 } from '../../src/engine/EngineV3'
import { createV3UiBridge } from '../bridge'
import { useV3Params } from '../hooks'
import { useHSETheme } from '../hse-theme'
import SpatialAudioPage from './SpatialAudioPage'

function setup(mode: 'world' | 'headLocked' | 'instant' | 'stage' = 'world') {
  const engine = new EngineV3(48000), bridge = createV3UiBridge(engine, 48000)
  const p = bridge.getParams(); p.spatial!.mode = mode; bridge.setParams(p)
  function Harness() { return <SpatialAudioPage bridge={bridge} controller={useV3Params(bridge)} theme={useHSETheme()} initialView="top" /> }
  render(<Harness />)
  return { engine, bridge }
}
beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('空间重做 UI 的用户操作', () => {
  it.each(['instant', 'headLocked', 'world', 'stage'] as const)('A/B 和电源恢复关闭前的 %s 模式及其参数', mode => {
    const { bridge } = setup(mode)
    fireEvent.change(screen.getByRole('slider', { name: '空间强度' }), { target: { value: '37' } })
    const before = bridge.getParams().spatial
    fireEvent.click(screen.getByRole('button', { name: 'A · 原声' }))
    expect(bridge.getParams().spatial).toEqual({ ...before, mode: 'off' })
    expect(screen.getByRole('button', { name: 'A · 原声' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'B · 空间' }))
    expect(bridge.getParams().spatial).toEqual(before)
    fireEvent.click(screen.getByRole('switch', { name: '空间音频' }))
    expect(bridge.getParams().spatial!.mode).toBe('off')
    fireEvent.click(screen.getByRole('switch', { name: '空间音频' }))
    expect(bridge.getParams().spatial).toEqual(before)
  })
  it('四个模式按钮更新真实引擎，原声对比中改选模式立即生效', () => {
    const { bridge } = setup()
    const group = within(screen.getByRole('group', { name: '空间模式' }))
    for (const [label, mode] of [
      ['快速空间化', 'instant'], ['扬声器布局', 'headLocked'], ['自由声场', 'world'], ['房间预设', 'stage'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: 'A · 原声' }))
      const button = group.getByRole('button', { name: new RegExp(`^${label}`) })
      fireEvent.click(button)
      expect(bridge.getParams().spatial!.mode).toBe(mode)
      expect(button.getAttribute('aria-pressed')).toBe('true')
      expect(screen.getByRole('button', { name: 'B · 空间' }).getAttribute('aria-pressed')).toBe('true')
    }
  })
  it('直接编辑位置和朝向保留两项最新值，普通 Tab 不被截获', () => {
    const { bridge } = setup()
    fireEvent.click(screen.getByText('听者位置、朝向与声源轨迹'))
    fireEvent.change(screen.getByRole('spinbutton', { name: '听者 X m' }), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '听者朝向 °' }), { target: { value: '35' } })
    expect(bridge.getParams().spatial!.world.listener.position.x).toBe(2)
    expect(bridge.getParams().spatial!.world.listener.yaw).toBe(35)
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    window.dispatchEvent(event); expect(event.defaultPrevented).toBe(false)
  })
  it('俯视/侧视共享选中声源，位置和输入声道绑定直接生效', () => {
    const { bridge } = setup()
    fireEvent.click(within(screen.getByRole('group', { name: '二维声源列表' })).getByRole('button', { name: /左声道 1/ }))
    fireEvent.change(screen.getByRole('spinbutton', { name: '左右 X m' }), { target: { value: '-3.5' } })
    fireEvent.click(screen.getByRole('radio', { name: '差分 S' }))
    fireEvent.click(screen.getByRole('radio', { name: '侧视' }))
    expect(screen.getByRole('spinbutton', { name: '左右 X m' }).getAttribute('value')).toBe('-3.5')
    expect(bridge.getParams().spatial!.world.sources[0].route).toBe('side')
    expect(bridge.getParams().spatial!.world.sources[0].position.x).toBe(-3.5)
    expect(screen.queryByText('人声')).toBeNull()
  })
  it('扬声器静音/独奏可操作，退出独奏恢复静音状态并保留独奏期间的编辑', () => {
    const { bridge } = setup('headLocked')
    fireEvent.click(within(screen.getByRole('group', { name: '二维声源列表' })).getByRole('button', { name: /#1/ }))
    fireEvent.click(screen.getByRole('button', { name: '静音' }))
    expect(bridge.getParams().spatial!.headLocked.speakers[0].muted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '独奏' }))
    expect(bridge.getParams().spatial!.headLocked.speakers.filter(speaker => !speaker.muted)).toHaveLength(1)
    fireEvent.change(screen.getByRole('spinbutton', { name: '方位角 °' }), { target: { value: '-45' } })
    fireEvent.change(screen.getByRole('slider', { name: '声源音量' }), { target: { value: '0.75' } })
    fireEvent.click(screen.getByRole('button', { name: '退出独奏' }))
    expect(bridge.getParams().spatial!.headLocked.speakers[0].muted).toBe(true)
    expect(bridge.getParams().spatial!.headLocked.speakers[0].azimuthDeg).toBe(-45)
    expect(bridge.getParams().spatial!.headLocked.speakers[0].gain).toBe(0.75)
    expect(bridge.getParams().spatial!.headLocked.speakers[1].muted).not.toBe(true)
  })
  it('没有 Atmos、360RA 或物理多声道输出入口', () => {
    setup('instant')
    fireEvent.click(screen.getByRole('button', { name: '设备与高级设置' }))
    expect(screen.getByRole('button', { name: '导入 SOFA' })).toBeTruthy()
    expect(screen.queryByText(/Atmos|360RA|真实多声道输出/)).toBeNull()
  })
})
