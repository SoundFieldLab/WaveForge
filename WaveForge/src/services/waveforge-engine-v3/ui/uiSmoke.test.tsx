/**
 * WaveForge v3 调音室 UI —— HyperSoundEngine 风格新 UI 渲染冒烟测试（jsdom）
 *
 * 验证主面板可渲染、左侧导航切换、效果弹窗开合、场景应用、分享串往返、
 * 听力测试流程状态机推进。不依赖真实 Web Audio（桥由 EngineV3 真实实例提供）。
 * 环境：文件头 @vitest-environment jsdom。
 */

// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import { EngineV3 } from '../src/engine/EngineV3'
import { createV3UiBridge } from './bridge'
import V3MixingStudio from './V3MixingStudio'
import { encodeShareCode, decodeShareCode } from '../src/engine/ShareCodec'

function makeUi() {
  const engine = new EngineV3(48000, 2)
  const bridge = createV3UiBridge(engine, 48000)
  const view = render(<V3MixingStudio bridge={bridge} playerTheme="dark" onClose={() => undefined} />)
  return { engine, bridge, view }
}

/** 点击左侧导航项 */
function clickNav(label: string) {
  fireEvent.click(screen.getAllByText(label)[0])
}

describe('V3 调音室 UI 冒烟', () => {
  beforeEach(() => cleanup())

  it('主面板渲染：标题 + 8 导航项 + 默认主页', () => {
    makeUi()
    expect(screen.getByText('HyperSoundEngine')).toBeTruthy()
    for (const label of ['主页', '音效场景', '均衡器', '空间音效', '空间音频', '动态调音', '分析', '调音器']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    // 默认页：主页包含系统音效 + 音效模式快捷
    expect(screen.getByText('系统音效')).toBeTruthy()
    expect(screen.getByText('Hi-Fi 模式')).toBeTruthy()
    expect(screen.getByText('增强模式')).toBeTruthy()
    expect(screen.getByText('影院模式')).toBeTruthy()
  })

  it('空间音效页：混响开关可切换启用态', () => {
    const { bridge } = makeUi()
    clickNav('空间音效')
    // 空间音效页只剩混响/3D环绕/立体声宽度卡（空间音频已独立为「空间音频」选项卡）。
    // 注意：导航栏始终展示「空间音频」标签，故不能以该文案判存在——改用空间音频页
    // 独有的模式选择器文案「一键空间化」与 Power 按钮 title 作为页面内容标记。
    expect(screen.queryByText('一键空间化')).toBeNull()
    expect(screen.queryByTitle('开启空间音频')).toBeNull()
    // 混响卡片标题存在
    expect(screen.getAllByText('混响').length).toBeGreaterThan(0)
    // 默认未启用
    expect(bridge.getParams().reverb.enabled).toBe(false)
    // 点击「启用 混响」开关文案（位于卡片头部右侧 toggle 按钮的 aria-pressed）
    const toggles = screen.getAllByRole('button')
    // 找到混响卡片的开关按钮并切换
    const reverbToggle = toggles.find((btn) => btn.getAttribute('aria-pressed') === 'false' && btn.classList.contains('rounded-full'))
    expect(reverbToggle).toBeTruthy()
    fireEvent.click(reverbToggle!)
    expect(bridge.getParams().reverb.enabled).toBe(true)
  })

  it('空间音频页：Power 按钮开启后切到 instant 模式', () => {
    makeUi()
    clickNav('空间音频')
    // 空间音频页头部标题存在（与空间音效页区分）
    expect(screen.getAllByText('空间音频').length).toBeGreaterThan(0)
    // 空间音频页不应有混响卡（混响留在空间音效页）
    expect(screen.queryByText('混响')).toBeNull()
    // 默认模式 off → Power 按钮可开启 instant
    const powerBtn = screen.getAllByRole('button').find((btn) => btn.title === '开启空间音频')
    expect(powerBtn).toBeTruthy()
    fireEvent.click(powerBtn!)
    // 开启后切到 instant（一键空间化），模式选择器出现「一键空间化」激活
    expect(screen.getAllByText('一键空间化').length).toBeGreaterThan(0)
  })

  it('动态调音页：压缩器阈值修改经桥写入引擎', () => {
    const { bridge } = makeUi()
    clickNav('动态调音')
    // 切换压缩器开关（默认关闭，先开启）
    const compressHeader = screen.getAllByText('动态压缩')
    expect(compressHeader.length).toBeGreaterThan(0)
    // 找到压缩器开关（aria-pressed=false 的圆角按钮）并开启
    const toggles = screen.getAllByRole('button')
    const compToggle = toggles.find((btn) => btn.getAttribute('aria-pressed') === 'false' && btn.classList.contains('rounded-full'))
    expect(compToggle).toBeTruthy()
    fireEvent.click(compToggle!)
    expect(bridge.getParams().compressor.enabled).toBe(true)
    // 开启后阈值滑杆出现，拖动到 -30
    const sliders = screen.getAllByRole('slider')
    expect(sliders.length).toBeGreaterThan(0)
    fireEvent.change(sliders[0], { target: { value: '-30' } })
    const p = bridge.getParams()
    expect(p.compressor.thresholdDb).toBe(-30)
  })

  it('场景应用：点「流行」→ sceneId=pop 且参数变化', () => {
    const { bridge } = makeUi()
    clickNav('音效场景')
    fireEvent.click(screen.getByText('流行'))
    expect(bridge.getParams().sceneId).toBe('pop')
    expect(bridge.getParams().eq.proBands[0].gain).not.toBe(0)
  })

  it('场景应用保留音量控制：内置场景与我的场景快照均不得覆盖 loudnessNormalization', () => {
    const { bridge } = makeUi()
    // 用户把音量拉到 40%（-36dB，调音室音量滑块同款通道）
    const ln = bridge.getParams().loudnessNormalization
    bridge.setParams({
      ...bridge.getParams(),
      loudnessNormalization: { ...ln, enabled: true, useRealtimeMeter: false, externalGainDb: -36, minGainDb: -60, maxGainDb: 12 },
    })
    // 应用内置「增强」场景（其快照 loudnessNormalization 为默认关闭/0dB）
    bridge.applyScene('enhanced')
    let after = bridge.getParams()
    expect(after.sceneId).toBe('enhanced')
    expect(after.loudnessNormalization.enabled).toBe(true)
    expect(after.loudnessNormalization.useRealtimeMeter).toBe(false)
    expect(after.loudnessNormalization.externalGainDb).toBe(-36)
    // 保存并应用「我的场景」组合——音量同样保留
    expect(bridge.saveMyScene('我的组合')).toBe(true)
    const mine = bridge.getScenes().find((s) => s.name === '我的组合')
    expect(mine).toBeTruthy()
    bridge.applyScene(mine!.id)
    after = bridge.getParams()
    expect(after.loudnessNormalization.externalGainDb).toBe(-36)
  })

  it('分享串：生成 → 解码往返一致（校验白名单）', () => {
    const { bridge } = makeUi()
    clickNav('调音器')
    fireEvent.click(screen.getByText('生成分享串'))
    const textarea = screen.getAllByRole('textbox').find((el) => (el as HTMLTextAreaElement).value.length > 20) as HTMLTextAreaElement
    expect(textarea).toBeTruthy()
    const decoded = decodeShareCode(textarea.value)
    expect(decoded.eq.enabled).toBe(bridge.getParams().eq.enabled)
    expect(decoded.limiter.thresholdDb).toBe(bridge.getParams().limiter.thresholdDb)
    // 篡改校验失败
    expect(() => decodeShareCode(textarea.value.slice(0, -2) + 'aa')).toThrow()
  })

  it('听力测试：开始 → 二分推进 5 轮后切频点 → 完成', () => {
    const { bridge } = makeUi()
    clickNav('分析')
    fireEvent.click(screen.getByText('开始测试'))
    // 7 频点 × 5 轮 = 35 次作答（全部"没听到"则阈值收敛到 -60.. 区间）
    for (let i = 0; i < 35; i++) {
      const heardBtn = screen.queryByText('听到了')
      if (!heardBtn) break
      fireEvent.click(screen.getByText('没听到'))
    }
    expect(screen.getByText(/测试完成/)).toBeTruthy()
    const audio = bridge.hearingStep()
    expect(audio.done).toBe(true)
    expect(audio.audiogram.length).toBe(7)
  })

  it('均衡器页：10/20 段切换 + 曲线编辑器存在', () => {
    const { bridge } = makeUi()
    clickNav('均衡器')
    fireEvent.click(screen.getByText('20 段'))
    expect(bridge.getParams().eq.bandCount).toBe(20)
    expect(bridge.getParams().eq.proBands.length).toBe(20)
    // SVG 曲线编辑器
    expect(document.querySelector('svg')).toBeTruthy()
  })

  it('主页音量控制：拖动到 20% → 引擎增益写入响度归一化通道', () => {
    const { bridge } = makeUi()
    // 主页默认展示音量控制滑杆
    const sliders = screen.getAllByRole('slider')
    const volSlider = sliders.find((el) => (el as HTMLInputElement).min === '0' && (el as HTMLInputElement).max === '100')
    expect(volSlider).toBeTruthy()
    fireEvent.change(volSlider!, { target: { value: '20' } })
    const p = bridge.getParams()
    expect(p.loudnessNormalization.enabled).toBe(true)
    // 20% → (20-100)*0.6 = -48dB
    expect(p.loudnessNormalization.externalGainDb).toBe(-48)
  })

  it('编码一致性：encodeShareCode 与桥一致', () => {
    const { bridge } = makeUi()
    const p = bridge.getParams()
    expect(encodeShareCode(p)).toBe(bridge.encodeShare(p))
  })
})
