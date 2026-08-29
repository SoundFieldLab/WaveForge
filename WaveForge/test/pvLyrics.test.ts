import { describe, it, expect } from 'vitest'
import { toPvLyrics, buildBeats } from '../src/components/pvLyrics/pvBridge'
import { recommendTemplates } from '../src/components/pvLyrics/pvStyleMapping'
import { compileScenes } from '../src/components/pvLyrics/pvDirector'

describe('toPvLyrics（WaveForge 歌词 → 引擎歌词，逐字毫秒→绝对秒）', () => {
  it('逐字 startTime/duration（相对行首毫秒）转为绝对秒', () => {
    const result = toPvLyrics([
      {
        time: 10,
        text: '你好',
        words: [
          { word: '你', startTime: 0, duration: 500 },
          { word: '好', startTime: 500, duration: 600 },
        ],
      },
    ])
    expect(result).toEqual([
      {
        time: 10,
        text: '你好',
        words: [
          { text: '你', time: 10, endTime: 10.5 },
          { text: '好', time: 10.5, endTime: 11.1 },
        ],
      },
    ])
  })

  it('无逐字时间戳时 words 保持 undefined', () => {
    const result = toPvLyrics([{ time: 3, text: '纯文本' }])
    expect(result[0].words).toBeUndefined()
  })

  it('翻译/罗马音透传', () => {
    const result = toPvLyrics([{ time: 0, text: 'hello', translation: '你好', roman: 'hero' }])
    expect(result[0].translation).toBe('你好')
    expect(result[0].roman).toBe('hero')
  })

  it('空歌词返回空数组', () => {
    expect(toPvLyrics([])).toEqual([])
  })
})

describe('buildBeats（TrackAnalysis → 拍点数组）', () => {
  it('节拍时间点原样映射，能量回退 0.5', () => {
    const beats = buildBeats({
      beats: [1, 2.5, 4],
      beatFeatures: [{ beatIndex: 0, time: 1, energy: 0.9 } as never],
    })
    expect(beats).toEqual([
      { time: 1, energy: 0.9 },
      { time: 2.5, energy: 0.5 },
      { time: 4, energy: 0.5 },
    ])
  })

  it('能量越界被钳制到 0~1', () => {
    const beats = buildBeats({
      beats: [0.5],
      beatFeatures: [{ beatIndex: 0, time: 0.5, energy: 3 } as never],
    })
    expect(beats[0].energy).toBe(1)
  })

  it('null/无节拍返回空数组', () => {
    expect(buildBeats(null)).toEqual([])
    expect(buildBeats({ beats: [] } as never)).toEqual([])
  })

  it('非正拍点（开头 0 秒）被过滤', () => {
    const beats = buildBeats({ beats: [0, 1] } as never)
    expect(beats.map(b => b.time)).toEqual([1])
  })
})

describe('recommendTemplates（分析信号 → 模板推荐）', () => {
  it('高 BPM + 高能量 → 动感系模板（动能/斩击/战斗）', () => {
    const rec = recommendTemplates({ bpm: 160, avgEnergy: 0.8 })
    expect(rec[0]).toBe(24) // 动能
    expect(rec).toContain(1) // 斩击
  })

  it('MV 视频背景 → HUD/影院系模板靠前', () => {
    const rec = recommendTemplates({ hasVideo: true })
    expect(rec[0]).toBe(6) // 夜之城监控
    expect(rec).toContain(7) // 情绪电影
  })

  it('冷色低饱和封面 → 赛博系', () => {
    const rec = recommendTemplates({ dominantColor: '#123a5f' })
    expect(rec).toContain(3) // 赛博废墟
    expect(rec).toContain(20) // 赛博
  })

  it('暖色甜美封面 → 少女/糖果系', () => {
    const rec = recommendTemplates({ dominantColor: '#ffb6c1' })
    // 浅亮粉同时命中「甜美系」与「高对比平面系」，推荐前几仍属糖果系集合
    expect(rec[0]).toBe(13) // 格子花边
    expect(rec.slice(0, 3)).toContain(12) // 少女云朵
  })

  it('无信号时兜底现代模板（0 蓝色冲击）', () => {
    const rec = recommendTemplates({})
    expect(rec[0]).toBe(0)
  })

  it('日语歌词 → 日系文艺模板进入推荐', () => {
    const rec = recommendTemplates({ isJapanese: true })
    expect(rec).toContain(17) // 春日影
  })
})
describe('compileScenes（PV 自动编排，凝彩式分段）', () => {
  function lines(times: number[], text?: string) {
    return times.map((time, i) => ({ time, text: text ?? `L${i}` }))
  }

  it('空歌词返回空场景', () => {
    expect(compileScenes({ lyrics: [], analysis: null, recommended: [0] })).toEqual([])
  })

  it('连续歌词（间隙小）合为一段', () => {
    const scenes = compileScenes({ lyrics: lines([0, 2.5, 5, 7.5]), analysis: null, recommended: [0] })
    expect(scenes.length).toBe(1)
    expect(scenes[0].start).toBe(0)
    expect(scenes[0].end).toBeGreaterThanOrEqual(7.5)
  })

  it('大间隙切段：段数随间隙增加', () => {
    const scenes = compileScenes({ lyrics: lines([0, 4, 20, 24]), analysis: null, recommended: [0] })
    expect(scenes.length).toBeGreaterThan(1)
  })

  it('首段 intro、末段 outro，模板相邻不重复', () => {
    const scenes = compileScenes({ lyrics: lines([0, 2, 15, 17, 30, 32]), analysis: null, recommended: [0, 1] })
    expect(scenes[0].kind).toBe('intro')
    expect(scenes[scenes.length - 1].kind).toBe('outro')
    for (let i = 1; i < scenes.length; i++) {
      expect(scenes[i].templateIndex).not.toBe(scenes[i - 1].templateIndex)
    }
  })

  it('sections 副歌段不落到安静（intensity ≥ 0.62）', () => {
    const scenes = compileScenes({
      lyrics: lines([0, 2, 18, 20, 36, 38]),
      analysis: {
        sections: [
          { time: 18, type: 'chorus', confidence: 1, beatIndex: 0 },
          { time: 36, type: 'outro', confidence: 1, beatIndex: 0 },
        ],
      } as never,
      recommended: [0],
    })
    const chorus = scenes.find(s => s.kind === 'chorus')
    expect(chorus).toBeDefined()
    expect(chorus!.intensity).toBeGreaterThanOrEqual(0.62)
  })

  it('intensity 钳制在 0.25~1', () => {
    const scenes = compileScenes({ lyrics: lines([0, 3, 6, 9]), analysis: null, recommended: [0] })
    for (const s of scenes) {
      expect(s.intensity).toBeGreaterThanOrEqual(0.25)
      expect(s.intensity).toBeLessThanOrEqual(1)
    }
  })
})
