import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CompensationService, COMPENSATION_PRESETS } from '../src/services/audio-effects-v2/compensationService'
import { AudioEffectsEngine, LOUDNESS_COMPENSATION_THRESHOLD } from '../src/services/audio-effects-v2/AudioEffectsEngine'

// localStorage stub 由 test/setup.ts 注入；此处每次清空。
// compensationService.design() 内部使用 window.setTimeout 做请求超时，
// vitest node 环境无 window，这里补一个最小 stub（setTimeout/clearTimeout 透传全局定时器）。
beforeEach(() => {
  try { localStorage.clear() } catch { /* noop */ }
  vi.stubGlobal('window', {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 构造一个 200 的补偿设计响应 */
function okResponse(segments: unknown[], extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ segments, ...extra }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const VALID_SEGMENTS = [
  { type: 'lowshelf', frequency: 120, q: 0.7, gain: 4 },
  { type: 'highshelf', frequency: 7000, q: 0.7, gain: 2 },
] as const

describe('compensationService.design 缓存与降级行为', () => {
  it('fetch 不可用（网络拒绝）时 design 返回 null', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()
    const result = await svc.design('preset', 'bass', null)
    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('失败后进入退避窗口：短期内再次设计不再发起请求，直接返回 null', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()
    await svc.design('preset', 'bass', null) // 失败 → pythonUnavailableUntil = now + 5s
    const again = await svc.design('preset', 'bass', null)
    expect(again).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1) // 退避期内未再次请求
  })

  it('退避窗口过期后恢复请求，服务恢复可用时返回设计', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(okResponse([{ type: 'peaking', frequency: 1000, q: 1, gain: 2 }], { label: '恢复曲线', preset: 'bass' }))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()
    expect(await svc.design('preset', 'bass', null)).toBeNull()
    vi.advanceTimersByTime(5_000) // 越过 5s 退避窗口
    const design = await svc.design('preset', 'bass', null)
    expect(design).not.toBeNull()
    expect(design!.label).toBe('恢复曲线')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('服务成功时缓存设计：相同请求再次调用不再发起 fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_SEGMENTS, { label: '预设曲线', preset: 'bass' }))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()
    const d1 = await svc.design('preset', 'bass', null)
    expect(d1).not.toBeNull()
    expect(d1!.segments).toEqual(VALID_SEGMENTS)
    expect(d1!.mode).toBe('preset')
    expect(d1!.preset).toBe('bass')
    expect(d1!.volume).toBeUndefined()

    const d2 = await svc.design('preset', 'bass', null)
    expect(d2).toEqual(d1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('缓存持久化到 localStorage：新实例（无内存缓存）命中同一设计，不重复请求', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_SEGMENTS, { preset: 'bass' }))
    vi.stubGlobal('fetch', fetchMock)
    const svc1 = new CompensationService()
    await svc1.design('preset', 'bass', null)

    const svc2 = new CompensationService() // 全新实例，仅能靠 localStorage 命中
    const design = await svc2.design('preset', 'bass', null)
    expect(design).not.toBeNull()
    expect(design!.segments.length).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('响应缺 label 时补默认文案「频响补偿」', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_SEGMENTS)) // 无 label
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()
    const design = await svc.design('preset', 'bass', null)
    expect(design).not.toBeNull()
    expect(design!.label).toBe('频响补偿')
  })

  it('auto 模式按音量分档缓存（±5% 同档共享），跨档则重新设计', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_SEGMENTS))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()
    await svc.design('auto', 'flat', 52) // 桶 50
    const sameBucket = await svc.design('auto', 'flat', 48) // 桶 50 → 命中缓存
    expect(sameBucket).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await svc.design('auto', 'flat', 78) // 桶 80 → 缓存未命中
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('auto 模式音量越界时 clamp 到 0~100 档位', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_SEGMENTS))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()
    await svc.design('auto', 'flat', 150) // clamp → 桶 100
    const clamped = await svc.design('auto', 'flat', 99) // 桶 100 → 命中
    expect(clamped).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('请求体按模式携带正确字段（volume / preset / bands）与地址', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(VALID_SEGMENTS))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()

    await svc.design('auto', 'flat', 60)
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3004/compensation')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ mode: 'auto', volume: 60 })

    await svc.design('preset', 'night', null)
    const presetBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(presetBody).toMatchObject({ mode: 'preset', preset: 'night' })
    expect(presetBody.volume).toBeUndefined()

    await svc.design('custom', 'flat', null, [{ frequency: 60, gain: 3 }, { frequency: 12000, gain: -2 }])
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      mode: 'custom',
      bands: [{ frequency: 60, gain: 3 }, { frequency: 12000, gain: -2 }],
    })
  })

  it('HTTP 非 2xx 返回 null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('server error', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()
    expect(await svc.design('preset', 'bass', null)).toBeNull()
  })

  it('响应缺少有效 segments 返回 null 且不缓存（下次仍会请求）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([])) // 空 segments
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()
    expect(await svc.design('preset', 'bass', null)).toBeNull()
    await svc.design('preset', 'bass', null)
    expect(fetchMock).toHaveBeenCalledTimes(2) // 未缓存 → 再次请求
  })

  it('invalidate() 使在途设计结果失效：延迟响应被丢弃并返回 null', async () => {
    let resolveFetch: ((r: Response) => void) | undefined
    const fetchMock = vi.fn(() => new Promise<Response>(res => { resolveFetch = res }))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()

    const pending = svc.design('preset', 'bass', null)
    svc.invalidate() // 使在途请求失效
    resolveFetch!(okResponse(VALID_SEGMENTS))
    const result = await pending
    expect(result).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('并发相同请求共享同一在途 Promise，只发起一次请求', async () => {
    let resolveFetch: ((r: Response) => void) | undefined
    const fetchMock = vi.fn(() => new Promise<Response>(res => { resolveFetch = res }))
    vi.stubGlobal('fetch', fetchMock)
    const svc = new CompensationService()

    const p1 = svc.design('preset', 'bass', null)
    const p2 = svc.design('preset', 'bass', null)

    resolveFetch!(okResponse(VALID_SEGMENTS, { preset: 'bass' }))
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).not.toBeNull()
    expect(r1).toEqual(r2) // 共享同一设计结果
    expect(fetchMock).toHaveBeenCalledTimes(1) // 去重：只发一次请求
  })

  it('COMPENSATION_PRESETS 提供 6 个场景预设（首个为 flat 监听平直）', () => {
    expect(COMPENSATION_PRESETS).toHaveLength(6)
    expect(COMPENSATION_PRESETS[0].id).toBe('flat')
    expect(COMPENSATION_PRESETS.map(p => p.id)).toEqual(['flat', 'bass', 'vocal', 'warm', 'bright', 'night'])
  })
})

describe('设置迁移：loudnessCompensation（mode/preset/bands 缺省补默认）', () => {
  it('旧数据无 bands 字段 → 加载后补默认空数组，enabled/mode/preset 保留', () => {
    localStorage.setItem('waveforge:audio-effects-settings', JSON.stringify({
      effects: { loudnessCompensation: { enabled: true, mode: 'custom', preset: 'flat' } },
      eq: { enabled: false, mode: 'simple', simpleBands: [0, 0, 0, 0, 0], proBands: [] },
      pitch: { enabled: false, semitones: 0, rate: 1, voiceBalance: 0 },
    }))
    const engine = new AudioEffectsEngine()
    const lc = engine.getSettings().effects.loudnessCompensation
    expect(lc.bands).toEqual([]) // 缺 bands → 默认空数组
    expect(lc.enabled).toBe(true)
    expect(lc.mode).toBe('custom')
    expect(lc.preset).toBe('flat')
  })

  it('旧数据有 bands → 原样保留，不被默认值覆盖', () => {
    localStorage.setItem('waveforge:audio-effects-settings', JSON.stringify({
      effects: { loudnessCompensation: { enabled: true, mode: 'custom', preset: 'flat', bands: [{ frequency: 60, gain: 3 }, { frequency: 12000, gain: -2 }] } },
      eq: { enabled: false, mode: 'simple', simpleBands: [0, 0, 0, 0, 0], proBands: [] },
      pitch: { enabled: false, semitones: 0, rate: 1, voiceBalance: 0 },
    }))
    const engine = new AudioEffectsEngine()
    expect(engine.getSettings().effects.loudnessCompensation.bands).toEqual([
      { frequency: 60, gain: 3 },
      { frequency: 12000, gain: -2 },
    ])
  })

  it('旧数据完全没有 mode/preset → 补全默认（auto/flat/[]）', () => {
    localStorage.setItem('waveforge:audio-effects-settings', JSON.stringify({
      effects: { loudnessCompensation: { enabled: true } },
      eq: { enabled: false, mode: 'simple', simpleBands: [0, 0, 0, 0, 0], proBands: [] },
      pitch: { enabled: false, semitones: 0, rate: 1, voiceBalance: 0 },
    }))
    const engine = new AudioEffectsEngine()
    const lc = engine.getSettings().effects.loudnessCompensation
    expect(lc.enabled).toBe(true)
    expect(lc.mode).toBe('auto')
    expect(lc.preset).toBe('flat')
    expect(lc.bands).toEqual([])
  })

  it('updateSettings 部分更新其他音效时不会丢失 bands（但互斥会关掉补偿）', () => {
    const engine = new AudioEffectsEngine()
    engine.updateSettings({ effects: {
      loudnessCompensation: { enabled: true, mode: 'custom', preset: 'flat', bands: [{ frequency: 80, gain: 4 }] },
    } })
    // 打开音效 bassBoost → 与频响补偿互斥（#3）：补偿自动关闭，但 bands/mode/preset 参数保留
    engine.updateSettings({ effects: { bassBoost: { enabled: true, depth: 90, intensity: 5 } } })
    const lc = engine.getSettings().effects.loudnessCompensation
    expect(lc.bands).toEqual([{ frequency: 80, gain: 4 }])
    expect(lc.mode).toBe('custom')
    expect(lc.preset).toBe('flat')
    // 互斥生效：打开音效后补偿被关闭（参数不丢失，仅 enabled 变 false）
    expect(lc.enabled).toBe(false)
  })

  it('低音量提示阈值常量为 50', () => {
    expect(LOUDNESS_COMPENSATION_THRESHOLD).toBe(50)
  })
})

// ============ 算法正确性（纯逻辑，JS 复刻服务端公式） ============
// 以下常量与 python-beat-service/compensation_server.py 的 design_equal_loudness 完全一致：
// REF_SPL_DB/MIN_SPL_DB/增益系数（0.35/0.15）/上限（12/6）/滤波器参数（120Hz / 12000Hz / Q0.707）。
// Python 端 import flask，无法在 vitest node 环境直接运行，故在此用同款公式复刻
// （含 np.clip 语义与 round(x, 2) 两位舍入），并已在 10/20/50/90/96/100/150/-10 音量下与
// 服务端实跑结果逐值比对一致。
const REF_SPL_DB = 80.0
const MIN_SPL_DB = 50.0
const LOW_GAIN_PER_DB = 0.35
const HIGH_GAIN_PER_DB = 0.15
const MAX_LOW_GAIN_DB = 12.0
const MAX_HIGH_GAIN_DB = 6.0
const LOW_SHELF_FREQ = 120.0
const LOW_SHELF_Q = 0.707
const HIGH_SHELF_FREQ = 12000.0
const HIGH_SHELF_Q = 0.707
/** 段增益低于 0.5dB 时省略该段（与服务端一致） */
const SEGMENT_MIN_GAIN = 0.5

interface ShelfSegment {
  type: 'lowshelf' | 'highshelf'
  frequency: number
  q: number
  gain: number
}

/** 音量百分比 → 估计回放 SPL（dB），与服务端 volume_to_spl 一致（100%≈80dB、0%≈50dB 线性映射） */
function volumeToSpl(volume: number): number {
  const v = Math.max(0, Math.min(100, volume))
  return MIN_SPL_DB + (REF_SPL_DB - MIN_SPL_DB) * (v / 100)
}

/** 与服务端 design_equal_loudness 同款公式：2 段 shelf（低频 LowShelf + 高频 HighShelf），只提升不衰减 */
function designEqualLoudness(volume: number): ShelfSegment[] {
  const spl = volumeToSpl(volume)
  const deficit = REF_SPL_DB - spl // 低音量亏欠量（0 → 30dB）
  const lowGain = Math.round(Math.max(0, Math.min(MAX_LOW_GAIN_DB, deficit * LOW_GAIN_PER_DB)) * 100) / 100
  const highGain = Math.round(Math.max(0, Math.min(MAX_HIGH_GAIN_DB, deficit * HIGH_GAIN_PER_DB)) * 100) / 100

  const segments: ShelfSegment[] = []
  if (lowGain >= SEGMENT_MIN_GAIN) {
    segments.push({ type: 'lowshelf', frequency: LOW_SHELF_FREQ, q: LOW_SHELF_Q, gain: lowGain })
  }
  if (highGain >= SEGMENT_MIN_GAIN) {
    segments.push({ type: 'highshelf', frequency: HIGH_SHELF_FREQ, q: HIGH_SHELF_Q, gain: highGain })
  }
  return segments
}

// RBJ Audio EQ Cookbook shelf 系数（Web Audio BiquadFilterNode 同款），用于级联频响验证
interface BiquadCoeffs { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number }

function shelfCoeffs(type: 'lowshelf' | 'highshelf', f0: number, q: number, gainDb: number, fs: number): BiquadCoeffs {
  const A = Math.pow(10, gainDb / 40)
  const w0 = 2 * Math.PI * f0 / fs
  const cosW0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const sA = Math.sqrt(A)
  if (type === 'lowshelf') {
    return {
      b0: A * ((A + 1) - (A - 1) * cosW0 + 2 * sA * alpha),
      b1: 2 * A * ((A - 1) - (A + 1) * cosW0),
      b2: A * ((A + 1) - (A - 1) * cosW0 - 2 * sA * alpha),
      a0: (A + 1) + (A - 1) * cosW0 + 2 * sA * alpha,
      a1: -2 * ((A - 1) + (A + 1) * cosW0),
      a2: (A + 1) + (A - 1) * cosW0 - 2 * sA * alpha,
    }
  }
  return {
    b0: A * ((A + 1) + (A - 1) * cosW0 + 2 * sA * alpha),
    b1: -2 * A * ((A - 1) + (A + 1) * cosW0),
    b2: A * ((A + 1) + (A - 1) * cosW0 - 2 * sA * alpha),
    a0: (A + 1) - (A - 1) * cosW0 + 2 * sA * alpha,
    a1: 2 * ((A - 1) - (A + 1) * cosW0),
    a2: (A + 1) - (A - 1) * cosW0 - 2 * sA * alpha,
  }
}

function biquadMagDb(c: BiquadCoeffs, f: number, fs: number): number {
  const w = 2 * Math.PI * f / fs
  const reNum = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w)
  const imNum = c.b1 * Math.sin(w) + c.b2 * Math.sin(2 * w)
  const reDen = c.a0 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w)
  const imDen = c.a1 * Math.sin(w) + c.a2 * Math.sin(2 * w)
  const mag = Math.sqrt((reNum * reNum + imNum * imNum) / (reDen * reDen + imDen * imDen))
  return 20 * Math.log10(mag)
}

/** 多段 shelf 级联在某频率的总增益（dB），级联 dB 相加（验证中频不被污染） */
function cascadeShelfDb(segments: ShelfSegment[], f: number, fs: number): number {
  return segments.reduce((sum, seg) => sum + biquadMagDb(shelfCoeffs(seg.type, seg.frequency, seg.q, seg.gain, fs), f, fs), 0)
}

describe('design_equal_loudness 算法正确性（JS 复刻服务端公式）', () => {
  it('音量 100 → 无补偿（增益 0/0，不生成任何段）', () => {
    expect(designEqualLoudness(100)).toEqual([])
  })

  it('音量 50 → 低频≈+5.2（精确 +5.25）、高频≈+2.2（精确 +2.25）', () => {
    const segments = designEqualLoudness(50)
    expect(segments).toHaveLength(2)
    expect(segments.find(s => s.type === 'lowshelf')!.gain).toBe(5.25) // 服务端 round(15×0.35, 2)
    expect(segments.find(s => s.type === 'highshelf')!.gain).toBe(2.25) // 服务端 round(15×0.15, 2)
  })

  it('音量 20 → 低频≈+8.4、高频≈+3.6', () => {
    const segments = designEqualLoudness(20)
    expect(segments).toHaveLength(2)
    expect(segments.find(s => s.type === 'lowshelf')!.gain).toBe(8.4)
    expect(segments.find(s => s.type === 'highshelf')!.gain).toBe(3.6)
  })

  it('音量 10 → 低频≈+9.4（精确 +9.45）、高频≈+4.0（精确 +4.05）', () => {
    const segments = designEqualLoudness(10)
    expect(segments).toHaveLength(2)
    expect(segments.find(s => s.type === 'lowshelf')!.gain).toBe(9.45)
    expect(segments.find(s => s.type === 'highshelf')!.gain).toBe(4.05)
  })

  it('低频增益恒 ≥ 高频增益（约 0.35/0.15≈2.33 倍），且只提升不衰减', () => {
    for (let v = 0; v <= 100; v += 1) {
      const segments = designEqualLoudness(v)
      const low = segments.find(s => s.type === 'lowshelf')?.gain ?? 0
      const high = segments.find(s => s.type === 'highshelf')?.gain ?? 0
      expect(low).toBeGreaterThanOrEqual(high)
      expect(low).toBeGreaterThanOrEqual(0) // 只提升不衰减
      expect(high).toBeGreaterThanOrEqual(0)
      if (high > 0) {
        expect(low / high).toBeCloseTo(LOW_GAIN_PER_DB / HIGH_GAIN_PER_DB, 1) // ≈ 2.33（±0.05）
      }
    }
  })

  it('任何音量下低频 ≤ 12dB、高频 ≤ 6dB（上限保护，防削波）', () => {
    for (let v = 0; v <= 200; v += 1) { // 含越界音量（clamp 后仍合规）
      for (const seg of designEqualLoudness(v)) {
        if (seg.type === 'lowshelf') expect(seg.gain).toBeLessThanOrEqual(MAX_LOW_GAIN_DB)
        if (seg.type === 'highshelf') expect(seg.gain).toBeLessThanOrEqual(MAX_HIGH_GAIN_DB)
      }
    }
  })

  it('auto 结构：只含 lowshelf/highshelf（无 peaking），各至多 1 段', () => {
    for (const v of [10, 20, 50, 90, 95]) {
      const segments = designEqualLoudness(v)
      expect(segments.length).toBeGreaterThan(0)
      for (const seg of segments) {
        expect(['lowshelf', 'highshelf']).toContain(seg.type) // 无 peaking
      }
      expect(segments.filter(s => s.type === 'lowshelf').length).toBeLessThanOrEqual(1)
      expect(segments.filter(s => s.type === 'highshelf').length).toBeLessThanOrEqual(1)
    }
    // 典型音量（10/20/50）低频与高频段各恰好 1 段
    for (const v of [10, 20, 50]) {
      const segments = designEqualLoudness(v)
      expect(segments.filter(s => s.type === 'lowshelf')).toHaveLength(1)
      expect(segments.filter(s => s.type === 'highshelf')).toHaveLength(1)
    }
  })

  it('低频 120Hz / 高频 12000Hz 与 Q 0.707 参数正确', () => {
    for (const v of [10, 20, 50]) {
      const segments = designEqualLoudness(v)
      const low = segments.find(s => s.type === 'lowshelf')!
      const high = segments.find(s => s.type === 'highshelf')!
      expect(low.frequency).toBe(LOW_SHELF_FREQ)
      expect(low.q).toBe(LOW_SHELF_Q)
      expect(high.frequency).toBe(HIGH_SHELF_FREQ)
      expect(high.q).toBe(HIGH_SHELF_Q)
    }
  })

  it('音量越界 clamp：150 → 无补偿（等同 100），-10 → 满补偿（等同 0）', () => {
    expect(designEqualLoudness(150)).toEqual(designEqualLoudness(100))
    expect(designEqualLoudness(-10)).toEqual(designEqualLoudness(0))
  })

  it('高音量边界：96% 时亏欠量不足（+0.42/+0.18 < 0.5 阈值）→ 不生成任何段', () => {
    expect(designEqualLoudness(96)).toEqual([])
    expect(designEqualLoudness(90)).toEqual([{ type: 'lowshelf', frequency: 120, q: 0.707, gain: 1.05 }])
  })
})

describe('中频零污染：两段 shelf 级联在 1kHz 处增益≈0dB（RBJ biquad 频响验证）', () => {
  it('音量 50（+5.25/+2.25）在 1kHz 级联增益 ≈ 0dB（±1）', () => {
    for (const fs of [44100, 48000]) {
      expect(Math.abs(cascadeShelfDb(designEqualLoudness(50), 1000, fs))).toBeLessThan(1)
    }
  })

  it('音量 10（+9.45/+4.05）在 1kHz 级联增益 ≈ 0dB（±1）', () => {
    for (const fs of [44100, 48000]) {
      expect(Math.abs(cascadeShelfDb(designEqualLoudness(10), 1000, fs))).toBeLessThan(1)
    }
  })

  it('12kHz 高频段：1kHz 残留 ≈ 0dB、8kHz 残留 ≤ 1dB（服务端注释 0.00 / 0.63）', () => {
    const fs = 48000
    const highOnly = designEqualLoudness(10).filter(s => s.type === 'highshelf')
    expect(Math.abs(cascadeShelfDb(highOnly, 1000, fs))).toBeLessThan(0.1) // 实测 0.0001
    expect(cascadeShelfDb(designEqualLoudness(10), 8000, fs)).toBeLessThan(1) // 实测 0.42
  })
})
