/**
 * 汽水逐字歌词端到端单测：
 * 1) server/qishui-api.mjs 导出的 yrc 解析器（后端 words 字段组装）；
 * 2) src/services/sodaLyrics.ts 的前端归一化（wire 绝对毫秒 → parseYrc 同构契约）。
 * fixture 为手工编造的脱敏样例（非真实歌曲数据），覆盖上游两种字级写法：
 *   `[行起点,行长]<相对偏移,时长,0>词` 与 `[行起点,行长](绝对起点,时长,0)词`
 */
import { describe, expect, it } from 'vitest'
// @ts-ignore 后端模块无类型声明；vitest 以 esbuild 运行不做类型检查
import { buildSodaWordTimeline, parseSodaYrcTimeline } from '../server/qishui-api.mjs'
// 前端归一化模块：仅依赖 musicApi 的类型声明，node 环境可直接加载
import { asSodaWordRows, sodaWordRowsToLyricLines } from '../src/services/sodaLyrics'

/** 脱敏样例（手工编造，非真实歌曲）：混合 <相对> / (绝对) 两种字级 token 写法 */
const SODA_YRC_FIXTURE = [
  '[12000,6500]<0,1800,0>你好<1800,2200,0>世界<4000,2500,0>汽水',
  '[20000,6000](19980,1600,0)很久(21060,1500,0)之前',
].join('\n')

describe('parseSodaYrcTimeline（汽水上游 yrc → 结构化逐字时间轴）', () => {
  it('混合形态样例整体解析：两行全部命中并给出绝对毫秒词边界', () => {
    const rows = parseSodaYrcTimeline(SODA_YRC_FIXTURE)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      start: 12000,
      end: 18500,
      text: '你好世界汽水',
      words: [
        { text: '你好', start: 12000, end: 13800 },
        { text: '世界', start: 13800, end: 16000 },
        { text: '汽水', start: 16000, end: 18500 },
      ],
    })
    expect(rows[1].start).toBe(20000)
    expect(rows[1].end).toBe(26000)
    expect(rows[1].text).toBe('很久之前')
    expect(rows[1].words!.map((w: { text: string }) => w.text)).toEqual(['很久', '之前'])
  })

  it('解析相对偏移 <> 形态：绝对毫秒化并保留词边界', () => {
    const rows = parseSodaYrcTimeline('[12000,6500]<0,1800,0>你好<1800,2200,0>世界<4000,2500,0>汽水')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.start).toBe(12000)
    expect(row.end).toBe(18500)
    expect(row.text).toBe('你好世界汽水')
    expect(row.words).toEqual([
      { text: '你好', start: 12000, end: 13800 },
      { text: '世界', start: 13800, end: 16000 },
      { text: '汽水', start: 16000, end: 18500 },
    ])
  })

  it('解析绝对 () 形态并保留原值', () => {
    const direct = parseSodaYrcTimeline('[20000,6000](19980,1600,0)很久(21060,1500,0)之前')
    expect(direct).toEqual([
      {
        start: 20000,
        end: 26000,
        text: '很久之前',
        words: [
          { text: '很久', start: 19980, end: 21580 },
          { text: '之前', start: 21060, end: 22560 },
        ],
      },
    ])
  })

  it('兼容旧样例的 () 行内偏移写法（rawStart 远小于行起点时按相对补正）', () => {
    // 1234 << lineStart-500 → 视为相对偏移：30000+1234
    const rows = parseSodaYrcTimeline('[30000,1000](1234,300,0)呀')
    expect(rows).toHaveLength(1)
    expect(rows[0].words && rows[0].words[0]).toEqual({ text: '呀', start: 31234, end: 31534 })
  })

  it('无字级 token 的头部行保留为纯文本行（无 words 键），平铺 LRC 行被忽略', () => {
    const mixed = [
      '[1000,2000][副歌]', // 无 token：仍算一行，但不带 words
      '[00:05.000]这是普通 LRC 不是 yrc', // 带冒号分钟秒形态：整体忽略
    ].join('\n')
    const rows = parseSodaYrcTimeline(mixed)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ start: 1000, end: 3000, text: '[副歌]' })
  })

  it('空输入与非 yrc 文本返回空数组', () => {
    expect(parseSodaYrcTimeline('')).toEqual([])
    expect(parseSodaYrcTimeline(undefined)).toEqual([])
    expect(parseSodaYrcTimeline('纯文本歌词\n没有时间戳')).toEqual([])
    expect(parseSodaYrcTimeline('[00:01.000]普通 LRC')).toEqual([])
  })

  it('空 token 被跳过（与 sodaConvertLyric 的 LRC 化行为一致）', () => {
    const rows = parseSodaYrcTimeline('[5000,1000]<0,300,0><300,700,0>尾')
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('尾')
    expect(rows[0].words).toEqual([{ text: '尾', start: 5300, end: 6000 }])
  })
})

describe('buildSodaWordTimeline（/api/soda/lyric words 字段组装 + 翻译内联）', () => {
  it('yrc 主歌词 + 平铺 LRC 翻译 → translated 按 ≤500ms 就近内联', () => {
    const lyric = [
      '[12000,6500]<0,1800,0>你好<1800,2200,0>世界',
      '[20000,6000](20000,1600,0)那是故事开头',
    ].join('\n')
    const tlyric = ['[00:12.000]Hello world', '[00:20.000]Once upon a time'].join('\n')
    const rows = buildSodaWordTimeline(lyric, tlyric)
    expect(rows).not.toBeNull()
    expect(rows!.map((row: { translated?: string }) => row.translated)).toEqual(['Hello world', 'Once upon a time'])
  })

  it('翻译为逐字 yrc 形态时同样可内联', () => {
    const lyric = '[12000,3000]<0,1500,0>风起<1500,1500,0>云涌'
    const tlyric = '[12000,3000]<0,1500,0>The wind rises<1500,1500,0>and clouds surge'
    const rows = buildSodaWordTimeline(lyric, tlyric)
    expect(rows![0].translated).toBe('The wind risesand clouds surge')
  })

  it('主歌词非 yrc（公开目录平铺 LRC 兜底）→ 返回 null，响应保持无逐字数据', () => {
    const lrc = ['[00:10.000]普通旋律线', '[00:14.000]第二段'].join('\n')
    expect(buildSodaWordTimeline(lrc, '')).toBeNull()
    expect(buildSodaWordTimeline('', '')).toBeNull()
  })

  it('超出 500ms 容差的译文不对齐到该行', () => {
    const lyric = '[10000,2000]<0,1000,0>对齐不到'
    const tlyric = '[00:12.500]差了将近三秒'
    const rows = buildSodaWordTimeline(lyric, tlyric)
    expect(rows!.length).toBe(1)
    expect(rows![0].translated).toBeUndefined()
  })
})

describe('sodaLyrics.ts 前端归一化（wire 绝对毫秒 → LyricLine/LyricWord 渲染契约）', () => {
  const WIRE_ROWS: unknown[] = [
    {
      start: 12000,
      end: 18500,
      text: '你好世界汽水',
      translated: 'Hello world soda',
      words: [
        { text: '你好', start: 12000, end: 13800 },
        { text: '世界', start: 13800, end: 16000 },
        { text: '汽水', start: 16000, end: 18500 },
      ],
    },
    { start: 9000, end: 9500, text: '[前奏标注]' }, // 无词级 token 的行 → 纯文本行
  ]

  it('asSodaWordRows 守卫：null/非数组/脏结构拒绝，合法数组通过', () => {
    expect(asSodaWordRows(null)).toBeNull()
    expect(asSodaWordRows(undefined)).toBeNull()
    expect(asSodaWordRows([])).toBeNull()
    expect(asSodaWordRows([{ start: 'abc' }])).toBeNull()
    expect(asSodaWordRows(WIRE_ROWS)).not.toBeNull()
  })

  it('sodaWordRowsToLyricLines：time 秒、startTime 相对行首、duration 毫秒、翻译内联', () => {
    const lines = sodaWordRowsToLyricLines(WIRE_ROWS as never[])
    // 升序排列后前奏行在前
    expect(lines.map(line => line.text)).toEqual(['[前奏标注]', '你好世界汽水'])
    const sung = lines[1]
    expect(sung.time).toBeCloseTo(12)
    expect(sung.translation).toBe('Hello world soda')
    expect(sung.words).toEqual([
      { word: '你好', startTime: 0, duration: 1800 },
      { word: '世界', startTime: 1800, duration: 2200 },
      { word: '汽水', startTime: 4000, duration: 2500 },
    ])
    // 无 token 行不携带 words（走普通渲染语义）
    expect(lines[0].words).toBeUndefined()
  })

  it('text 缺省时回退用 words 拼出行文本，空数据行为安全', () => {
    const lines = sodaWordRowsToLyricLines([
      { start: 1000, end: 2000, words: [{ text: '依', start: 1000, end: 1500 }, { text: '旧', start: 1500, end: 2000 }] } as never,
    ])
    expect(lines).toEqual([
      {
        time: 1,
        text: '依旧',
        words: [
          { word: '依', startTime: 0, duration: 500 },
          { word: '旧', startTime: 500, duration: 500 },
        ],
        translation: undefined,
      },
    ])
    expect(sodaWordRowsToLyricLines([{ start: 1000, end: 1000, text: '' } as never])).toEqual([])
  })
})
