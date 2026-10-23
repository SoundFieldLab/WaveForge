import { describe, it, expect } from 'vitest'
import { detectOffsetFromSubtitles } from '../src/services/mvAlignment'
import type { LyricLine } from '../src/services/musicApi'
import type { BilibiliSubtitleLine } from '../src/services/bilibiliApi'

const lyric = (time: number, text: string): LyricLine => ({ time, text })
const sub = (from: number, content: string): BilibiliSubtitleLine => ({ from, to: from + 3, content })

function baseCorpus(): { lyrics: LyricLine[]; subs: BilibiliSubtitleLine[] } {
  const lyrics: LyricLine[] = []
  const subs: BilibiliSubtitleLine[] = []
  for (let i = 0; i < 30; i++) {
    lyrics.push(lyric(i * 10 + 5, `verse line number ${i}`))
    subs.push(sub(i * 10 + 5 + 10, `verse line number ${i}`))  // 真偏移 +10s
  }
  return { lyrics, subs }
}

describe('detectOffsetFromSubtitles 弱点审计（合成数据）', () => {
  it('基线：干净 +10s 偏移', () => {
    const { lyrics, subs } = baseCorpus()
    const r = detectOffsetFromSubtitles(lyrics, subs)
    expect(r).not.toBeNull()
    expect(r!.offsetSeconds).toBe(10)
  })

  it('弱点A：重复副歌行的就近惩罚失效场景（副歌字幕时间更靠近远副歌）', () => {
    const { lyrics, subs } = baseCorpus()
    lyrics.push(lyric(40, 'chorus repeated hook line'))
    lyrics.push(lyric(120, 'chorus repeated hook line'))
    // 副歌字幕出现在 52s（=40+10+2 真偏移10s）但离 120 的歌词行更远——应配 @40
    subs.push(sub(52, 'chorus repeated hook line'))
    // 副歌字幕出现在 132s（=120+10+2）——应配 @120
    subs.push(sub(132, 'chorus repeated hook line'))
    const r = detectOffsetFromSubtitles(lyrics, subs)
    expect(r).not.toBeNull()
    expect(r!.offsetSeconds).toBe(10)
  })

  it('弱点B：CC 只覆盖一半行（如翻译组只做主歌）', () => {
    const { lyrics, subs } = baseCorpus()
    const r = detectOffsetFromSubtitles(lyrics, subs.slice(0, 12))
    // 12 行匹配仍 > 3 → 应能对齐
    expect(r).not.toBeNull()
    expect(r!.offsetSeconds).toBe(10)
  })

  it('弱点C：渐进漂移（字幕组逐句 +0.2s 累积 6s）→ 漂移拟合产出分段锚', () => {
    const { lyrics, subs } = baseCorpus()
    const drifted = subs.map((s, i) => sub(s.from + i * 0.2, s.content))
    const r = detectOffsetFromSubtitles(lyrics, drifted)
    expect(r).not.toBeNull()
    // 修复后：线性拟合检测到显著斜率 → 产出 segments（同步层 offsetAt 按位置插值）
    expect(r!.segments).toBeDefined()
    expect(r!.segments!.length).toBe(2)
    const [first, last] = r!.segments!
    expect(first.songTime).toBeLessThan(last.songTime)
    // 首尾锚的偏移差 ≈ 漂移总量（30 句 × 0.2s ≈ 6s）
    expect(Math.abs((last.offsetSeconds - first.offsetSeconds) - 6)).toBeLessThan(1.5)
    // 首锚偏移 ≈ 真值 10s
    expect(Math.abs(first.offsetSeconds - 10)).toBeLessThan(1.5)
  })

  it('弱点D：30% 噪声匹配（CC 混入非歌词内容如制作名单）', () => {
    const { lyrics, subs } = baseCorpus()
    subs.push(sub(200, 'directed by someone'))
    subs.push(sub(205, 'produced by studio'))
    subs.push(sub(210, 'special thanks to all fans'))
    const r = detectOffsetFromSubtitles(lyrics, subs)
    expect(r).not.toBeNull()
    expect(r!.offsetSeconds).toBe(10)
  })
})
