/**
 * WaveForge 音频引擎 v3 —— 组合场景预设（ScenePresets）
 *
 * 出处/许可：
 *  - 场景预设概念继承自本项目 v2 的"组合场景"功能（历史公开功能，自研）；
 *  - 各场景参数语义依据《音频算法设计文档.md》功能清单与听感目标设计（自研）。
 *
 * 说明：
 *  - 每个场景 = createDefaultParams(48000) 派生后覆盖 EQ 曲线 + 混响 + 压缩 +
 *    低音 + 齿音等，构成完整参数快照（快照语义，params.sceneId = 自身 id）；
 *  - 快照不含 IR 数据（卷积 IR 一律 null，混响走算法混响，符合"用 irName 引用"约定）；
 *  - params.sampleRate 为快照标称采样率；EngineV3 实际以构造时采样率处理。
 */

import { createDefaultParams, PRO_EQ_DEFAULT_BANDS } from '../types'
import type { ScenePreset, V3EngineParams } from '../types'

/** 11 个场景 id（顺序固定，与 SCENE_PRESETS 一一对应） */
export const SCENE_IDS = [
  'pop',
  'enhanced',
  'jazz',
  'dance',
  'classical',
  'livehouse',
  'studio',
  'warm',
  'dts',
  'vocal-stage',
  'night-bass',
] as const

/** 快照标称采样率 */
const SNAPSHOT_FS = 48000

/** 由默认参数派生一个场景基础快照 */
function base(): V3EngineParams {
  const p = createDefaultParams(SNAPSHOT_FS)
  return p
}

/** 用 10 段增益（对应 PRO_EQ_DEFAULT_BANDS 频率）覆盖专业 EQ 曲线 */
function applyEqCurve(p: V3EngineParams, gains: number[]): void {
  const list = PRO_EQ_DEFAULT_BANDS.map((f, i) => ({
    frequency: f,
    gain: gains[i] ?? 0,
    q: 1.1,
  }))
  p.eq.enabled = true
  p.eq.mode = 'pro'
  p.eq.bandCount = 10
  p.eq.proBands = list
}

/** 便捷函数：开启算法混响并设定参数（仅空间类场景使用——混响是空间语义，非空间场景保持干声） */
function setReverb(p: V3EngineParams, opts: {
  type: 'hall' | 'room' | 'plate' | 'spring' | 'stage'
  roomSize: number
  damping: number
  wet: number
  dry: number
  preDelayMs?: number
  width?: number
}): void {
  p.reverb.enabled = true
  p.reverb.mode = 'algorithmic'
  p.reverb.algorithmic.type = opts.type
  p.reverb.algorithmic.roomSize = opts.roomSize
  p.reverb.algorithmic.damping = opts.damping
  p.reverb.algorithmic.wet = opts.wet
  p.reverb.algorithmic.dry = opts.dry
  p.reverb.algorithmic.preDelayMs = opts.preDelayMs ?? 0
  p.reverb.algorithmic.width = opts.width ?? 1
}

/** 关闭混响（干声直通）：仅关 enabled，mode 保持 algorithmic（默认值）。
 *  不把 mode 设成 'off'——否则用户在调音室打开混响开关时 mode 仍是 'off'，
 *  引擎继续直通（路由条件是 enabled && mode !== 'off'），看起来"开不动"，
 *  用户得进二级选项卡手动切到 algorithmic 才有声。mode='off' 只应由用户在
 *  二级选项卡里手动选"关闭"时设。 */
function disableReverb(p: V3EngineParams): void {
  p.reverb.enabled = false
  p.reverb.mode = 'algorithmic'
}

function setCompressor(p: V3EngineParams, opts: {
  thresholdDb: number
  ratio: number
  kneeDb?: number
  attackMs?: number
  releaseMs?: number
  makeupDb?: number
}): void {
  p.compressor.enabled = true
  p.compressor.thresholdDb = opts.thresholdDb
  p.compressor.ratio = opts.ratio
  p.compressor.kneeDb = opts.kneeDb ?? 6
  p.compressor.attackMs = opts.attackMs ?? 10
  p.compressor.releaseMs = opts.releaseMs ?? 150
  p.compressor.makeupDb = opts.makeupDb ?? 0
}

function setBass(p: V3EngineParams, opts: {
  cutoffHz?: number
  q?: number
  harmonicType?: 'odd' | 'even' | 'atan' | 'soft'
  harmonicGain?: number
  mix?: number
  levelDb?: number
  lowBoostDb?: number
}): void {
  p.bassEnhancer.enabled = true
  p.bassEnhancer.cutoffHz = opts.cutoffHz ?? 90
  p.bassEnhancer.q = opts.q ?? 0.7
  p.bassEnhancer.harmonicType = opts.harmonicType ?? 'odd'
  p.bassEnhancer.harmonicGain = opts.harmonicGain ?? 0.6
  p.bassEnhancer.mix = opts.mix ?? 0.5
  p.bassEnhancer.levelDb = opts.levelDb ?? 0
  p.bassEnhancer.lowBoostDb = opts.lowBoostDb ?? 0
}

function setDeesser(p: V3EngineParams, opts: {
  centerHz?: number
  q?: number
  thresholdDb?: number
  ratio?: number
  splitBand?: boolean
  mix?: number
}): void {
  p.deesser.enabled = true
  p.deesser.centerHz = opts.centerHz ?? 6000
  p.deesser.q = opts.q ?? 0.7
  p.deesser.thresholdDb = opts.thresholdDb ?? -30
  p.deesser.ratio = opts.ratio ?? 8
  p.deesser.splitBand = opts.splitBand ?? true
  p.deesser.mix = opts.mix ?? 1
}

function finish(p: V3EngineParams, id: string): ScenePreset {
  p.sceneId = id
  p.customized = false
  return { id, name: '', builtin: true, params: p }
}

/** 11 个组合场景：流行/摇滚/爵士/舞曲/古典/LiveHouse/录音棚/温暖/DTS 浩渺/悠扬舞台/深夜低音 */
export const SCENE_PRESETS: ScenePreset[] = [
  (() => {
    const p = base()
    // 流行：轻微微笑曲线（低音+中高音突出），中等压缩，轻虚拟低音（干声，不加空间混响）
    applyEqCurve(p, [3.5, 2.5, 1.5, 0.5, -0.5, 0, 1, 2, 2.5, 1.5])
    setCompressor(p, { thresholdDb: -18, ratio: 2.5, kneeDb: 8, attackMs: 12, releaseMs: 180, makeupDb: 5 })
    disableReverb(p)
    setBass(p, { cutoffHz: 100, harmonicGain: 0.35, mix: 0.3, lowBoostDb: 3 })
    setDeesser(p, { centerHz: 6500 })
    const sc = finish(p, 'pop')
    sc.name = '流行'
    sc.description = '流行乐通用：微笑 EQ 曲线 + 人声突出 + 干净直达人声'
    return sc
  })(),
  (() => {
    const p = base()
    // 摇滚：中频凹陷（吉他/人声让位），中高频锐利，重压缩，低频有力（干声保冲击）
    applyEqCurve(p, [2.5, 2, 0.5, -1.5, -1.5, 0, 1.5, 2.5, 3, 2])
    setCompressor(p, { thresholdDb: -22, ratio: 5, kneeDb: 4, attackMs: 5, releaseMs: 120, makeupDb: 13 })
    disableReverb(p)
    setBass(p, { cutoffHz: 85, harmonicType: 'odd', harmonicGain: 0.6, mix: 0.5, lowBoostDb: 6 })
    // 齿音抑制默认关闭：摇滚高频本就锐利，去齿音会削掉吉他泛音与镲片亮度
    const sc = finish(p, 'enhanced')
    sc.name = '增强'
    sc.description = '增强现场感：中频凹陷 + 强压缩 + 低频冲击（干声）'
    return sc
  })(),
  (() => {
    const p = base()
    // 爵士：温暖柔和，高频略收，俱乐部轻大厅混响，轻压缩（保留动态）
    applyEqCurve(p, [2, 1.5, 1, 0.5, 0, 0, 0.5, 0.5, -0.5, -1])
    setCompressor(p, { thresholdDb: -16, ratio: 1.8, kneeDb: 10, attackMs: 20, releaseMs: 250, makeupDb: 4 })
    setReverb(p, { type: 'hall', roomSize: 0.55, damping: 0.45, wet: 0.35, dry: 0.8, preDelayMs: 10 })
    const sc = finish(p, 'jazz')
    sc.name = '爵士'
    sc.description = '爵士俱乐部：温暖音色 + 轻大厅空间 + 柔和动态'
    return sc
  })(),
  (() => {
    const p = base()
    // 舞曲：大低音 + 明亮高频 + 泵感压缩 + 立体声加宽（干声保舞池冲击力）
    applyEqCurve(p, [4, 3, 1.5, 0.5, -0.5, 0, 1, 2, 3, 3])
    setCompressor(p, { thresholdDb: -14, ratio: 4, kneeDb: 4, attackMs: 8, releaseMs: 90, makeupDb: 4 })
    disableReverb(p)
    setBass(p, { cutoffHz: 100, harmonicType: 'even', harmonicGain: 0.7, mix: 0.6, levelDb: 1, lowBoostDb: 6 })
    setDeesser(p, { centerHz: 7500, thresholdDb: -26 })
    p.stereoWidth = 1.2
    const sc = finish(p, 'dance')
    sc.name = '舞曲'
    sc.description = '舞池能量：重低音 + 泵感压缩 + 高频光泽 + 宽声场（干声）'
    return sc
  })(),
  (() => {
    const p = base()
    // 古典：接近平直 + 长尾大厅混响 + 极轻压缩 + 宽声场（保留动态与定位）
    applyEqCurve(p, [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0.5, 0.5])
    setCompressor(p, { thresholdDb: -24, ratio: 1.5, kneeDb: 12, attackMs: 30, releaseMs: 400, makeupDb: 1 })
    setReverb(p, { type: 'hall', roomSize: 0.75, damping: 0.3, wet: 0.55, dry: 0.7, preDelayMs: 15 })
    p.stereoWidth = 1.15
    const sc = finish(p, 'classical')
    sc.name = '古典'
    sc.description = '音乐厅演绎：平直频响 + 长混响尾音 + 宽广声场'
    return sc
  })(),
  (() => {
    const p = base()
    // LiveHouse：大空间感 + 中高频临场感 + 中等压缩
    applyEqCurve(p, [1, 1, 0.5, 0, 0, 0.5, 1.5, 2, 2, 1])
    setCompressor(p, { thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 10, releaseMs: 200, makeupDb: 3 })
    setReverb(p, { type: 'stage', roomSize: 0.7, damping: 0.35, wet: 0.6, dry: 0.65, preDelayMs: 20 })
    const sc = finish(p, 'livehouse')
    sc.name = '现场'
    sc.description = 'LiveHouse 现场：大房间混响 + 临场中高频 + 稳健压缩'
    return sc
  })(),
  (() => {
    const p = base()
    // 录音棚：监听级平直 + 最小化处理 + 轻微齿音控制（完全干声，忠于原声）
    applyEqCurve(p, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    setCompressor(p, { thresholdDb: -16, ratio: 2, kneeDb: 10, attackMs: 15, releaseMs: 200, makeupDb: 4 })
    disableReverb(p)
    setDeesser(p, { centerHz: 7000, mix: 0.5 })
    const sc = finish(p, 'studio')
    sc.name = '录音棚'
    sc.description = '录音棚监听：平直频响 + 极轻处理，完全干声忠于原声'
    return sc
  })(),
  (() => {
    const p = base()
    // 温暖：低频/中低频饱满，高频柔和滚降（干声，温暖靠音色不靠空间）
    applyEqCurve(p, [3, 2.5, 2, 1, 0.5, 0, -0.5, -1.5, -2.5, -3])
    setCompressor(p, { thresholdDb: -18, ratio: 2, kneeDb: 10, attackMs: 20, releaseMs: 300, makeupDb: 5 })
    disableReverb(p)
    setBass(p, { cutoffHz: 110, harmonicGain: 0.4, mix: 0.35, lowBoostDb: 4 })
    const sc = finish(p, 'warm')
    sc.name = '温暖'
    sc.description = '温暖模拟味：饱满低音 + 柔和高频（干声）'
    return sc
  })(),
  (() => {
    const p = base()
    // DTS 浩渺：开阔大空间 + 明亮空气感 + 加宽声场 + 长混响（最强的空间向场景）
    applyEqCurve(p, [1, 1, 0.5, 0, 0, 0, 1, 2, 3, 3])
    setCompressor(p, { thresholdDb: -20, ratio: 2.5, kneeDb: 8, attackMs: 15, releaseMs: 250, makeupDb: 2 })
    setReverb(p, { type: 'hall', roomSize: 0.85, damping: 0.25, wet: 0.7, dry: 0.55, preDelayMs: 25, width: 1.4 })
    p.stereoWidth = 1.3
    const sc = finish(p, 'dts')
    sc.name = '浩渺'
    sc.description = 'DTS 浩渺：极开阔混响 + 空气感高频 + 超宽声场'
    return sc
  })(),
  (() => {
    const p = base()
    // 悠扬舞台：人声中心化（1–4kHz 临场提升）+ 齿音抑制 + 舞台混响
    applyEqCurve(p, [-0.5, 0, 0, 1, 1.5, 2.5, 2, 1.5, 0.5, 0])
    setCompressor(p, { thresholdDb: -18, ratio: 3, kneeDb: 6, attackMs: 8, releaseMs: 150, makeupDb: 0 })
    setReverb(p, { type: 'stage', roomSize: 0.5, damping: 0.45, wet: 0.45, dry: 0.75, preDelayMs: 8 })
    setDeesser(p, { centerHz: 6500, ratio: 10, thresholdDb: -32 })
    const sc = finish(p, 'vocal-stage')
    sc.name = '悠扬舞台'
    sc.description = '悠扬舞台：人声临场提升 + 齿音收敛 + 舞台空间'
    return sc
  })(),
  (() => {
    const p = base()
    // 深夜低音：夜间模式开启 + 重低音 + 高频收敛 + 强压缩（低音量下保持均衡，干声不添空间感）
    // 审计修复（C 报告）：原参数高频堆叠过暗（EQ -3dB@16k + night 预设 -3dB@16k +
    // nightMode shelf -12dB + deesser 6kHz 压制 → 10-15kHz 响应 -33.5dB 越出 ±24dB 契约界），
    // 现调平：EQ 高频 -2、nightMode 5（shelf -7.5dB）、deesser 阈值放宽、补偿预设换 warm
    applyEqCurve(p, [4, 3.5, 2, 0.5, 0, 0, -0.5, -1, -0.5, 0]) // 12.5k −0.5 / 16k 0（收敛迭代到契约界内）
    setCompressor(p, { thresholdDb: -24, ratio: 6, kneeDb: 4, attackMs: 5, releaseMs: 200, makeupDb: 15 })
    disableReverb(p)
    setBass(p, { cutoffHz: 120, harmonicType: 'even', harmonicGain: 0.8, mix: 0.7, levelDb: 1, lowBoostDb: 8 })
    setDeesser(p, { centerHz: 6000, thresholdDb: -36, ratio: 6 }) // 阈值放宽 + 比率降为 6，减少白噪声下的高频压制
    p.nightMode.enabled = true
    p.nightMode.amount = 1 // 6kHz shelf −1.5dB（验收复验迭代收敛：5→3→2→1 进入契约界）
    p.loudnessCompensation.enabled = true
    p.loudnessCompensation.mode = 'preset'
    p.loudnessCompensation.preset = 'warm'
    p.loudnessCompensation.volumePercent = 30
    p.loudnessCompensation.maxBoostDb = 12
    const sc = finish(p, 'night-bass')
    sc.name = '深夜低音'
    sc.description = '深夜低音：夜间模式 + 虚拟低频增强 + 高频收敛，低音量均衡耐听'
    return sc
  })(),
]

/** 按 id 查找场景；未找到返回 null。 */
export function getSceneById(id: string | null): ScenePreset | null {
  if (id === null) return null
  for (const sc of SCENE_PRESETS) {
    if (sc.id === id) return sc
  }
  return null
}
