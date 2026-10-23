import { createDefaultSpatialSettings, type SpatialSettings } from '../types'
import type { AudioObject, ListenerState, TrajectoryKeyframes, VirtualSpeakerCfg } from './types'

type Vec3 = { x: number; y: number; z: number }
type SpatialRoute = 'l' | 'r' | 'both' | 'side'

const MAX_ITEMS = 32
const MAX_KEYFRAMES = 256
// 限制恶意巨大数组的扫描量，同时允许前面的无效项不占用有效项名额。
const MAX_SCAN = 1024
const MAX_KEYFRAME_SCAN = 4096
const MAX_ID_LENGTH = 128
const MAX_PLAYHEAD = 86400

function record(value: unknown): Record<string, unknown> | undefined {
  try {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

// 只读自身数据属性：忽略原型属性、__proto__ 和可能执行代码的 accessor。
function field(value: unknown, key: string): unknown {
  const object = record(value)
  if (!object) return undefined
  try {
    const property = Object.getOwnPropertyDescriptor(object, key)
    return property && 'value' in property ? property.value : undefined
  } catch {
    return undefined
  }
}

function array(value: unknown): unknown[] | undefined {
  try {
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

function item(values: unknown[], index: number): unknown {
  try {
    const property = Object.getOwnPropertyDescriptor(values, String(index))
    return property && 'value' in property ? property.value : undefined
  } catch {
    return undefined
  }
}

function finite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function angle(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return ((((value + 180) % 360) + 360) % 360) - 180
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 声道标签数组：只接受 1..MAX_ITEMS 个非空短字符串；非法数据整体丢弃（回落 mask/自动布局）。 */
function labelList(value: unknown): string[] | undefined {
  const values = array(value)
  if (!values || values.length === 0 || values.length > MAX_ITEMS) return undefined
  const labels: string[] = []
  for (let i = 0; i < values.length; i++) {
    const raw = item(values, i)
    if (typeof raw !== 'string') return undefined
    const label = raw.trim()
    if (!label || label.length > 64) return undefined
    labels.push(label)
  }
  return labels
}

function id(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const result = value.slice(0, MAX_ID_LENGTH).trim()
  return result.length ? result : undefined
}

function position(value: unknown, fallback: Vec3): Vec3 {
  if (!record(value)) return { ...fallback }
  return {
    x: finite(field(value, 'x'), fallback.x, -1000, 1000),
    y: finite(field(value, 'y'), fallback.y, -1000, 1000),
    z: finite(field(value, 'z'), fallback.z, -1000, 1000),
  }
}

function route(value: unknown): SpatialRoute | undefined {
  return value === 'l' || value === 'r' || value === 'both' || value === 'side' ? value : undefined
}

function speaker(value: unknown, fallback: VirtualSpeakerCfg): VirtualSpeakerCfg | undefined {
  if (!record(value)) return undefined
  const result: VirtualSpeakerCfg = {
    azimuthDeg: angle(field(value, 'azimuthDeg'), fallback.azimuthDeg),
    elevationDeg: finite(field(value, 'elevationDeg'), fallback.elevationDeg, -90, 90),
    distance: finite(field(value, 'distance'), fallback.distance, 0, 200),
    gain: finite(field(value, 'gain'), fallback.gain, 0, 2),
    size: finite(field(value, 'size'), fallback.size, 0, 1),
    diffuse: finite(field(value, 'diffuse'), fallback.diffuse ?? 0, 0, 1),
    polarity: finite(field(value, 'polarity'), fallback.polarity ?? 1, -1, 1),
  }
  const muted = field(value, 'muted')
  if (typeof muted === 'boolean') result.muted = muted
  const speakerRoute = route(field(value, 'route'))
  if (speakerRoute) result.route = speakerRoute
  return result
}

function source(value: unknown, fallback: AudioObject): AudioObject | undefined {
  const sourceId = id(field(value, 'id'))
  if (!sourceId || !record(field(value, 'position'))) return undefined
  const result: AudioObject = {
    id: sourceId,
    position: position(field(value, 'position'), fallback.position),
    gain: finite(field(value, 'gain'), fallback.gain, 0, 2),
    size: finite(field(value, 'size'), fallback.size, 0, 1),
    diffuse: finite(field(value, 'diffuse'), fallback.diffuse ?? 0, 0, 1),
    polarity: finite(field(value, 'polarity'), fallback.polarity ?? 1, -1, 1),
  }
  const sourceRoute = route(field(value, 'route'))
  if (sourceRoute) result.route = sourceRoute
  return result
}

function sources(value: unknown, fallback: AudioObject[]): AudioObject[] {
  const input = array(value)
  if (!input) return []
  const result: AudioObject[] = []
  const seen = new Set<string>()
  for (let i = 0, limit = Math.min(input.length, MAX_SCAN); i < limit && result.length < MAX_ITEMS; i++) {
    const candidate = source(item(input, i), fallback[0])
    if (!candidate || seen.has(candidate.id)) continue
    result.push(candidate)
    seen.add(candidate.id)
  }
  return result
}

function speakers(value: unknown, fallback: VirtualSpeakerCfg[]): VirtualSpeakerCfg[] {
  const input = array(value)
  if (!input) return fallback
  const result: VirtualSpeakerCfg[] = []
  for (let i = 0, limit = Math.min(input.length, MAX_SCAN); i < limit && result.length < MAX_ITEMS; i++) {
    const candidate = speaker(item(input, i), fallback[0])
    if (candidate) result.push(candidate)
  }
  return result
}

function trajectories(value: unknown, sourceIds: Set<string>): TrajectoryKeyframes[] {
  const input = array(value)
  if (!input) return []
  const result: TrajectoryKeyframes[] = []
  const seen = new Map<string, number>()
  for (let i = 0, limit = Math.min(input.length, MAX_SCAN); i < limit; i++) {
    const candidate = item(input, i)
    const sourceId = id(field(candidate, 'sourceId'))
    const frames = array(field(candidate, 'keyframes'))
    if (!sourceId || !sourceIds.has(sourceId) || !frames) continue
    const byTime = new Map<number, TrajectoryKeyframes['keyframes'][number]>()
    for (let j = 0, frameLimit = Math.min(frames.length, MAX_KEYFRAME_SCAN); j < frameLimit; j++) {
      const frame = item(frames, j)
      const time = field(frame, 't')
      const xyz = field(frame, 'position')
      const x = field(xyz, 'x')
      const y = field(xyz, 'y')
      const z = field(xyz, 'z')
      if (typeof time !== 'number' || !Number.isFinite(time) ||
          typeof x !== 'number' || !Number.isFinite(x) ||
          typeof y !== 'number' || !Number.isFinite(y) ||
          typeof z !== 'number' || !Number.isFinite(z)) continue
      const t = finite(time, 0, 0, MAX_PLAYHEAD)
      if (byTime.size < MAX_KEYFRAMES || byTime.has(t)) {
        byTime.set(t, { t, position: { x: finite(x, 0, -1000, 1000), y: finite(y, 0, -1000, 1000), z: finite(z, 0, -1000, 1000) } })
      }
    }
    if (!byTime.size) continue
    const normalized = { sourceId, keyframes: [...byTime.values()].sort((a, b) => a.t - b.t) }
    const previous = seen.get(sourceId)
    if (previous !== undefined) result[previous] = normalized
    else if (result.length < MAX_ITEMS) {
      seen.set(sourceId, result.length)
      result.push(normalized)
    }
  }
  return result
}

/** 从持久化/分享数据重建完整的有限空间参数快照，未知字段不进入 DSP。 */
export function normalizeSpatialSettings(raw: unknown): SpatialSettings {
  const defaults = createDefaultSpatialSettings()
  const input = record(raw)
  if (!input) return defaults

  const instant = field(input, 'instant')
  const headLocked = field(input, 'headLocked')
  const world = field(input, 'world')
  const listener = field(world, 'listener')
  const stage = field(input, 'stage')
  const ambience = field(input, 'ambience')
  const cancellation = field(input, 'speakerCancellation')
  const transform = field(input, 'ambisonicTransform')
  const orderGains = array(field(transform, 'orderGains'))
  const refDistance = finite(field(input, 'refDistance'), defaults.refDistance, 0.1, 100)
  const worldSources = field(world, 'sources') === undefined
    ? defaults.world.sources
    : sources(field(world, 'sources'), defaults.world.sources)
  const stageSources = field(stage, 'customSources') === undefined
    ? defaults.stage.customSources
    : sources(field(stage, 'customSources'), defaults.world.sources)
  const customSpeakers = speakers(field(headLocked, 'speakers'), defaults.headLocked.speakers)
  const rawRoutes = array(field(headLocked, 'routes'))
  const headRoutes = rawRoutes
    ? Array.from({ length: Math.min(rawRoutes.length, MAX_ITEMS) }, (_, i) => {
      const value = item(rawRoutes, i)
      if (value === 'l' || value === 'r' || value === 'both') return value
      return (customSpeakers[i]?.azimuthDeg ?? 0) <= 0 ? 'l' : 'r'
    })
    : defaults.headLocked.routes

  const worldListener: ListenerState = {
    position: position(field(listener, 'position'), defaults.world.listener.position),
    yaw: angle(field(listener, 'yaw'), defaults.world.listener.yaw),
    pitch: finite(field(listener, 'pitch'), defaults.world.listener.pitch, -90, 90),
    roll: angle(field(listener, 'roll'), defaults.world.listener.roll),
  }
  const sourceChannelLabels = labelList(field(input, 'sourceChannelLabels'))
  const targetChannelLabels = labelList(field(input, 'targetChannelLabels'))
  return {
    budgetMode: choice(field(input, 'budgetMode'), ['quality', 'auto', 'lowLatency'] as const, 'quality'),
    renderStyle: choice(field(input, 'renderStyle'), ['natural', 'focused'] as const, 'natural'),
    inputFormat: choice(field(input, 'inputFormat'), ['channels', 'ambix', 'ambix1', 'ambix2', 'ambix3', 'fuma', 'stereo51', 'stereo71'] as const, 'channels'),
    ...(sourceChannelLabels ? { sourceChannelLabels } : {}),
    ...(targetChannelLabels ? { targetChannelLabels } : {}),
    ambisonicTransform: { yawDeg: angle(field(transform, 'yawDeg'), 0), pitchDeg: angle(field(transform, 'pitchDeg'), 0),
      rollDeg: angle(field(transform, 'rollDeg'), 0), orderGains: Array.from({ length: 4 }, (_, i) => finite(orderGains ? item(orderGains, i) : undefined, 1, -4, 4)) },
    speakerCancellation: { enabled: boolean(field(cancellation, 'enabled'), false),
      amount: finite(field(cancellation, 'amount'), 0.4, 0, 1), delayMs: finite(field(cancellation, 'delayMs'), 0.25, 0.02, 1.5),
      cutoffHz: finite(field(cancellation, 'cutoffHz'), 1800, 200, 5000) },
    earlyAmount: finite(field(input, 'earlyAmount'), 1, 0, 1),
    lateAmount: finite(field(input, 'lateAmount'), 1, 0, 1),
    decorrelation: finite(field(input, 'decorrelation'), 0, 0, 1),
    // 只有有限数值才固化该字段：null/NaN 视为「未指定」，继续由 budgetMode 推导，
    // 避免分享串 round-trip 把 lowLatency 的 0 阶覆盖成 2 阶。
    ...(Number.isFinite(field(input, 'earlyReflectionOrders'))
      ? { earlyReflectionOrders: finite(field(input, 'earlyReflectionOrders'), 2, 0, 3) }
      : {}),
    earlyReflectionModel: choice(field(input, 'earlyReflectionModel'), ['cues', 'spectral'] as const, 'cues'),
    mode: choice(field(input, 'mode'), ['off', 'instant', 'headLocked', 'world', 'stage'], defaults.mode),
    masterGain: finite(field(input, 'masterGain'), defaults.masterGain, 0.5, 1),
    instant: {
      spreadDeg: finite(field(instant, 'spreadDeg'), defaults.instant.spreadDeg, 20, 120),
      amount: finite(field(instant, 'amount'), defaults.instant.amount, 0, 1),
      room: choice(field(instant, 'room'), ['off', 'studio', 'hall', 'stage', 'church', 'outdoor', 'bathroom', 'corridor'], defaults.instant.room),
      roomAmount: finite(field(instant, 'roomAmount'), defaults.instant.roomAmount, 0, 1),
      multichannelAuto: boolean(field(instant, 'multichannelAuto'), defaults.instant.multichannelAuto),
      multichannelLayout: choice(field(instant, 'multichannelLayout'), ['auto', 'quad', '51', '71', '714'], defaults.instant.multichannelLayout),
    },
    headLocked: {
      layout: choice(field(headLocked, 'layout'), ['stereo', '51', '514', '71', '714', 'custom'], defaults.headLocked.layout),
      speakers: customSpeakers,
      heightLayer: boolean(field(headLocked, 'heightLayer'), defaults.headLocked.heightLayer),
      bottomLayer: boolean(field(headLocked, 'bottomLayer'), defaults.headLocked.bottomLayer),
      routes: headRoutes,
    },
    world: {
      propagation: boolean(field(world, 'propagation'), false),
      moveSpeed: finite(field(world, 'moveSpeed'), defaults.world.moveSpeed, 0.5, 5),
      listener: worldListener,
      sources: worldSources,
      playhead: finite(field(world, 'playhead'), defaults.world.playhead, 0, MAX_PLAYHEAD),
      trajectories: trajectories(field(world, 'trajectories'), new Set(worldSources.map((s) => s.id))),
      occlusion: finite(field(world, 'occlusion'), defaults.world.occlusion, 0, 1),
    },
    stage: {
      preset: choice(field(stage, 'preset'), ['stage', 'cinema', 'piano', 'nature'], defaults.stage.preset),
      seat: choice(field(stage, 'seat'), ['front', 'middle', 'back'], defaults.stage.seat),
      roomSize: finite(field(stage, 'roomSize'), defaults.stage.roomSize, 0.5, 2),
      reverbAmount: finite(field(stage, 'reverbAmount'), defaults.stage.reverbAmount, 0, 1),
      customSources: stageSources,
    },
    ambience: {
      extraction: choice(field(ambience, 'extraction'), ['pca', 'difference'] as const, 'pca'),
      enabled: boolean(field(ambience, 'enabled'), defaults.ambience.enabled),
      amount: finite(field(ambience, 'amount'), defaults.ambience.amount, 0, 1),
    },
    convolution: choice(field(input, 'convolution'), ['partitioned', 'time'], defaults.convolution),
    hrtfInterp: choice(field(input, 'hrtfInterp'), ['nearest', 'spherical'], defaults.hrtfInterp),
    distanceModel: choice(field(input, 'distanceModel'), ['inverse', 'linear', 'exponential'], defaults.distanceModel),
    refDistance,
    maxDistance: Math.max(refDistance + 0.1, finite(field(input, 'maxDistance'), defaults.maxDistance, 0.1, 200)),
  }
}
