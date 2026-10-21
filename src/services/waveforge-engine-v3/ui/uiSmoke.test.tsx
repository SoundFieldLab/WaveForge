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
  const view = render(<V3MixingStudio bridge={bridge} playerTheme="light" onClose={() => undefined} />)
  return { engine, bridge, view }
}

/** 点击左侧导航项 */
function clickNav(label: string) {
  fireEvent.click(screen.getAllByText(label)[0])
}

describe('V3 调音室 UI 冒烟', () => {
  beforeEach(() => cleanup())

  it('动态均衡可从动态调音页启用并打开参数弹窗', () => {
    const { bridge } = makeUi()
    clickNav('动态调音')
    fireEvent.click(screen.getByRole('switch', { name: '启用动态均衡' }))
    expect(bridge.getParams().dynamicEq?.enabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '动态均衡详细设置' }))
    expect(screen.getByRole('slider', { name: '中心频率' })).toBeTruthy()
  })

  it('动态均衡弹窗可增减独立频段并写入参数快照', () => {
    const { bridge } = makeUi()
    clickNav('动态调音')
    fireEvent.click(screen.getByRole('button', { name: '动态均衡详细设置' }))
    fireEvent.click(screen.getByRole('button', { name: '添加频段' }))
    expect(bridge.getParams().dynamicEq?.bands).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('button', { name: '删除频段' })[0])
    expect(bridge.getParams().dynamicEq?.bands).toBeUndefined()
  })

  it('耳机交叉馈送可从音效场景页启用并打开配置', () => {
    const { bridge } = makeUi()
    clickNav('音效场景')
    fireEvent.click(screen.getByRole('button', { name: '耳机交叉馈送启停' }))
    expect(bridge.getParams().crossfeed?.enabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '配置耳机交叉馈送' }))
    expect(screen.getByRole('slider', { name: '馈送量' })).toBeTruthy()
  })

  it('主面板渲染：标题 + 9 导航项 + 默认主页', () => {
    makeUi()
    expect(screen.getByText('HyperSoundEngine')).toBeTruthy()
    expect(screen.getByText('HSE 1.5')).toBeTruthy()
    for (const label of ['主页', '音效场景', '均衡器', '空间音效', '空间音频', '动态调音', '分析', '调音器', '关于']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(screen.getByText('声音工作台')).toBeTruthy()
    expect(screen.getByText('实时音频')).toBeTruthy()
    expect(screen.getByRole('slider', { name: '输出音量' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hi-Fi模式' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '增强模式' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '影院模式' })).toBeTruthy()
  })

  it('内部精度可切换到 Float64 并由引擎统计确认', () => {
    const { engine, bridge } = makeUi()
    clickNav('调音器')
    fireEvent.click(screen.getByRole('radio', { name: '双精度 · Float64' }))
    expect(bridge.getParams().precision).toBe('float64')
    expect(engine.getStats().internalPrecision).toBe('float64')
    fireEvent.click(screen.getByRole('radio', { name: '标准 · Float32' }))
    expect(engine.getStats().internalPrecision).toBe('float32')
  })

  it('M/S 比例显式启用后提交，宽度不依赖该开关', () => {
    const { bridge } = makeUi()
    clickNav('空间音效')
    const balance = screen.getByRole('slider', { name: '差分 S ↔ 中央 M' }) as HTMLInputElement
    expect(balance.disabled).toBe(true)
    const width = screen.getByRole('slider', { name: '宽度' }) as HTMLInputElement
    expect(width.disabled).toBe(false)
    fireEvent.click(screen.getByRole('switch', { name: '启用 M/S 比例与变速变调' }))
    expect(balance.disabled).toBe(false)
    fireEvent.change(balance, { target: { value: '0.5' } })
    expect(bridge.getParams().pitch.enabled).toBe(true)
    expect(bridge.getParams().pitch.voiceBalance).toBe(0.5)
    expect(screen.getByText('差分衰减 50%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '立体声宽度详细设置' }))
    expect((screen.getByRole('slider', { name: '差分 S ↔ 中央 M（精调）' }) as HTMLInputElement).disabled).toBe(false)
  })

  it('向上压缩图显示低电平提升，最大提升为零时回到单位曲线', () => {
    makeUi()
    clickNav('动态调音')
    fireEvent.click(screen.getByRole('button', { name: '动态压缩详细设置' }))
    fireEvent.click(screen.getByRole('radio', { name: '向上' }))
    const curve = screen.getByRole('img', { name: '向上压缩器输入输出传输曲线' })
    const paths = curve.querySelectorAll('path')
    const firstY = (path: Element) => Number(path.getAttribute('d')?.match(/^M[^,]+,([\d.-]+)/)?.[1])
    expect(firstY(paths[1])).toBeLessThan(firstY(paths[0]))
    fireEvent.change(screen.getByRole('slider', { name: '最大提升' }), { target: { value: '0' } })
    expect(firstY(curve.querySelectorAll('path')[1])).toBe(firstY(paths[0]))
  })

  it('空间音效页：混响开关可切换启用态', () => {
    const { bridge } = makeUi()
    clickNav('空间音效')
    // 空间音效页只剩混响/3D环绕/立体声宽度卡（空间音频已独立为「空间音频」选项卡）。
    // 注意：导航栏始终展示「空间音频」标签，故不能以该文案判存在——改用空间音频页
    // 独有的模式按钮和空间音频开关作为页面内容标记。
    expect(screen.queryByRole('button', { name: /^快速空间化/ })).toBeNull()
    expect(screen.queryByRole('switch', { name: '空间音频' })).toBeNull()
    // 混响卡片标题存在
    expect(screen.getAllByText('混响').length).toBeGreaterThan(0)
    // 默认未启用
    expect(bridge.getParams().reverb.enabled).toBe(false)
    fireEvent.click(screen.getByRole('switch', { name: '启用混响' }))
    expect(bridge.getParams().reverb.enabled).toBe(true)
  })

  it.each([
    ['均衡器', '启用均衡器'],
    ['空间音效', '启用混响'],
    ['空间音频', '空间音频'],
    ['动态调音', '启用动态压缩'],
  ])('主页快捷卡进入%s后，原有开关可操作', (label, switchName) => {
    makeUi()
    fireEvent.click(screen.getByRole('button', { name: `打开${label}` }))
    const toggle = screen.getByRole('switch', { name: switchName })
    const initial = toggle.getAttribute('aria-checked')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe(initial === 'true' ? 'false' : 'true')
  })

  it('主页分析快捷卡打开实际分析页', () => {
    makeUi()
    fireEvent.click(screen.getByRole('button', { name: '打开分析' }))
    expect(screen.getByRole('button', { name: '开始测试' })).toBeTruthy()
    expect(screen.queryByRole('slider', { name: '输出音量' })).toBeNull()
  })

  it('空间音频页：开启后恢复快速空间化并同步引擎参数', () => {
    const { bridge } = makeUi()
    clickNav('空间音频')
    // 空间音频页头部标题存在（与空间音效页区分）
    expect(screen.getAllByText('空间音频').length).toBeGreaterThan(0)
    // 空间音频页不应有混响卡（混响留在空间音效页）
    expect(screen.queryByText('混响')).toBeNull()
    // 默认模式 off → 总开关可开启 instant
    const spatialToggle = screen.getByRole('switch', { name: '空间音频' })
    fireEvent.click(spatialToggle)
    expect(spatialToggle.getAttribute('aria-checked')).toBe('true')
    expect(bridge.getParams().spatial!.mode).toBe('instant')
    expect(screen.getByRole('button', { name: /^快速空间化/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('快速空间化可启用多声道输入并选择 7.1.4 布局', () => {
    const { bridge } = makeUi()
    clickNav('空间音频')
    fireEvent.click(screen.getByRole('switch', { name: '空间音频' }))
    fireEvent.click(screen.getByText('音源与声道格式'))
    const multi = screen.getByRole('switch', { name: '多声道输入空间化' })
    fireEvent.click(multi)
    expect(bridge.getParams().spatial!.instant.multichannelAuto).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '7.1.4' }))
    expect(bridge.getParams().spatial!.instant.multichannelLayout).toBe('714')
    fireEvent.click(screen.getByRole('radio', { name: '自动布局' }))
    expect(bridge.getParams().spatial!.instant.multichannelLayout).toBe('auto')
    fireEvent.click(screen.getByRole('button', { name: '设备与高级设置' }))
    fireEvent.click(screen.getByRole('radio', { name: '仅晚混响' }))
    expect(bridge.getParams().spatial!.budgetMode).toBe('lowLatency')
  })

  it('动态调音页：压缩器阈值修改经桥写入引擎', () => {
    const { bridge } = makeUi()
    clickNav('动态调音')
    // 切换压缩器开关（默认关闭，先开启）
    const compressHeader = screen.getAllByText('动态压缩')
    expect(compressHeader.length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('switch', { name: '启用动态压缩' }))
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
    // 64 段预设：20Hz 端点保持 0dB，微调落在可听/音乐频段。
    expect(bridge.getParams().eq.bandCount).toBe(64)
    expect(bridge.getParams().eq.proBands.some((band) => band.gain !== 0)).toBe(true)
    expect(bridge.getParams().eq.proBands[0].frequency).toBeCloseTo(20, 1)
    expect(bridge.getParams().eq.proBands[63].frequency).toBeCloseTo(16000, 0)
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

  it('均衡器页：可为选中频段切换滤波器类型', () => {
    const { bridge } = makeUi()
    clickNav('均衡器')
    const selector = screen.getByRole('combobox', { name: '滤波器类型' })
    fireEvent.change(selector, { target: { value: 'notch' } })
    expect(bridge.getParams().eq.proBands[0].type).toBe('notch')
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
