/** @vitest-environment jsdom */
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AutomixHudBadge,
  AutomixHudProgressHint,
  AUTOMIX_HUD_LEAD_SECONDS,
  AUTOMIX_HUD_NODE_DELAY_SECONDS,
  AUTOMIX_HUD_NODE_HOLD_SECONDS,
  AUTOMIX_HUD_FADE_IN_SECONDS,
  AUTOMIX_HUD_FADE_OUT_SECONDS,
  formatAutomixHudTime,
  transitionEngineDisplayName,
} from '../src/components/AutomixHudBadge'

/**
 * 过渡 HUD 回归锁：
 *   ① 药丸显示**时间节点**「即将在 m:ss 开始智能混音」（不是秒级倒计时），
 *      且提示节奏为「本曲播放满 5 秒提示一次 → 显示 8 秒 → 渐隐」，每曲一遍（跨挂载记忆）；
 *      计划晚于 5 秒才就绪（冷启动/未预载）时，就绪那一刻立刻提示；
 *   ②「关闭」与主文案同一水平线：整行 items-baseline（文字基线严格对齐）+ 图标 alignSelf:center，
 *      按钮内部 inline-flex + lineHeight 1 + 对称内边距（盒子不再把文字压低）；
 *   ③ 底色用当前封面主题色的淡色（color-mix 混入原底色）；
 *   ④ 淡入/淡出为可感知的柔和渐变（0.4s ease-out / 0.5s ease-in，双 rAF 保证淡入真的触发），
 *      且隐藏是"先淡出再卸载"（不再啪地消失）；驻留 8 秒不含淡入淡出（淡入结束才开始计 8 秒）；
 *   ⑤ 引擎名只能是四个之一：AutoMix / AutoMix Pro / AutoMix Enhanced / Gapless；
 *   ⑥ 无缝衔接（gapless）同样出药丸：文案为「开始无缝衔接」（切点 = 裁剪后的拼接位置），
 *      进度条上方仍同时显示引擎名。
 */
afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

const noop = () => {}

/** 每例用独立 trackKey：模块级"本曲已提示"记忆是跨用例共享的 */
const badgeProps = (trackKey: string, startAt = 300) => ({
  info: {
    phase: 'armed' as const,
    startAt,
    endAt: startAt + 12,
    engineLabel: 'AutoMix Enhanced',
    kind: 'automix' as const,
    key: `${trackKey}|${startAt}`,
  },
  scale: 1,
  colors: { chip: 'rgba(15, 17, 24, 0.55)', text: '#f7f7fa', dim: 'rgba(255,255,255,0.55)' },
  accentColor: 'rgb(120, 40, 200)',
})

/** 让淡入的双 rAF 与 CSS 过渡跑过（配合假定时器）：两帧各推一次 */
const flushFadeIn = async () => {
  await act(async () => {
    vi.advanceTimersToNextFrame()
    vi.advanceTimersToNextFrame()
  })
}

describe('AutoMix HUD 药丸', () => {
  it('播放满 5 秒才提示：5 秒前不渲染，5 秒后显示时间节点（m:ss，不带倒计时）', async () => {
    vi.useFakeTimers()
    const props = badgeProps('t-delay')
    const { container, rerender } = render(<AutomixHudBadge {...props} currentTime={3} onDismiss={noop} />)
    expect(container.firstElementChild).toBeNull()
    rerender(<AutomixHudBadge {...props} currentTime={AUTOMIX_HUD_NODE_DELAY_SECONDS + 0.2} onDismiss={noop} />)
    await flushFadeIn()
    expect(container.textContent).toContain('即将在 5:00 开始智能混音')
    expect(container.textContent).not.toContain('秒后')
    expect(formatAutomixHudTime(300)).toBe('5:00')
    expect(formatAutomixHudTime(59.9)).toBe('0:59')
  })

  it('显示满 8 秒后渐隐并卸载（驻留不含淡入淡出）；同一首歌换切点视为新一轮——重新提示（计划重算语义，2026-10-22 用户定稿）', async () => {
    vi.useFakeTimers()
    const props = badgeProps('t-hold')
    const { container, rerender } = render(<AutomixHudBadge {...props} currentTime={6} onDismiss={noop} />)
    await flushFadeIn()
    expect(container.firstElementChild).toBeTruthy()
    // 8 秒驻留到点时淡入预算（0.4s）还没走完 → 不能开始淡出（淡入淡出不计入驻留时长）
    await act(async () => { vi.advanceTimersByTime(AUTOMIX_HUD_NODE_HOLD_SECONDS * 1000 + 20) })
    const shown = container.firstElementChild as HTMLElement | null
    expect(shown).toBeTruthy()
    expect(shown!.style.opacity).not.toBe('0')
    expect(shown!.style.transition).toContain('0.4s')
    expect(shown!.style.transition).toContain('ease-out')
    // 淡入结束、驻留计满 → 先淡出（opacity 0），淡出跑完再卸载
    await act(async () => { vi.advanceTimersByTime(AUTOMIX_HUD_FADE_IN_SECONDS * 1000 + 60) })
    const fading = container.firstElementChild as HTMLElement | null
    expect(fading).toBeTruthy()
    expect(fading!.style.opacity).toBe('0')
    await act(async () => { vi.advanceTimersByTime(AUTOMIX_HUD_FADE_OUT_SECONDS * 1000 + 120) })
    expect(container.firstElementChild).toBeNull()
    // 同曲（trackKey 相同）换了切点 = 过渡计划被重算（插入下一曲/seek 等）：用户必须
    // 重新看到新过渡点（否则不知道过渡点已改——2026-10-22 实测反馈"点药丸跳转后新计划
    // 没有任何提示"）。key 整体变化（含切点段）→ 重置"已提示"，位置 ≥5s 满足入场 → 立即重弹。
    rerender(<AutomixHudBadge {...props} info={{ ...props.info, key: 't-hold|305' }} currentTime={120} onDismiss={noop} />)
    await flushFadeIn()
    expect(container.firstElementChild).toBeTruthy()
    expect(container.textContent).toContain('5:00') // 305s → 新切点的时刻
  })

  it('计划晚到（冷启动/新歌未预载，播放位置早已超过 5 秒）：就绪那一刻立刻提示', async () => {
    vi.useFakeTimers()
    const props = badgeProps('t-late')
    // 组件只有在计划就绪时才会被挂载：此刻播放已经在 42 秒 → 立刻进入提示
    const { container } = render(<AutomixHudBadge {...props} currentTime={42} onDismiss={noop} />)
    await flushFadeIn()
    expect(container.textContent).toContain('即将在 5:00 开始智能混音')
  })

  it('过渡开跑（phase=running）即淡出并卸载，不再补播', async () => {
    const props = badgeProps('t-running')
    const { container, rerender } = render(<AutomixHudBadge {...props} currentTime={294} onDismiss={noop} />)
    expect(container.firstElementChild).toBeTruthy()
    rerender(<AutomixHudBadge {...props} info={{ ...props.info, phase: 'running' }} currentTime={295} onDismiss={noop} />)
    const fading = container.firstElementChild as HTMLElement | null
    expect(fading).toBeTruthy()
    expect(fading!.style.opacity).toBe('0')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, AUTOMIX_HUD_FADE_OUT_SECONDS * 1000 + 200))
    })
    expect(container.firstElementChild).toBeNull()
  })

  it('引擎名映射只有四个：AutoMix / AutoMix Pro / AutoMix Enhanced / Gapless', () => {
    expect(transitionEngineDisplayName('smart-rendered', true, 'standard')).toBe('AutoMix')
    expect(transitionEngineDisplayName('beat-crossfade', true, 'standard')).toBe('AutoMix')
    expect(transitionEngineDisplayName('smart-rendered-v2', true, 'pro')).toBe('AutoMix Pro')
    expect(transitionEngineDisplayName('smart-rendered-qq', true, 'enhanced')).toBe('AutoMix Enhanced')
    expect(transitionEngineDisplayName('gapless', true, 'enhanced')).toBe('Gapless')
    expect(transitionEngineDisplayName('gapless', false, 'standard')).toBe('Gapless')
    // 没开启智能混音、或没有归属引擎（纯交叉淡化/看歌模式 none）→ 不显示任何名字
    expect(transitionEngineDisplayName('smart-rendered', false, 'standard')).toBeNull()
    expect(transitionEngineDisplayName('none', true, 'standard')).toBeNull()
    expect(transitionEngineDisplayName('fixed-crossfade', true, 'pro')).toBeNull()
  })

  it('无缝衔接（gapless）同样出药丸：文案为「开始无缝衔接」，引擎名仍由进度条上方承担', async () => {
    const gaplessProps = {
      ...badgeProps('t-gapless'),
      info: { ...badgeProps('t-gapless').info, engineLabel: 'Gapless', kind: 'gapless' as const, key: 'gapless|300' },
    }
    vi.useFakeTimers()
    const { container } = render(<AutomixHudBadge {...gaplessProps} currentTime={AUTOMIX_HUD_NODE_DELAY_SECONDS + 0.2} onDismiss={noop} />)
    await flushFadeIn()
    // 节点文案使用「无缝衔接」而不是「智能混音」
    expect(container.textContent).toContain('开始无缝衔接')
    expect(container.textContent).not.toContain('开始智能混音')
    // 进度条提示：等待窗口内 + 过渡中都显示引擎名
    const hint = render(<AutomixHudProgressHint info={gaplessProps.info} currentTime={294} scale={1} />)
    expect(hint.container.textContent).toContain('Gapless')
    expect(AUTOMIX_HUD_LEAD_SECONDS).toBe(8)
  })

  it('底色用当前封面主题色淡色（color-mix），离场过渡为 0.5s ease-in（先驻留再离场）', () => {
    const props = badgeProps('t-color')
    const { container } = render(<AutomixHudBadge {...props} currentTime={294} onDismiss={noop} />)
    const pill = container.firstElementChild as HTMLElement
    expect(pill).toBeTruthy()
    expect(pill.style.background).toContain('color-mix')
    expect(pill.style.background).toContain(props.accentColor)
    // 初始（opacity 0）挂的是离场曲线；进场曲线在 8 秒驻留用例里断言
    expect(pill.style.transition).toContain('0.5s')
    expect(pill.style.transition).toContain('ease-in')
  })

  it('「关闭」与主文案同一水平线（整行基线对齐 + 按钮自身盒模型不偏），并触发跳过回调', () => {
    const onDismiss = vi.fn()
    const props = badgeProps('t-dismiss')
    const { container } = render(<AutomixHudBadge {...props} currentTime={294} onDismiss={onDismiss} />)
    const pill = container.firstElementChild as HTMLElement
    const button = container.querySelector('button') as HTMLButtonElement
    expect(button).toBeTruthy()
    expect(button.textContent).toBe('关闭')
    // ① 整行按基线对齐：小字与大字的文字基线严格同线（垂直居中会让小字基线偏低 ~0.5px+）
    expect(pill.className).toContain('items-baseline')
    expect(pill.className).not.toContain('items-center')
    // 图标单独垂直居中，不跟基线（SVG 的基线是底边，会往下沉）
    const icon = pill.querySelector('svg') as SVGElement
    expect(icon.style.alignSelf).toBe('center')
    // ② 按钮自身盒模型：inline-flex + lineHeight 1 + 对称内边距 —— 文字在盒内不被压低
    expect(button.style.display).toBe('inline-flex')
    expect(button.style.alignItems).toBe('center')
    expect(button.style.lineHeight).toBe('1')
    const padTop = button.style.paddingTop
    const padBottom = button.style.paddingBottom
    expect(padTop).toBe(padBottom)
    expect(padTop).not.toBe('')
    expect(button.getAttribute('title') || '').toContain('智能混音')
    // 主文案盒子收紧（lineHeight 1.15），避免大行高主导基线位置
    const label = pill.querySelector('span') as HTMLElement
    expect(label.style.lineHeight).toBe('1.15')
    button.click()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('淡入淡出为可感知的柔和渐变（≥0.3s / ≥0.4s），切点到达也是淡出后卸载', async () => {
    expect(AUTOMIX_HUD_FADE_IN_SECONDS).toBeGreaterThanOrEqual(0.3)
    expect(AUTOMIX_HUD_FADE_OUT_SECONDS).toBeGreaterThanOrEqual(0.4)
    // 换一首当前曲（trackKey 变）→ 记忆复位，重新允许提示
    const props = badgeProps('t-budget')
    const { container, rerender } = render(<AutomixHudBadge {...props} currentTime={294} onDismiss={noop} />)
    expect(container.firstElementChild).toBeTruthy()
    // 切点已到（phase 仍是 armed，但剩余 ≤0）→ 立刻把不透明度压到 0（CSS 过渡负责"滑走"），
    // 元素留在树上等淡出结束再卸载，而不是当场消失。
    rerender(<AutomixHudBadge {...props} currentTime={300.5} onDismiss={noop} />)
    const pill = container.firstElementChild as HTMLElement | null
    expect(pill).toBeTruthy()
    expect(pill!.style.opacity).toBe('0')
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, AUTOMIX_HUD_FADE_OUT_SECONDS * 1000 + 200))
    })
    expect(container.firstElementChild).toBeNull()
  })
})
