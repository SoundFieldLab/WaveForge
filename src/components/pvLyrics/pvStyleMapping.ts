/**
 * PV 模板推荐 —— 用 WaveForge 现有分析信号（节拍/能量/段落/封面取色）+ MV 背景态，
 * 启发式评分 30 个模板，输出 top3 推荐索引。用户可手动覆盖/锁定。
 *
 * 注：分析流水线无曲风(genre)标签，这里把「音乐风格检测」落地为分析信号 → 模板映射：
 * 高 BPM/高能量 → 动感/裂屏系；冷色低饱和 → 赛博系；暖色甜美 → 少女系；视频背景 → HUD/影院系。
 */
import { templates } from '../../vendor/pv/templates'

export interface StyleSignals {
  /** 估计 BPM（TrackAnalysis.estimatedBpm） */
  bpm?: number
  /** 平均逐拍能量（beatFeatures.energy 均值 0~1） */
  avgEnergy?: number
  /** 主导段落类型（sections 中最常见 type） */
  dominantSection?: string
  /** 封面主色（#hex；dominantColor 或 useColorThief 提取） */
  dominantColor?: string
  /** MV 视频背景激活 */
  hasVideo?: boolean
  /** 歌词含日文（假名/汉字比例） */
  isJapanese?: boolean
}

/** 模板索引 → 建议上浮分数（0 不动，负分降权） */
const RULES: { test: (s: StyleSignals) => boolean; sway: Partial<Record<number, number>> }[] = [
  // 视频背景适配模板（pv-tool 原注释「建议配合视频使用」）
  {
    test: s => !!s.hasVideo,
    sway: { 6: 3, 7: 2.5, 2: 2, 23: 1.5, 21: 1, 22: 0.5 },
  },
  // 高速/高能 → 动感系
  {
    test: s => (s.bpm ?? 120) >= 132 || (s.avgEnergy ?? 0.5) >= 0.62,
    sway: { 24: 2.5, 1: 2, 18: 1.8, 22: 1.2, 8: 1.2, 25: 0.6 },
  },
  // 中速 / 城市感 → 城市与几何（仅显式提供 BPM 时启用，空信号不误命中）
  {
    test: s => s.bpm !== undefined && s.bpm >= 110 && s.bpm < 132,
    sway: { 5: 1.5, 4: 1.2, 29: 1, 21: 0.8 },
  },
  // 副歌主导 → 大标题/冲击类
  {
    test: s => s.dominantSection === 'chorus' || s.dominantSection === 'drop',
    sway: { 0: 1.2, 7: 1, 8: 0.8, 24: 0.8 },
  },
  // 冷色封面（低饱和/蓝青紫）→ 赛博/夜系
  {
    test: s => (s.dominantColor ? isCoolAndMuted(s.dominantColor) : false),
    sway: { 3: 1.8, 20: 1.5, 29: 1.2, 19: 1, 6: 0.8 },
  },
  // 暖色甜美（粉/橙/红浅亮）→ 少女/糖果系
  {
    test: s => (s.dominantColor ? isWarmSweet(s.dominantColor) : false),
    sway: { 12: 2, 13: 1.8, 15: 1.5, 26: 1, 14: 0.8 },
  },
  // 极浅亮色 → 高对比平面系
  {
    test: s => (s.dominantColor ? isVeryLight(s.dominantColor) : false),
    sway: { 25: 1.8, 26: 1.5, 13: 1, 4: 0.5 },
  },
  // 日语歌词 → 日系文艺模板
  {
    test: s => !!s.isJapanese,
    sway: { 17: 2.5, 19: 1.8, 29: 1.5, 14: 1.2, 11: 1, 10: 0.8 },
  },
]

const BASE: number[] = templates.map((_, i) => (i === 0 ? 1 : 0))

/** 返回推荐模板索引（top3，不含负分项） */
export function recommendTemplates(signals: StyleSignals): number[] {
  const score = [...BASE]
  for (const rule of RULES) {
    if (!rule.test(signals)) continue
    for (const [idx, delta] of Object.entries(rule.sway)) {
      score[Number(idx)] += delta ?? 0
    }
  }
  const ranked = score
    .map((v, i) => ({ i, v }))
    .filter(e => e.v > 0.5)
    .sort((a, b) => b.v - a.v)
  return ranked.slice(0, 3).map(e => e.i)
}

/** 冷色且低饱和（蓝/青/紫，暗调） */
function isCoolAndMuted(hex: string): boolean {
  const { h, s, l } = hexToHsl(hex)
  return (h >= 200 && h <= 300 || h >= 150 && h <= 260) && s < 0.75 && l < 0.7
}

/** 暖色甜美（粉/橙/红，中高亮度、中饱和） */
function isWarmSweet(hex: string): boolean {
  const { h, s, l } = hexToHsl(hex)
  return (h < 45 || h >= 320) && s > 0.35 && l > 0.5
}

/** 极浅亮色 */
function isVeryLight(hex: string): boolean {
  const { l } = hexToHsl(hex)
  return l > 0.82
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let normalized = hex.trim()
  if (!normalized.startsWith('#')) normalized = `#${normalized}`
  let r = 0, g = 0, b = 0
  if (normalized.length === 4) {
    r = parseInt(normalized[1] + normalized[1], 16)
    g = parseInt(normalized[2] + normalized[2], 16)
    b = parseInt(normalized[3] + normalized[3], 16)
  } else if (normalized.length === 7) {
    r = parseInt(normalized.slice(1, 3), 16)
    g = parseInt(normalized.slice(3, 5), 16)
    b = parseInt(normalized.slice(5, 7), 16)
  }
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4
    }
    h *= 60
  }
  return { h, s, l }
}