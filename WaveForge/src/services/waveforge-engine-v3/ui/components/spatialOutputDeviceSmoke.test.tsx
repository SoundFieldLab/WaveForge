/**
 * 空间音频：输出设备选择 UI 冒烟（jsdom）
 *
 * 覆盖：
 *  - SpatialStudioLayout 状态栏「输出」只读展示：sinkId 缺省 → 系统默认、
 *    有 sinkId → 已选设备。
 *
 * 历史：弹窗「输出设备」区与 fusion 层 enumerateDevices/setSinkId/getSpatialParams
 * 联动用例（原测试 1-3）随空间音频内联 EngineV3、独立 fusion worklet 层移除而删除
 * （fusion.ts / sofa.ts / gridSource.ts 已删，输出设备切换标注「开发中」后续 wave 接
 * 主播放器 AudioContext.setSinkId）。SpatialStudioLayout 状态栏「输出」为静态展示，
 * 不依赖已删模块，保留。
 *
 * 环境：文件头 @vitest-environment jsdom（与 uiSmoke.test.tsx 同范式）。
 */

// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import SpatialStudioLayout from './SpatialStudioLayout'
import { createDefaultSpatialParams } from '../../src/spatial/types'
import type { HSETheme } from '../hse-theme'

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

describe('空间音频：输出设备选择 UI 冒烟', () => {
  it('布局：状态栏「输出」只读展示（系统默认 / 已选设备）', () => {
    const common = {
      theme,
      onPatch: () => undefined,
      onHeadLockedLayout: () => undefined,
      selectedWorldId: null,
      onSelectWorld: () => undefined,
    }
    const { rerender } = render(
      <SpatialStudioLayout mode="instant" spatial={createDefaultSpatialParams()} {...common} />,
    )
    expect(screen.getByText('系统默认')).toBeTruthy()
    rerender(
      <SpatialStudioLayout mode="instant" spatial={{ ...createDefaultSpatialParams(), sinkId: 'dev-a' }} {...common} />,
    )
    expect(screen.getByText('已选设备')).toBeTruthy()
  })
})
