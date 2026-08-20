/**
 * SpatialRingEditor · Solo 多扬声器回归（O3 审计 P1 修复）
 *
 * 背景：旧 handleSolo 逐只调 onToggleMuted，而 SpatialPage.handleToggleMuted 闭包
 * 读 React state spatial（事件内不更新）构建 next 数组——后一次 patch 覆盖前一次，
 * Solo 多扬声器时仅末只生效（muted=[F,F,F] Solo 第 2 只 → 旧实现仅 [F,F,T]）。
 * 修复：SpatialPage 暴露 onSoloSpeaker，基于 getSpatialParams() 全局最新一次性构建
 * 目标数组（其它 muted=true、本只 false）单次 patch；编辑器 handleSolo 优先走它。
 *
 * 覆盖：
 *  - 主路径（onSoloSpeaker 接线）：Solo 第 2 只 → muted=[T,F,T]，且 onToggleMuted
 *    不被调用（证明走单次提交、非逐只循环）；
 *  - 向后兼容（onSoloSpeaker 缺省）：handleSolo 回退逐只翻转，onToggleMuted 被调
 *    用于与目标态不同的扬声器（第 0/2 只），第 1 只已为目标态跳过。
 *
 * 环境：jsdom（Canvas 2D 上下文 jsdom 不实现，绘制 effect 早退无碍；hit-test 走
 * getBoundingClientRect，故 stub 几何为可预测的 360×240）。
 */

// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import { SpatialRingEditor } from './SpatialRingEditor'
import type { HSETheme } from '../hse-theme'
import type { VirtualSpeakerCfg } from '../../src/spatial/types'

/** 测试用 HSE 主题（与 useHSETheme 默认值同义的最小对象，不依赖 hook/window） */
const theme: HSETheme = {
  dark: true,
  accentColor: '#22d3ee',
  accentGlow: '#22d3ee44',
  accentDim: '#22d3ee22',
  accentFrom: '#22d3ee',
  accentTo: '#7c3aed',
  accentGradient: 'linear-gradient(135deg, #22d3ee 0%, #7c3aed 100%)',
  panelBg: 'rgba(18, 18, 22, 0.85)',
  panelBorder: 'rgba(255,255,255,0.08)',
  panelHighlight: 'linear-gradient(160deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 45%, rgba(255,255,255,0.04) 100%)',
  cardBg: 'linear-gradient(150deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.015) 100%)',
  cardBorder: 'rgba(255,255,255,0.08)',
  cardGlow: '0 8px 24px rgba(0,0,0,0.25)',
  navBg: 'rgba(12,12,16,0.7)',
  navActiveBg: 'linear-gradient(135deg, #22d3ee22 0%, transparent 60%)',
  navActiveBorder: '#22d3ee66',
  navHoverBg: 'rgba(255,255,255,0.04)',
  textPrimary: 'text-white',
  textSecondary: 'text-white/70',
  textTertiary: 'text-white/45',
  textMuted: 'text-white/25',
  inputBg: 'rgba(255,255,255,0.04)',
  trackBg: 'rgba(255,255,255,0.10)',
  trackFill: '#22d3ee',
  statusOk: '#4ade80',
  statusWarn: '#fbbf24',
  glassBlur: 'blur(24px) saturate(160%)',
  glassCardBlur: 'blur(16px) saturate(140%)',
  sliderTrack: () => 'linear-gradient(to right, #22d3ee 0%, #7c3aed 100%)',
}

/** 3 只扬声器，方位角 0/90/180°、距离 2m、均未静音（muted=[F,F,F]）。
 *  hit-test 几何可预测（stub 360×240 → 半径 102、圆心 (180,120)）。 */
const SPEAKERS: VirtualSpeakerCfg[] = [
  { azimuthDeg: 0, elevationDeg: 0, distance: 2, gain: 1, size: 0 },
  { azimuthDeg: 90, elevationDeg: 0, distance: 2, gain: 1, size: 0 },
  { azimuthDeg: 180, elevationDeg: 0, distance: 2, gain: 1, size: 0 },
]

/** stub canvas 几何：jsdom 默认 getBoundingClientRect 全零，hit-test 边界脆弱。
 *  360×240 → ringGeometry 半径 max(40, 120-18)=102、圆心 (180,120)。 */
function stubCanvasGeometry(container: HTMLElement): HTMLCanvasElement {
  const canvas = container.querySelector('canvas') as HTMLCanvasElement
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => ({
      left: 0,
      top: 0,
      width: 360,
      height: 240,
      right: 360,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
    configurable: true,
  })
  return canvas
}

/**
 * Solo 测试夹具（接线路径）：speakers 存 React state；onSoloSpeaker 以函数式
 * setSpeakers(prev => …) 单次提交目标数组——函数式更新读取最新 state，等价于
 * SpatialPage.handleSoloSpeaker 的 getSpatialParams() 读全局快照。muted 经
 * data-testid 哨兵暴露供断言；onToggleMuted 为 spy 以断言「不被调用」。
 */
function SoloHarness({ onToggleMuted }: { onToggleMuted: (index: number) => void }) {
  const [speakers, setSpeakers] = useState(SPEAKERS)
  const muted = speakers.map((s) => s.muted === true)
  // 复刻 SpatialPage.handleSoloSpeaker：单次构建目标数组、单次提交
  const handleSoloSpeaker = (index: number) => {
    setSpeakers((prev) =>
      prev.map((s, i) => (i === index ? { ...s, muted: false } : { ...s, muted: true })),
    )
  }
  return (
    <>
      <SpatialRingEditor
        speakers={speakers}
        editable
        onChangeSpeaker={() => undefined}
        onDeleteSpeaker={() => undefined}
        onAddSpeaker={() => undefined}
        theme={theme}
        muted={muted}
        onToggleMuted={onToggleMuted}
        onDuplicateSpeaker={() => undefined}
        onSoloSpeaker={handleSoloSpeaker}
      />
      <div data-testid="muted-state">{muted.join(',')}</div>
    </>
  )
}

describe('SpatialRingEditor · Solo 多扬声器回归（O3 P1）', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('onSoloSpeaker 接线：Solo 第 2 只 → 其它静音、本只不静音 [T,F,T]，且不走逐只 onToggleMuted', () => {
    const onToggleMuted = vi.fn()
    const { container } = render(<SoloHarness onToggleMuted={onToggleMuted} />)
    const canvas = stubCanvasGeometry(container)
    // 第 2 只（index 1，az=90°、dist=2m）→ 屏幕 {225.6, 120}，命中半径 14 内
    fireEvent.contextMenu(canvas, { clientX: 226, clientY: 120 })
    const soloBtn = screen.getByRole('button', { name: 'Solo' })
    fireEvent.click(soloBtn)

    expect(screen.getByTestId('muted-state').textContent).toBe('true,false,true')
    // 修复核心：走单次提交路径，不再逐只调 onToggleMuted（旧路径末只覆盖前只的根因）
    expect(onToggleMuted).not.toHaveBeenCalled()
  })

  it('向后兼容：onSoloSpeaker 缺省时回退逐只翻转 onToggleMuted（仅与目标态不同的扬声器）', () => {
    const onToggleMuted = vi.fn()
    const { container } = render(
      <SpatialRingEditor
        speakers={SPEAKERS}
        editable
        onChangeSpeaker={() => undefined}
        onDeleteSpeaker={() => undefined}
        onAddSpeaker={() => undefined}
        theme={theme}
        muted={SPEAKERS.map(() => false)}
        onToggleMuted={onToggleMuted}
        onDuplicateSpeaker={() => undefined}
        // 不传 onSoloSpeaker：走回退循环逻辑（向后兼容）
      />,
    )
    const canvas = stubCanvasGeometry(container)
    fireEvent.contextMenu(canvas, { clientX: 226, clientY: 120 })
    const soloBtn = screen.getByRole('button', { name: 'Solo' })
    fireEvent.click(soloBtn)

    // 目标态：第 0/2 只需翻转（false→true），第 1 只已为目标态（false）跳过
    expect(onToggleMuted).toHaveBeenCalledTimes(2)
    expect(onToggleMuted).toHaveBeenNthCalledWith(1, 0)
    expect(onToggleMuted).toHaveBeenNthCalledWith(2, 2)
  })
})
