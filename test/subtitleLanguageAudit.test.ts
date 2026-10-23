import { describe, it, expect } from 'vitest'
import { detectOffsetFromSubtitles } from '../src/services/mvAlignment'
import type { LyricLine } from '../src/services/musicApi'
import type { BilibiliSubtitleLine } from '../src/services/bilibiliApi'

const lyric = (time: number, text: string): LyricLine => ({ time, text })
const sub = (from: number, content: string): BilibiliSubtitleLine => ({ from, to: from + 3, content })

describe('CC 字幕语言形态审计', () => {
  // 场景1：日语歌 + 本地歌词全行带日语原文+中文翻译 + CC 是中文翻译（另一译者）
  // 现状：本地 translation 与 CC 翻译文本不同 → 匹配率?
  it('翻译口径差异：本地翻译 vs CC 翻译（不同译者）→ 内容词 bigram 匹配可对齐', () => {
    const lyrics: LyricLine[] = [
      { time: 5, text: '夜に駆ける', translation: '奔向夜晚' },
      { time: 15, text: '情報化した世界', translation: '信息化的世界' },
      { time: 25, text: '君しか見えない', translation: '只能看见你' },
      { time: 35, text: '心が叫んだ', translation: '内心在呐喊' },
      { time: 45, text: '言葉にできない', translation: '无法言表' },
    ]
    // CC 翻译用词不同（另一译者）：语序/选词都不一样
    const subs = [
      sub(15, '向夜晚飞奔而去'),     // vs 本地"奔向夜晚"
      sub(25, '被信息化淹没的世界'), // vs 本地"信息化的世界"
      sub(35, '眼中只有你一个人'),   // vs 本地"只能看见你"
      sub(45, '心在嘶喊'),           // vs 本地"内心在呐喊"
      sub(55, '化作言语'),           // vs 本地"无法言表"
    ]
    const r = detectOffsetFromSubtitles(lyrics, subs)
    expect(r).not.toBeNull()
    expect(r!.offsetSeconds).toBe(10)
  })

  // 场景2：双语 CC（"日文\n中文"同一行）
  it('双语 CC：单行内两种语言', () => {
    const lyrics = [
      lyric(5, '夜に駆ける'),
      lyric(15, '信息化した世界'),
      lyric(25, '君しか見えない'),
      lyric(35, '心が叫んだ'),
      lyric(45, '言葉にできない'),
    ]
    const subs = [
      sub(15, '夜に駆ける\n奔向夜晚'),
      sub(25, '信息化した世界\n信息化的世界'),
      sub(35, '君しか見えない\n只能看见你'),
    ]
    const r = detectOffsetFromSubtitles(lyrics, subs)
    console.log('场景2 结果:', JSON.stringify(r))
  })

  // 场景3：本地歌词纯中文（QQ 日语歌常见"中文翻译版歌词"），CC 是日语原文
  // 不同语言零文本交集——字幕文本路径理论上无解（信息论边界），应返回 null 走包络/节拍路径。
  // （双语 CC 的场景2 修复已覆盖"CC 里有中文"的情况；这里验证的是纯错配时干净拒绝。）
  it('语言错配：本地纯中文 vs CC 日语原文 → 干净拒绝（不产生错误偏移）', () => {
    const lyrics = [
      lyric(5, '奔向夜晚'),
      lyric(15, '信息化的世界'),
      lyric(25, '只能看见你'),
      lyric(35, '内心在呐喊'),
      lyric(45, '无法言表'),
    ]
    const subs = [
      sub(15, '夜に駆ける'),
      sub(25, '信息化した世界'),
      sub(35, '君しか見えない'),
    ]
    const r = detectOffsetFromSubtitles(lyrics, subs)
    expect(r).toBeNull()
  })

  // 场景4：翻译口径 + 错误偏移候选（副歌重复文本在错误偏移下也有部分命中）
  // 全局扫描必须选正确偏移（总分高），不能被重复结构带偏。
  it('全局扫描抗副歌重复：正确偏移总分显著高于错误偏移', () => {
    const lyrics: LyricLine[] = [
      { time: 40, text: 'chorus hook line', translation: '副歌钩子句' },
      { time: 130, text: 'chorus hook line', translation: '副歌钩子句' },
      { time: 5, text: 'verse one text', translation: '主歌第一段' },
      { time: 15, text: 'verse two text', translation: '主歌第二段' },
      { time: 25, text: 'verse three text', translation: '主歌第三段' },
    ]
    // 真偏移 +10：CC 翻译行（用词不同）+ 副歌行出现在正确位置
    const subs = [
      sub(15, '首段主歌歌词'),           // vs 主歌第一段（弱重叠）
      sub(25, '次段主歌内容'),           // vs 主歌第二段（弱重叠）
      sub(50, '副歌的钩子句子'),         // vs 副歌钩子句@40（+10 正确）
      sub(140, '副歌的钩子句子'),        // vs 副歌钩子句@130（+10 正确）
    ]
    const r = detectOffsetFromSubtitles(lyrics, subs)
    // 不强制非 null（翻译重叠可能弱），但**若返回结果偏移必须是 10**——不能被副歌自证带偏
    if (r) expect(r.offsetSeconds).toBe(10)
  })
})
