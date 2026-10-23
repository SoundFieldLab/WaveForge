/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * MV 匹配「进化引擎」（2026-10-23）：在线逻辑回归 + 经验回放。
 *
 * 与 mvAdaptive（查表加固定分）的本质区别：那只是字典/tier 表——固定权重、无梯度。
 * 本模块是**真正的学习器**：每次匹配结局（播放成功 / 用户跳过 / 手动选择 / 拉黑 /
 * fallback 链耗尽）都成为一条带标签的训练样本，特征取自候选的客观信号（静态分、
 * 时长比、播放对数、UP 信任、类型 one-hot、查询排名…），SGD 在线更新权重。
 *
 * 架构（防灾难遗忘 + 防静态规则被带偏）：
 *   - **残差定位**：模型输出是 [-6, +6] 的**修正项**，叠加在静态规则分之上——
 *     静态模型保证下限（规则兜底），进化模型负责「静态模型判不准的边缘排序」。
 *   - **经验回放池**：保留最近 800 条事件样本，每次事件后从池中采样 40 条做
 *     mini-batch 重放（rehearsal），防止在线 SGD 被最近几首歌带偏（灾难遗忘）。
 *   - **置信门控**：样本量 <30 时修正幅度线性收缩（冷启动不乱插手）；L2 正则
 *     把无用特征的权重拉回 0——模型自己学会忽略噪声特征。
 *   - **标签语义**：+1 = 用户认可（播放成功且未被跳过/手动选择/永久标记），
 *     -1 = 用户否定（跳过、拉黑、fallback 耗尽）。auto-accept 且播完 = +1（权重 0.5，
 *     弱于显式反馈）。
 *
 * 全程本地（localStorage，LRU），零网络。
 */

const EVOLUTION_STORE_KEY = 'mv_evolution_model'
const EVOLUTION_STORE_VERSION = 2

/** 回放池上限 / 每次事件的重放批量 / 冷启动最小样本 / 修正幅度上限 */
const REPLAY_POOL_MAX = 800
const REPLAY_BATCH = 40
const COLD_START_MIN = 30
const DELTA_CLAMP = 6.0
const L2 = 0.002
const LR = 0.06

/** 特征名（与 extractFeatures 一一对应） */
export const EVOLUTION_FEATURES = [
  'staticScore', // 静态规则分 / 100（归一化）
  'durationRatio', // 视频时长/歌曲时长（clamp 2）
  'logPlay', // log10(播放+1) / 7
  'uploaderTrust', // UP 信任档位（0/0.5/1：learned tiers 归一）
  'isOfficialType', // 候选类型 official
  'isLiveType', // live
  'isCoverType', // cover
  'isInstrumental', // instrumental
  'isExtension', // 标题带延长/加长/完整版标记
  'queryRank', // 1/(1+搜索排名)
  'hasArtist', // 标题命中歌手
  'uploaderVerified', // UP 机构/个人认证
] as const

export type EvolutionFeatureName = typeof EVOLUTION_FEATURES[number]

export interface EvolutionSample {
  /** 13 维特征向量（与 EVOLUTION_FEATURES 对齐） */
  x: number[]
  /** +1 用户认可 / -1 用户否定 */
  y: 1 | -1
  /** 样本权重（显式反馈 1.0，auto 弱反馈 0.5） */
  w: number
  at: number
}

interface EvolutionModel {
  v: number
  /** 权重（与 EVOLUTION_FEATURES 对齐） */
  w: number[]
  bias: number
  /** 已消费事件数（学习进度） */
  n: number
  /** 经验回放池 */
  pool: EvolutionSample[]
  lastAt: number
}

function loadModel(): EvolutionModel {
  try {
    const raw = localStorage.getItem(EVOLUTION_STORE_KEY)
    if (!raw) return freshModel()
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.v !== EVOLUTION_STORE_VERSION || !Array.isArray(parsed.w)) return freshModel()
    return parsed as EvolutionModel
  } catch {
    return freshModel()
  }
}

function freshModel(): EvolutionModel {
  return {
    v: EVOLUTION_STORE_VERSION,
    // 全零初始化：冷启动时残差≈0，完全由静态规则驱动——安全
    w: EVOLUTION_FEATURES.map(() => 0),
    bias: 0,
    n: 0,
    pool: [],
    lastAt: 0,
  }
}

function saveModel(model: EvolutionModel): void {
  try {
    localStorage.setItem(EVOLUTION_STORE_KEY, JSON.stringify(model))
  } catch {
    /* 静默：进化引擎不致命 */
  }
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))))

/** 单步 SGD（逻辑损失 + L2），带样本权重。 */
function sgdStep(model: EvolutionModel, x: number[], y: number, w: number): void {
  const p = sigmoid(model.bias + x.reduce((acc, xi, i) => acc + model.w[i] * xi, 0))
  const err = (p - y) * w
  for (let i = 0; i < model.w.length; i += 1) {
    model.w[i] -= LR * (err * x[i] + L2 * model.w[i])
  }
  model.bias -= LR * err
}

/** 模型打分：返回修正项 [-DELTA_CLAMP, +DELTA_CLAMP]（logit 直接可用，无需 sigmoid）。 */
export function evolutionScore(x: number[]): number {
  const model = loadModel()
  if (model.n < COLD_START_MIN) {
    // 冷启动：按样本量线性解锁修正幅度（30 条起有感知，80 条全量）
    const ramp = Math.min(1, model.n / (COLD_START_MIN * 2.5))
    return clampDelta(model.bias + x.reduce((acc, xi, i) => acc + model.w[i] * xi, 0)) * ramp
  }
  return clampDelta(model.bias + x.reduce((acc, xi, i) => acc + model.w[i] * xi, 0))
}

function clampDelta(v: number): number {
  return Math.max(-DELTA_CLAMP, Math.min(DELTA_CLAMP, v))
}

/**
 * 消费一条匹配结局样本：入回放池 + SGD 单步 + 从池中重放 mini-batch（防遗忘）。
 * x 的特征由 extractEvolutionFeatures 从候选构造（见 bilibiliApi 接线）。
 */
export function consumeEvolutionSample(x: number[], y: 1 | -1, w: number): void {
  if (x.length !== EVOLUTION_FEATURES.length) return
  const model = loadModel()
  const sample: EvolutionSample = { x, y, w, at: Date.now() }
  // 1) 入池（LRU）
  model.pool.push(sample)
  if (model.pool.length > REPLAY_POOL_MAX) model.pool.splice(0, model.pool.length - REPLAY_POOL_MAX)
  // 2) 当前样本 SGD
  sgdStep(model, x, y, w)
  // 3) 经验回放：从池中随机采 mini-batch 重放（混正负，防遗忘）
  let rng = (sample.at % 2147483647) || 1
  const rand = () => {
    rng = (rng * 48271) % 2147483647
    return rng / 2147483647
  }
  const poolSize = model.pool.length
  const batch = Math.min(REPLAY_BATCH, poolSize)
  for (let k = 0; k < batch; k += 1) {
    const idx = Math.floor(rand() * poolSize)
    const s = model.pool[idx]
    sgdStep(model, s.x, s.y, s.w * 0.5) // 重放权重减半：当前事件优先
  }
  model.n += 1
  model.lastAt = sample.at
  saveModel(model)
}

/** 特征构造（匹配器接线用）：把候选的客观信号转成特征向量。 */
export function extractEvolutionFeatures(input: {
  staticScore: number
  videoDuration: number
  songDuration: number
  play: number
  uploaderTrustScore: number
  type: string
  isExtension: boolean
  queryRank: number
  hasArtist: boolean
  officialVerifyType: number
}): number[] {
  const durRatio = input.songDuration > 0
    ? Math.min(2, input.videoDuration / input.songDuration)
    : 1
  return [
    Math.max(0, Math.min(5, input.staticScore / 100)),
    durRatio,
    Math.min(1, Math.log10(Math.max(1, input.play)) / 7),
    Math.max(0, Math.min(1, input.uploaderTrustScore / 20)),
    input.type === 'official' ? 1 : 0,
    input.type === 'live' ? 1 : 0,
    input.type === 'cover' ? 1 : 0,
    input.type === 'instrumental' ? 1 : 0,
    input.isExtension ? 1 : 0,
    1 / (1 + Math.max(0, input.queryRank)),
    input.hasArtist ? 1 : 0,
    input.officialVerifyType >= 0 ? 1 : 0,
  ]
}

/** 学习进度（诊断/设置页展示用）。 */
export function getEvolutionStats(): { events: number; pool: number; weights: Array<{ name: string; w: number }> } {
  const model = loadModel()
  return {
    events: model.n,
    pool: model.pool.length,
    weights: EVOLUTION_FEATURES.map((name, i) => ({ name, w: Number(model.w[i].toFixed(3)) })),
  }
}

/** 重置进化引擎（设置页「清除学习数据」用）。 */
export function resetEvolutionModel(): void {
  try {
    localStorage.removeItem(EVOLUTION_STORE_KEY)
  } catch {
    /* 忽略 */
  }
}
