/**
 * 学歌歌词渲染契约：靠左逐句列表 + 播放页同源逐字填充（LyricWordFillLine）。
 *
 * 历史：自研 KaraokeLine/RomanLine 修了五轮（整行均分错位 → mask 带僵硬 → rAF 与
 * React 重渲打架 → 柔和复刻仍不达观感）→ 短暂换成整个 LyricsDisplay 面板（丢掉了
 * 学歌自己的靠左逐句布局，且 onSeek 包装 findIndex 恒 0 导致点句跳开头）。
 * 最终方案：保留学歌自己的逐句列表 UI，活动行的**行内逐字效果**用从
 * LyricsDisplay soft 路径逐行提取的同源组件 LyricWordFillLine / RomanWordLine。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const viewSource = readFileSync(new URL('../src/features/singalong/SingAlongView.tsx', import.meta.url), 'utf8')
const fillSource = readFileSync(new URL('../src/components/LyricWordFill.tsx', import.meta.url), 'utf8')

describe('学歌歌词渲染契约（靠左逐句列表 + 播放页同源逐字）', () => {
  it('使用 LyricWordFillLine / RomanWordLine（LyricsDisplay 同源提取件）', () => {
    expect(viewSource).toContain("import LyricWordFillLine, { RomanWordLine } from '../../components/LyricWordFill'")
    expect(viewSource).toContain('<LyricWordFillLine')
    expect(viewSource).toContain('<RomanWordLine')
  })

  it('点句跳转走 jumpToLine（带正确行 index），不得再用恒 0 的 findIndex 包装', () => {
    expect(viewSource).toContain('onClick={() => jumpToLine(index)}')
    expect(viewSource).not.toContain('lines.findIndex(line => line.time <= time)')
  })

  it('逐句列表布局保留：靠左容器 + 行容器 + 学会圆圈（自学）', () => {
    expect(viewSource).toContain('data-line-index={index}')
    expect(viewSource).toContain('aria-label={isMastered')
    expect(viewSource).toContain('lyricsScrollRef')
  })

  it('填充层由 currentTime prop 驱动（render 内计算，无 rAF 直写 style）', () => {
    expect(fillSource).toMatch(/export default function LyricWordFillLine\(\{[\s\S]*currentTime[\s\S]*\}/)
    expect(fillSource).toContain('const fillWidth = fillProgress * 100')
    // 柔和路径的推进机制：width 收缩 + mask 羽化（与 LyricsDisplay soft 完全一致，无 clip-path）
    expect(fillSource).toContain('width: `${extendedWidth}%`')
    expect(fillSource).toContain('(currentTime + lyricOffset) * 1000 - lineStartMs - 200')
    expect(fillSource).toContain('(currentMs - startTime) / safeDuration')
  })

  it('柔光参数与播放页 soft 档一致（fillExtension 42 / 六段羽化 / 0.075em 上浮）', () => {
    expect(fillSource).toContain('fillExtension: 42')
    expect(fillSource).toContain("rgba(0,0,0,0.94) ${featherShoulder}%")
    expect(fillSource).toContain('rgba(0,0,0,0.28) ${featherTail}%')
    expect(fillSource).toContain('translateY(${-0.075 * softLiftProgress}em)')
  })

  it('罗马音填充：RomanWordLine 双层填充（亮色覆盖层）+ 颜色数对齐主行词', () => {
    expect(fillSource).toContain('export function RomanWordLine')
    expect(fillSource).toContain("color: dark ? 'rgba(110,231,183,0.95)'")
    expect(fillSource).toContain('roman.length === source.length')
  })

  it('自研旧实现不许复活（KaraokeLine/RomanLine/softFillOverlayStyle）', () => {
    expect(viewSource).not.toContain('function KaraokeLine')
    expect(viewSource).not.toContain('function RomanLine')
    expect(viewSource).not.toContain('function softFillOverlayStyle')
    expect(viewSource).not.toContain('fillSpan.style')
  })
})
