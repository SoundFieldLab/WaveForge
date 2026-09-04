/**
 * SpatialModeVisual 空间化过渡动画测试（jsdom：含组件挂载冒烟）
 *
 * 纯函数部分：transitionProgress 相位映射——2s 总时长线性 0..1
 * （0ms→0、1s→0.5、2s→1）、越界钳制（>2s 钳 1、<0 钳 0）、start 偏移、
 * 确定性（相同输入恒等输出）+ TRANSITION_DURATION_MS 常量。
 * 组件冒烟（jsdom）：transitionKey 缺省（向后兼容）/传值两种挂载不抛错；
 * jsdom 无 2D canvas 上下文（getContext 返回 null），绘制路径提前返回，
 * 只验证挂载与 props 接线。
 * 注意：文件用 .tsx 后缀是因为 vitest.config.ts 对 ui/ 目录只收集
 * `ui/**\/*.test.tsx`；组件部分需要 DOM，故文件头启用 jsdom。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { SpatialModeVisual, transitionProgress, TRANSITION_DURATION_MS } from './SpatialModeVisual'
import type { HSETheme } from '../hse-theme'

/** 测试用 HSE 主题（最小对象；jsdom 无 2D 上下文，绘制路径不会读取其余字段） */
const theme: HSETheme = {
  dark: true,
  accentFrom: '#22d3ee',
  accentTo: '#7c3aed',
  // 其余字段仅类型占位（绘制路径未使用）
} as unknown as HSETheme

/* ═══════════ transitionProgress：2s 过渡相位映射 ═══════════ */

describe('transitionProgress（2s 过渡相位映射）', () => {
  it('0ms → 0、1s → 0.5、2s → 1（线性映射）', () => {
    expect(transitionProgress(0, 0)).toBe(0)
    expect(transitionProgress(1000, 0)).toBe(0.5)
    expect(transitionProgress(2000, 0)).toBe(1)
    expect(transitionProgress(500, 0)).toBe(0.25)
  })

  it('超过 2s 钳制到 1（>2s 钳 1）', () => {
    expect(transitionProgress(2001, 0)).toBe(1)
    expect(transitionProgress(5000, 0)).toBe(1)
    expect(transitionProgress(1e9, 0)).toBe(1)
  })

  it('未开始/早于起点钳制到 0（<0 钳 0）', () => {
    expect(transitionProgress(-1, 0)).toBe(0)
    expect(transitionProgress(-500, 0)).toBe(0)
    expect(transitionProgress(0, 1000)).toBe(0) // now 在 start 之前
  })

  it('start 偏移：以 start 为相对零点', () => {
    expect(transitionProgress(1500, 1000)).toBe(0.25)
    expect(transitionProgress(3000, 1000)).toBe(1)
    expect(transitionProgress(1000, 1000)).toBe(0)
  })

  it('确定性：相同输入恒等输出（含边界）', () => {
    for (let i = 0; i < 50; i += 1) {
      const now = i * 137
      expect(transitionProgress(now, 0)).toBe(transitionProgress(now, 0))
    }
    expect(transitionProgress(2000, 0)).toBe(transitionProgress(2000, 0))
    expect(transitionProgress(0, 0)).toBe(transitionProgress(0, 0))
  })

  it('TRANSITION_DURATION_MS 常量 = 2000（总时长）', () => {
    expect(TRANSITION_DURATION_MS).toBe(2000)
  })
})

/* ═══════════ SpatialModeVisual 挂载冒烟 ═══════════ */

describe('SpatialModeVisual 挂载冒烟', () => {
  beforeEach(() => cleanup())

  it('transitionKey 缺省挂载不抛错（向后兼容：不播过渡）', () => {
    expect(() =>
      render(<SpatialModeVisual spreadDeg={60} amount={0.8} active theme={theme} />),
    ).not.toThrow()
  })

  it('transitionKey 传值挂载不抛错（触发链路接线：值变化时播放过渡）', () => {
    expect(() =>
      render(<SpatialModeVisual spreadDeg={60} amount={0.8} active theme={theme} transitionKey={1} />),
    ).not.toThrow()
  })

  it('关闭态（active=false）挂载不抛错', () => {
    expect(() =>
      render(<SpatialModeVisual spreadDeg={60} amount={0.8} active={false} theme={theme} transitionKey={2} />),
    ).not.toThrow()
  })
})
