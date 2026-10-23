import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isLyricLikeSubtitle, detectOffsetFromSubtitles } from '../src/services/mvAlignment'
import type { BilibiliSubtitleLine } from '../src/services/bilibiliApi'

/** 真实 B 站 CC 字幕语料（2026-10-19 采集，12 个视频 15 条轨，见采集脚本 .tmp-align-ml/scan_cc2.mjs）。
 *  形态覆盖：AI 环境/音乐识别轨、AI 闲聊转写轨、人工完整歌词轨、人工听写错字轨、
 *  多曲合集轨、♪音乐符号行。 */
interface RealTrack {
  bvid: string
  title: string
  lan: string
  doc: string
  ai: number
  lines: Array<{ from: number; to: number; content: string }>
}
const REAL_TRACKS: RealTrack[] = JSON.parse(readFileSync(new URL('./fixtures/real-cc.json', import.meta.url), 'utf-8'))
const toSubLines = (t: RealTrack): BilibiliSubtitleLine[] => t.lines.map((l) => ({ from: l.from, to: l.to, content: l.content }))

describe('真实 B 站 CC 字幕语料（P1 AI 非歌词轨防护）', () => {
  it('AI 环境/音乐识别轨（♪音乐♪×186/200，去重词14）→ 判非歌词', () => {
    const t = REAL_TRACKS.find((x) => x.bvid === 'BV1Q2qsBmEzT')
    expect(t).toBeDefined()
    expect(isLyricLikeSubtitle(toSubLines(t!))).toBe(false)
  })

  it('AI 闲聊转写轨（家庭作业/紧张紧张呢）→ 判非歌词', () => {
    const t = REAL_TRACKS.find((x) => x.bvid === 'BV1qC8PzeEhK')
    expect(t).toBeDefined()
    expect(isLyricLikeSubtitle(toSubLines(t!))).toBe(false)
  })

  it('人工完整歌词轨（七里香：窗外的麻雀在电线杆上多嘴）→ 判歌词', () => {
    const t = REAL_TRACKS.find((x) => x.bvid === 'BV1bR4y1M7Ts')
    expect(t).toBeDefined()
    expect(isLyricLikeSubtitle(toSubLines(t!))).toBe(true)
  })

  it('人工歌词轨（明年今日：有着一座吊灯倾泻下来）→ 判歌词', () => {
    const t = REAL_TRACKS.find((x) => x.bvid === 'BV1kL411J749')
    expect(t).toBeDefined()
    expect(isLyricLikeSubtitle(toSubLines(t!))).toBe(true)
  })

  it('♪音乐符号行占多数的人工轨（群青/BloodStream 型）→ 判歌词（符号已在判定前剥离）', () => {
    const musicNoteTracks = REAL_TRACKS.filter((t) => t.ai === 0 && t.lines.some((l) => l.content.includes('♪')))
    expect(musicNoteTracks.length).toBeGreaterThan(2)
    for (const t of musicNoteTracks) {
      expect(isLyricLikeSubtitle(toSubLines(t))).toBe(true)
    }
  })
})

describe('真实语料文本对齐（本地歌词 × 人工轨）', () => {
  // 七里香：本地歌词用真实首句，CC 是人工完整听写 → 整行匹配应直接命中
  it('人工完整歌词轨 vs 本地歌词 → 对齐 offset≈0', () => {
    const t = REAL_TRACKS.find((x) => x.bvid === 'BV1bR4y1M7Ts')
    const lyrics = [
      { time: 30, text: '窗外的麻雀在电线杆上多嘴' },
      { time: 37, text: '你说这一句很有夏天的感觉' },
      { time: 43, text: '手中的铅笔在纸上来来回回' },
      { time: 50, text: '我用几行字形容你是我的谁' },
      { time: 57, text: '秋刀鱼的滋味' },
      { time: 60, text: '猫跟你都想了解' },
      { time: 63, text: '初恋的香味就这样被我们寻回' },
      { time: 70, text: '那温暖的阳光' },
    ]
    const r = detectOffsetFromSubtitles(lyrics as never, toSubLines(t!))
    expect(r).not.toBeNull()
    expect(Math.abs(r!.offsetSeconds)).toBeLessThanOrEqual(1)
  })

  // 明年今日：CC 人工听写完整，本地歌词同曲 → 应命中
  it('人工听写轨（明年今日）vs 本地歌词 → 对齐', () => {
    const t = REAL_TRACKS.find((x) => x.bvid === 'BV1kL411J749')
    const lyrics = [
      { time: 16, text: '有着一座吊灯倾泻下来' },
      { time: 20, text: '或者我已不会存在' },
      { time: 23, text: '即使你不爱' },
      { time: 27, text: '亦不需要分开' },
      { time: 31, text: '若这一刻我竟严重痴爱' },
      { time: 35, text: '根本不需要被爱' },
      { time: 38, text: '永远在床上发梦' },
      { time: 42, text: '余生都不会再悲哀' },
    ]
    const r = detectOffsetFromSubtitles(lyrics as never, toSubLines(t!))
    expect(r).not.toBeNull()
    expect(Math.abs(r!.offsetSeconds)).toBeLessThanOrEqual(1)
  })

  // AI 闲聊轨已在 isLyricLikeSubtitle 层被拒；这里验证 detectOffsetFromSubtitles
  // 直接喂闲聊轨也不会产出「自信的错误偏移」——要么 null 要么低置信。
  it('AI 闲聊转写轨直接喂入不产出高置信偏移', () => {
    const t = REAL_TRACKS.find((x) => x.bvid === 'BV1qC8PzeEhK')
    const lyrics = [
      { time: 10, text: '群青' },
      { time: 20, text: '花に雲' },
      { time: 30, text: '潔白 世界' },
      { time: 40, text: '夜に駆ける' },
      { time: 50, text: 'yeah' },
    ]
    const r = detectOffsetFromSubtitles(lyrics as never, toSubLines(t!))
    if (r) expect(r.confidence).toBeLessThan(0.6)
  })
})

describe('大规模真实语料（355 视频 556 轨采集，28 轨代表性样本）', () => {
  const BIG: Array<{ bvid: string; lan: string; ai: number; kw?: string; songKey?: string; lyrics?: Array<{ time: number; text: string }>; lines: Array<{ from: number; to: number; content: string }> }> =
    JSON.parse(readFileSync(new URL('./fixtures/real-cc.json', import.meta.url), 'utf-8'))

  it('低样本封顶：假对齐样本（n≤5 + scan）置信度 ≤0.55', () => {
    // 已知假对齐：BV1x3hVz3E5q（ai-ja +22.99s，多投稿收敛真值 ≈0.2-0.7）
    const t = BIG.find((x) => x.bvid === 'BV1x3hVz3E5q')
    expect(t).toBeDefined()
    expect(t!.lyrics?.length).toBeGreaterThan(5)
    const r = detectOffsetFromSubtitles(t!.lyrics as never, toSubLines(t as never))
    if (r) {
      // 假锁要么被拒（null），要么低样本封顶挡在应用门槛外
      expect(r.confidence).toBeLessThanOrEqual(0.55)
    }
  })

  it('高样本人工轨（n≥27）对齐不受封顶影响', () => {
    const highSample = BIG.filter((t) => t.lyrics && t.lyrics.length >= 8 && !t.ai && t.lines.length >= 20)
    let checked = 0
    for (const t of highSample) {
      const r = detectOffsetFromSubtitles(t.lyrics as never, toSubLines(t as never))
      if (r && r.confidence >= 0.7) {
        checked++
        // 高置信结果的偏移应稳定（多投稿同曲时偏移一致由其它测试覆盖）
        expect(Number.isFinite(r.offsetSeconds)).toBe(true)
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('全部 28 轨跑一遍不抛错（鲁棒性）', () => {
    for (const t of BIG) {
      const lyrics = t.lyrics ?? [{ time: 0, text: '占位歌词行' }, { time: 10, text: '第二行占位' }, { time: 20, text: '第三行占位' }]
      expect(() => detectOffsetFromSubtitles(lyrics as never, toSubLines(t as never))).not.toThrow()
      expect(() => isLyricLikeSubtitle(toSubLines(t as never))).not.toThrow()
    }
  })
})
