/**
 * DG_LAB 波形导入解析器（渲染端）。
 *
 * 支持两种来源：
 * - 整合波形 .txt：DG-Lab App「波形编辑器」导出的 JSON 数组（一个文件含多个波形，
 *   每个对象：points1/points2/points3 控制点曲线（{anchor,x,y}，y∈0-20）+ 参数组 + waveName/waveNameEn）。
 *   参数组原样保留，支持「导出回导 App」。
 * - 单波形 .pulse：多格式容错——① 每行 8 字节 hex 帧（4×频率+4×强度，如
 *   0A0A0A0A00000000）；② A:/B: 前缀的 16 位帧列表；③ JSON {frames:[...]}。
 *
 * 解析结果统一归一为 WaveDef。解析假设在控制台「调试日志」中可复核。
 */

import type { WaveDef, WaveFrame, WavePoint } from '../types'
import { addWaves } from '../../services/pluginStore'

/* ------------------------------ 通用工具 ------------------------------ */

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

function shortId(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return hash.toString(36).slice(0, 6)
}

function parsePoints(json: string | unknown): WavePoint[] | undefined {
  if (typeof json !== 'string') return undefined
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return undefined
    return parsed
      .filter((p): p is WavePoint => p && typeof p.x === 'number' && typeof p.y === 'number')
      .map(p => ({ x: p.x, y: p.y, anchor: typeof p.anchor === 'number' ? p.anchor : 1 }))
  } catch {
    return undefined
  }
}

/* ------------------------------ 整合波形 txt 解析 ------------------------------ */

/**
 * 字符串感知的 JSON 对象扫描器：逐字符扫描花括号深度，字符串字面量内的
 * `{`/`}`/`[`/`]` 不计入深度（DG-Lab 导出把 points 曲线序列化成字符串，
 * 内含大量花括号）；无法闭合的残缺尾部直接跳过（文件可能被截断）。
 */
function extractJsonObjects(text: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = []
  let i = 0
  const n = text.length
  while (i < n) {
    const start = text.indexOf('{', i)
    if (start === -1) break
    let depth = 0
    let inString = false
    let escaped = false
    let closed = -1
    for (let j = start; j < n; j += 1) {
      const ch = text[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          closed = j
          break
        }
      }
    }
    if (closed === -1) break // 残缺尾部
    const raw = text.slice(start, closed + 1)
    // JSON 不允许字符串内的原始控制字符（部分导出文件含换行），净化后解析
    const sanitized = raw.replace(/[\u0000-\u001F\u007F]/g, m => (m === '\n' || m === '\r' || m === '\t' ? ' ' : ''))
    try {
      const obj = JSON.parse(sanitized)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) objects.push(obj)
    } catch {
      /* 单个对象失败则跳过 */
    }
    i = closed + 1
  }
  return objects
}

export function parseCombinedTxt(text: string, fileName = '整合波形'): { waves: WaveDef[]; errors: string[] } {
  const errors: string[] = []
  const waves: WaveDef[] = []

  // 1) 整段 JSON 数组
  let objects: Array<Record<string, unknown>> = []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.every(o => o && typeof o === 'object' && !Array.isArray(o))) {
      objects = parsed as Array<Record<string, unknown>>
    } else {
      errors.push('文件不是波形数组（JSON 数组）')
      return { waves, errors }
    }
  } catch {
    // 2) 容错：整段失败时用字符串感知扫描器逐个提取对象（处理尾逗号/控制符/截断）
    objects = extractJsonObjects(text)
    if (objects.length === 0) {
      errors.push('无法解析文件：不是有效的波形 JSON')
      return { waves, errors }
    }
  }

  const seen = new Set<string>()
  for (const [index, object] of objects.entries()) {
    const name = String(object.waveName ?? object.name ?? `波形${index + 1}`)
    const nameEn = object.waveNameEn ? String(object.waveNameEn) : undefined
    if (seen.has(name)) continue
    seen.add(name)
    const points = {
      p1: parsePoints(object.points1),
      p2: parsePoints(object.points2),
      p3: parsePoints(object.points3),
    }
    const params: Record<string, number | string> = {}
    for (const [key, value] of Object.entries(object)) {
      if (key === 'points1' || key === 'points2' || key === 'points3') continue
      if (typeof value === 'number' || typeof value === 'string') params[key] = value
    }
    waves.push({
      id: `combined-${shortId(name + index)}`,
      name,
      nameEn,
      source: 'combined',
      params,
      points: points.p1 || points.p2 || points.p3 ? points : undefined,
      importedAt: Date.now(),
    })
  }
  if (waves.length === 0) errors.push('文件内没有可用波形')
  return { waves, errors }
}

/* ------------------------------ 单独波形 pulse 解析 ------------------------------ */

const HEX_RE = /^[0-9a-fA-F]+$/

/**
 * 官方 DG-Lab pulse 脚本解析：
 *   Dungeonlab+pulse:<meta>/<曲线1>+section+<曲线2>（/ 前为参数，曲线为 x-y 对，x:0-100%、y:0..1）
 *   Dungeonlab+csv:<A曲线>/<A曲线2>+section+<B曲线>/<B曲线2>
 * 把全部 x-y 包络点按 x 重采样成约 9 帧（每帧 100ms）。频率取 20Hz（可在控制台覆盖）。
 */
function parseOfficialPulseScript(text: string): WaveFrame[] | null {
  const m = /^Dungeonlab\+([a-z]+):(.*)$/i.exec(text.trim())
  if (!m) return null
  const body = m[2]
  const pts: { x: number; y: number }[] = []
  // 提取所有 "x-y" 对（兼容小数 x）
  const re = /(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    pts.push({ x: Number(match[1]), y: Number(match[2]) })
  }
  if (pts.length === 0) return null
  pts.sort((a, b) => a.x - b.x)
  const frames: WaveFrame[] = []
  for (let i = 0; i < 9; i += 1) {
    const t = (i / 8) * 100 // 0..100%
    // 折线插值
    let y = pts[pts.length - 1].y
    for (let k = 0; k < pts.length - 1; k += 1) {
      const a = pts[k]
      const b = pts[k + 1]
      if (t >= a.x && t <= b.x) {
        const ratio = b.x === a.x ? 0 : (t - a.x) / (b.x - a.x)
        y = a.y + (b.y - a.y) * ratio
        break
      }
      if (k === pts.length - 2 && t > b.x) y = b.y
    }
    frames.push({ freq: 20, strength: clamp(Math.round(clampPulseY(y) * 200), 0, 200) })
  }
  return frames
}

function clampPulseY(v: number) {
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
}

/** 8 字节 hex 帧 → WaveFrame（频率=第 1 字节，强度=第 5 字节，帧内重复 4 次）。 */
function parseByte8Frame(hex: string): WaveFrame | null {
  if (!HEX_RE.test(hex) || hex.length !== 16) return null
  const freq = parseInt(hex.slice(0, 2), 16)
  const strength = parseInt(hex.slice(8, 10), 16)
  return { freq: clamp(freq, 0, 255), strength: clamp(strength, 0, 200) }
}

/** 16 位帧 → WaveFrame（假设 V2 布局：高位=强度、低位=频率，best-effort）。 */
function parseInt16Frame(value: number): WaveFrame | null {
  if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null
  const freq = value & 0xff
  const strength = (value >> 8) & 0xff
  return { freq: clamp(freq, 0, 255), strength: clamp(strength, 0, 200) }
}

export function parsePulseFile(text: string, fileName = '单波形'): { waves: WaveDef[]; errors: string[] } {
  const errors: string[] = []
  const frames: WaveFrame[] = []
  const baseName = fileName.replace(/\.pulse$/i, '').replace(/\.txt$/i, '') || '单波形'

  // 0) 官方 DG-Lab「Dungeonlab+pulse:/+csv:」脚本：把包络曲线（x:0-100%、y:0..1）重采样为 8 字节帧（约 9 帧 ≈ 0.9s）
  const official = parseOfficialPulseScript(text)
  if (official) {
    return {
      waves: [{ id: `pulse-${shortId(baseName + frames.length)}`, name: baseName, source: 'pulse', frames: official, importedAt: Date.now() }],
      errors,
    }
  }

  const pushFrame = (frame: WaveFrame | null) => {
    if (frame) frames.push(frame)
  }

  // 尝试 JSON {frames:[...]} / {frames:[[f,s],...]}
  try {
    const trimmed = text.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed)
      const list = Array.isArray(parsed) ? parsed : parsed?.frames
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'number') pushFrame(parseInt16Frame(item))
          else if (typeof item === 'string') pushFrame(parseByte8Frame(item.replace(/0x/gi, '')) ?? parseInt16Frame(parseInt(item, 16)))
          else if (Array.isArray(item) && item.length >= 2) pushFrame({ freq: Number(item[0]), strength: Number(item[1]) })
        }
        if (frames.length) return { waves: [waveFromFrames(frames, baseName)], errors }
      }
    }
  } catch {
    /* 非 JSON，走文本行解析 */
  }

  // 文本行解析：按行/逗号/空白切分 token
  const tokens = text
    .split(/[\s,;:]+/)
    .map(t => t.trim())
    .filter(Boolean)
  for (const token of tokens) {
    const upper = token.toUpperCase()
    if (upper === 'A' || upper === 'B' || upper === 'PULSE' || upper === 'FRAME') continue
    const clean = token.replace(/^0X/i, '')
    if (/^[0-9A-F]{4}$/.test(clean)) pushFrame(parseInt16Frame(parseInt(clean, 16)))
    else if (/^[0-9A-F]{16}$/.test(clean)) pushFrame(parseByte8Frame(clean))
  }

  if (frames.length === 0) {
    errors.push('未识别到波形帧（支持 8 字节 hex / 4 位 hex 帧 / JSON 数组）')
    return { waves: [], errors }
  }
  return { waves: [waveFromFrames(frames, baseName)], errors }
}

function waveFromFrames(frames: WaveFrame[], name: string): WaveDef {
  return {
    id: `pulse-${shortId(name + frames.length)}`,
    name,
    source: 'pulse',
    frames,
    importedAt: Date.now(),
  }
}

/* ------------------------------ 设计器波形 → 设备帧（曲线重采样） ------------------------------ */

/**
 * 把「整合波形」设计器曲线（points1 强度曲线，y∈0-20）重采样为设备帧。
 * 假设：曲线 x 每单位 ≈ 100ms（与官方帧时间片一致）；y = 强度百分比（0-20 → 0-200）。
 * 频率取用户设置（默认 20Hz）。这是 best-effort 映射，手感确认后可精修。
 */
export function resampleDesignerWave(wave: WaveDef, freq = 20): WaveFrame[] {
  const points = wave.points?.p1
  if (!points || points.length < 2) return []
  const sorted = [...points].sort((a, b) => a.x - b.x)
  const maxX = Math.max(1, sorted[sorted.length - 1].x)
  const step = 100 / 1000 // 每单位 100ms
  const frames: WaveFrame[] = []
  for (let t = 0; t <= maxX; t += step) {
    // 折线段插值
    let y = sorted[0].y
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const a = sorted[i]
      const b = sorted[i + 1]
      if (t >= a.x && t <= b.x) {
        const ratio = b.x === a.x ? 0 : (t - a.x) / (b.x - a.x)
        y = a.y + (b.y - a.y) * ratio
        break
      }
      if (i === sorted.length - 2 && t > b.x) y = b.y
    }
    frames.push({ freq: clamp(Math.round(freq), 0, 255), strength: clamp(Math.round((y / 20) * 200), 0, 200) })
  }
  return frames
}

/* ------------------------------ 入库入口 ------------------------------ */

export function importWaves(waves: WaveDef[]): number {
  return addWaves(waves)
}