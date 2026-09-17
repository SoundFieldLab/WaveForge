/**
 * 共振入口的视觉一致性回归（源码断言，跑不动渲染也能守住）。
 *
 * 起因：共振上线后
 * 1. 模式卡片落到 DesktopMiniature 分支，和「桌面」卡片长得一模一样（用户反馈「图标没区分」）；
 * 2. 模式切换过渡动画没有 resonance 图标分支，中央只剩一个空环。
 * 这两处都属于「加了新模式但漏了视觉分支」，用源码断言比渲染断言更稳。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const source = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('共振的模式入口视觉', () => {
  it('模式卡片有自己的缩略图，不会回落到桌面缩略图', () => {
    const cards = source('src/components/ModeSelectionCards.tsx')
    expect(cards).toContain('function ResonanceMiniature()')
    // 必须显式分派 resonance，否则最后一行 return DesktopMiniature() 会兜住它
    expect(cards).toContain("if (mode === 'resonance') return <ResonanceMiniature />")
    expect(cards).toContain("mode: 'resonance', label: '共振'")
  })

  it('模式切换过渡动画有共振图标（否则中央徽章是空环）', () => {
    const overlay = source('src/components/ModeTransitionOverlay.tsx')
    expect(overlay).toContain('Radio')
    expect(overlay).toContain("mode === 'resonance' && <Radio")
    // 每个模式都要有标签与副标题，不能出现 undefined
    for (const mode of ['explore', 'minimal', 'traditional', 'desktop', 'resonance']) {
      expect(overlay).toContain(`${mode}: { label:`)
    }
  })

  it('模式选择面板给共振配了背景色（不是回落到蓝色）', () => {
    const panel = source('src/components/ModeSelectionPanel.tsx')
    expect(panel).toContain("currentMode === 'resonance'")
    expect(panel).toContain("resonance: '共振'")
  })

  it('共振模式内也有顶部居中的模式下拉，且设置/返回在左下角', () => {
    const view = source('src/features/resonance/ResonanceView.tsx')
    expect(view).toContain('aria-label="打开模式选择"')
    expect(view).toContain('<ModeSelectionPanel')
    expect(view).toContain('currentMode="resonance"')
    // 左下角操作区
    expect(view).toContain('absolute bottom-4 left-4')
    // 「返回」按钮的文案来自进入前的模式，不能写死成「返回探索」
    expect(view).toContain('返回{modeLabel(entryMode)}')
    expect(view).not.toMatch(/>\s*返回探索\s*</)
  })
})

describe('回归：大厅/房间的交互细节', () => {
  it('局域网自动扫描 30 秒，找不到才留手动按钮；界面上不出现实现说明', () => {
    const lobby = source('src/features/resonance/ResonanceLobby.tsx')
    expect(lobby).toContain('const LAN_SCAN_SECONDS = 30')
    expect(lobby).toContain('autoScannedRef')
    // 实现细节不该出现在用户界面文案里（注释里可以写，所以只查会渲染出去的字符串开头）
    expect(lobby).not.toContain('没有后台扫描：')
    expect(lobby).not.toContain('只有你点「扫描局域网」时')
  })

  it('身份芯片不再有「只允许网易云」的禁用逻辑，自定义档固定显示「自定义」', () => {
    const lobby = source('src/features/resonance/ResonanceLobby.tsx')
    expect(lobby).not.toContain('enabledPlatforms')
    expect(lobby).not.toContain('disabled={!selectable}')
    expect(lobby).toContain("{option.key === 'custom' ? '自定义' : option.nickname}")
  })

  it('顶部的模式下拉平时隐藏，悬停才浮出（与其它模式一致）', () => {
    const view = source('src/features/resonance/ResonanceView.tsx')
    expect(view).toContain('modeTriggerHovered')
    expect(view).toContain('onMouseLeave={() => setModeTriggerHovered(false)}')
  })

  it('档位未知的曲目不再被标成「需要 VIP」', () => {
    const panel = source('src/features/resonance/ResonanceAddPanel.tsx')
    expect(panel).toContain("required === 'unknown'")
    expect(panel).toContain('未知')
  })
})
