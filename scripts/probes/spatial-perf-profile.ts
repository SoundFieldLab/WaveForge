/** Node 离线诊断：真实处理器和 DSP，消息端口模拟；不作为设备硬实时验收。 */
import { Session } from 'node:inspector'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { EngineV3 } from '../../src/services/waveforge-engine-v3/src/engine/EngineV3'
import { AudioEffectsProcessor } from '../../src/services/waveforge-engine-v3/src/worklet/AudioEffectsProcessor'
import { createDefaultParams } from '../../src/services/waveforge-engine-v3/src/types'

type Scene = 'hoa3' | 'spectral' | 'same-tick'
interface Options { rate: number; scene: Scene; blocks: number; warmup: number; updates: number; profile: boolean }
interface BlockTiming { callbackMs: number; configurationMs: number; dspMs: number }
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  return { count: sorted.length, sum: values.reduce((a, b) => a + b, 0),
    mean: values.reduce((a, b) => a + b, 0) / Math.max(1, values.length),
    min: sorted[0] ?? 0, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted[sorted.length - 1] ?? 0 }
}
function aggregateProfile(profile: any) {
  const nodes = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]))
  const parent = new Map<number, number>()
  for (const n of profile.nodes) for (const child of n.children ?? []) parent.set(child, n.id)
  const rows = new Map<string, any>()
  function row(id: number) {
    const n = nodes.get(id), f = n.callFrame
    const key = `${f.functionName}|${f.url}|${f.lineNumber}|${f.columnNumber}`
    if (!rows.has(key)) rows.set(key, { functionName: f.functionName || '(anonymous)', url: f.url,
      line: f.lineNumber + 1, column: f.columnNumber + 1, selfMs: 0, totalMs: 0, samples: 0 })
    return rows.get(key)
  }
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const id = profile.samples[i], ms = (profile.timeDeltas?.[i] ?? 0) / 1000
    const own = row(id); own.selfMs += ms; own.samples++
    const seen = new Set<any>()
    for (let ancestor: number | undefined = id; ancestor !== undefined; ancestor = parent.get(ancestor)) {
      const r = row(ancestor)
      if (!seen.has(r)) { r.totalMs += ms; seen.add(r) }
    }
  }
  const all = [...rows.values()]
  return { samplingIntervalUs: 100, samples: profile.samples?.length ?? 0,
    observedMs: (profile.endTime - profile.startTime) / 1000,
    bySelf: [...all].sort((a, b) => b.selfMs - a.selfMs).slice(0, 60),
    byTotal: [...all].sort((a, b) => b.totalMs - a.totalMs).slice(0, 60) }
}

export async function run(options: Options, implementation?: {
  EngineV3: typeof EngineV3; AudioEffectsProcessor: typeof AudioEffectsProcessor; createDefaultParams: typeof createDefaultParams
}) {
  const EngineClass = implementation?.EngineV3 ?? EngineV3
  const ProcessorClass = implementation?.AudioEffectsProcessor ?? AudioEffectsProcessor
  const session = options.profile ? new Session() : undefined
  const post = (method: string, args = {}): Promise<any> => new Promise((resolve, reject) =>
    session!.post(method as any, args, (error, value) => error ? reject(error) : resolve(value)))
  if (session) { session.connect(); await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 100 }) }
  const profiles: Record<string, any> = {}, profileSummary: Record<string, any> = {}
  async function phase<T>(name: string, body: () => T): Promise<{ elapsedMs: number; value: T }> {
    if (session) await post('Profiler.start')
    const start = performance.now()
    const value = body()
    const elapsedMs = performance.now() - start
    if (session) {
      const { profile } = await post('Profiler.stop')
      profiles[name] = profile; profileSummary[name] = aggregateProfile(profile)
    }
    return { elapsedMs, value }
  }
  const rate = options.rate, channels = options.scene === 'hoa3' ? 16 : 2
  const p = (implementation?.createDefaultParams ?? createDefaultParams)(rate)
  for (const value of Object.values(p)) if (value && typeof value === 'object' && 'enabled' in value) value.enabled = false
  p.subsonicEnabled = false; p.spatial.mode = 'instant'; p.spatial.instant.amount = 1
  p.spatial.instant.multichannelAuto = true; p.spatial.renderStyle = 'focused'; p.spatial.hrtfInterp = 'spherical'
  p.spatial.inputFormat = options.scene === 'hoa3' ? 'ambix3' : 'channels'
  p.spatial.instant.room = options.scene === 'hoa3' ? 'off' : 'studio'
  p.spatial.instant.roomAmount = .45; p.spatial.earlyReflectionModel = 'spectral'; p.spatial.lateAmount = 0
  let control!: EngineV3, processor!: AudioEffectsProcessor
  const cold = await phase('cold-construction', () => {
    const begin = performance.now(); control = new EngineClass(rate, 2)
    const controlMs = performance.now() - begin
    const second = performance.now(); processor = new ProcessorClass()
    return { controlMs, renderMs: performance.now() - second }
  })
  const render = (processor as any).engine as EngineV3
  let current: BlockTiming = { callbackMs: 0, configurationMs: 0, dspMs: 0 }
  // 仅在实例边界计时。叶子 DSP 不包裹，避免改变卷积内循环。
  for (const name of ['setParams', 'setSpatialHeadPose', 'setSpatialHrtf', 'setSpatialInputChannelCount', 'process'] as const) {
    const original = (render as any)[name]
    ;(render as any)[name] = function (...args: any[]) {
      const start = performance.now()
      try { return original.apply(this, args) }
      finally { current[name === 'process' ? 'dspMs' : 'configurationMs'] += performance.now() - start }
    }
  }
  const input = Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: 128 }, (_, i) =>
    Math.sin(2 * Math.PI * (311 + channel * 139) * i / rate) * .025))
  const output = [new Float32Array(128), new Float32Array(128)]
  const inputs = [input], outputs = [output], automation = {}
  let badPcm = 0, peak = 0, checksum = 0, nonzeroSamples = 0, updateIndex = 0
  const pcmHash = createHash('sha256')
  const preparationMs: number[] = [], deliveryMs: number[] = [], preparedEvidence: any[] = []
  const messages = (processor as any).port
  function deliver(message: any) {
    const start = performance.now()
    // structuredClone 模拟消息独占数据，但不伪造浏览器调度或真实线程传输计时。
    messages.onmessage({ data: structuredClone(message) })
    deliveryMs.push(performance.now() - start)
  }
  function configure(first: boolean) {
    const start = performance.now()
    if (first) { control.setSpatialInputChannelCount(channels); control.setParams(p) }
    else {
      updateIndex++; p.eq.enabled = updateIndex % 2 === 1
      // 同 tick 的非空间参数与姿态；每隔一次也改空间参数。
      if (updateIndex % 2 === 0) p.spatial.masterGain = updateIndex % 4 === 0 ? .9 : .85
      control.setParams(p)
    }
    const preparedParams = control.takePreparedRoomHrir(first)
    const pose = first ? null : { yaw: updateIndex % 2 ? 27 : -13, pitch: updateIndex % 2 ? 9 : -5, roll: -4 }
    if (!first) control.setSpatialHeadPose(pose)
    const preparedPose = first ? undefined : control.takePreparedRoomHrir()
    preparationMs.push(performance.now() - start)
    const snapshots = [preparedParams, preparedPose].filter(Boolean)
    preparedEvidence.push({ update: updateIndex,
      snapshots: snapshots.map(value => ({ directEntries: value!.direct?.entries.length ?? 0,
        earlySpeakers: value!.early?.speakers.filter(Boolean).length ?? 0 })) })
    deliver({ type: 'params', params: p, roomHrir: preparedParams })
    if (!first) deliver({ type: 'head-pose', pose, roomHrir: preparedPose })
  }
  function block(): BlockTiming {
    current = { callbackMs: 0, configurationMs: 0, dspMs: 0 }
    const start = performance.now()
    processor.process(inputs, outputs, automation)
    current.callbackMs = performance.now() - start
    // PCM 检查计时置于 callback 边界之外。
    for (const plane of output) pcmHash.update(Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength))
    for (const plane of output) for (let i = 0; i < plane.length; i++) {
      const value = plane[i]
      if (!Number.isFinite(value)) badPcm++
      else { peak = Math.max(peak, Math.abs(value)); checksum += value; if (Math.abs(value) > 1e-9) nonzeroSamples++ }
    }
    return current
  }
  const initial = await phase('initial-control-preparation', () => configure(true))
  const first = await phase('first-render-configuration', () => block())
  function runBlocks(count: number, updates = false) {
    const timings: BlockTiming[] = []
    for (let index = 0; index < count; index++) {
      if (updates && index % 30 === 0) configure(false)
      timings.push(block())
    }
    const budget = 128 / rate * 1000
    return { callbacks: count, callbackMs: distribution(timings.map(t => t.callbackMs)),
      configurationMs: distribution(timings.map(t => t.configurationMs)), dspMs: distribution(timings.map(t => t.dspMs)),
      callbacksAboveNominalQuantum: timings.filter(t => t.callbackMs > budget).length,
      rawTimings: timings }
  }
  const warmup = await phase('warmup', () => runBlocks(options.warmup))
  const steady = await phase('steady', () => runBlocks(options.blocks))
  const updates = options.scene === 'same-tick'
    ? await phase('same-tick-control-and-render', () => runBlocks(options.updates * 30, true)) : undefined
  if (session) { await post('Profiler.disable'); session.disconnect() }
  return { result: { kind: 'node-offline-spatial-profile', options, node: process.version, platform: process.platform,
    clock: 'performance.now', nominalQuantumMs: 128 / rate * 1000, channels,
    limitations: ['Node synchronously invoked real AudioEffectsProcessor; no audio hardware or browser scheduler.',
      'MessagePort and sampleRate globals simulated; structuredClone delivery measured separately.',
      'Instance timing wrappers and optional CPU sampling add overhead; not a hard realtime acceptance gate.',
      'Warmup and cold samples retained; nominal-quantum counts are diagnostics only.'],
    cold, initial, first, warmup, steady, updates, controlPreparationMs: distribution(preparationMs),
    messageCloneAndDeliveryMs: distribution(deliveryMs), preparedEvidence,
    pcm: { badPcm, peak, checksum, nonzeroSamples, sha256: pcmHash.digest('hex') }, renderStats: render.getStats(), profileSummary }, profiles }
}
