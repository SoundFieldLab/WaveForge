import { createDefaultParams } from '../../src/services/waveforge-engine-v3/src/types'
import { EngineV3Host } from '../../src/services/waveforge-engine-v3/src/integration/EngineV3Host'
import { decodeSpatialAudioFile } from '../../src/services/waveforge-engine-v3/src/integration/SpatialAudioSource'
import { createMeasuredHrtfGrid } from '../../src/services/waveforge-engine-v3/src/spatial/measuredHrtf'

interface ProbeOptions { rate: number; scriptFallback: boolean; scriptOnly: boolean; scenario?: string; budget?: 'quality' | 'auto' | 'lowLatency' }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function progress(scene: string, stage: string, detail: unknown = null): void {
  console.log(`HSE_COMPLETION_PROGRESS:${JSON.stringify({ scene, stage, atMs: performance.now(), detail })}`)
}
function params(rate: number, format = 'channels', budget: 'quality' | 'auto' | 'lowLatency' = 'quality') {
  const p = createDefaultParams(rate)
  p.spatial.budgetMode = budget
  for (const value of Object.values(p)) if (value && typeof value === 'object' && 'enabled' in value) value.enabled = false
  p.subsonicEnabled = false
  p.spatial.mode = 'instant'; p.spatial.instant.amount = 1; p.spatial.instant.room = 'off'
  p.spatial.instant.multichannelAuto = true
  p.spatial.inputFormat = format as typeof p.spatial.inputFormat
  p.spatial.renderStyle = 'focused'; p.spatial.hrtfInterp = 'spherical'
  return p
}
function sourceBuffer(ctx: AudioContext, channels: number, highestOnly = false): AudioBuffer {
  const buffer = ctx.createBuffer(channels, 16384, ctx.sampleRate)
  for (let channel = 0; channel < channels; channel++) {
    const plane = buffer.getChannelData(channel)
    if (highestOnly && channel !== channels - 1) continue
    const cycles = Math.max(1, Math.round((311 + channel * 139) * plane.length / ctx.sampleRate))
    for (let i = 0; i < plane.length; i++) plane[i] = Math.sin(2 * Math.PI * cycles * i / plane.length) * 0.025
  }
  return buffer
}
function timingState() {
  return { callbacks: 0, overruns: 0, maxProcessMs: 0, maxConfigMs: 0, maxDspMs: 0,
    clock: 'unavailable', resolutionMs: null as number | null, includesWarmup: true, inputChannelCounts: [] as number[] }
}

async function scenario(options: ProbeOptions, name: string, format: string, channels: number,
  extra: { spectral?: boolean; ab?: boolean; pose?: boolean; file?: boolean; script?: boolean; highestOnly?: boolean } = {}) {
  const ctx = new AudioContext({ sampleRate: options.rate, latencyHint: 'interactive' })
  progress(name, 'context-created', { sampleRate: ctx.sampleRate, state: ctx.state })
  // 自动播放策略可能使构造后的 Context 立即运行。先暂停，避免两次异步 attach
  // 各自经历不同长度的默认限幅器退场；所有参数均在同一次 resume 后生效。
  await ctx.suspend()
  progress(name, 'context-suspended', { state: ctx.state })
  if (ctx.sampleRate !== options.rate) throw new Error(`requested ${options.rate}, actual ${ctx.sampleRate}`)
  await ctx.audioWorklet.addModule('/completion-capture.js')
  const compare = Boolean(extra.ab || extra.spectral)
  const capture = new AudioWorkletNode(ctx, 'hse-completion-capture', {
    numberOfInputs: extra.ab ? 3 : compare ? 2 : 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete',
    processorOptions: { frames: Math.ceil(ctx.sampleRate * 0.85), compare },
  })
  const errors: string[] = [], timing = timingState()
  const inputCounts = new Set<number>()
  const scriptCalls: number[] = []
  const scriptConsumed = new Set<number>()
  const scriptTiming = { callbacks: 0, overruns: 0, maxProcessMs: 0, declaredInputChannels: channels,
    requestedInputCapacity: 0, physicalInputCapacities: [] as number[], consumedEngineChannels: [] as number[],
    blockBudgetMs: 1024 / ctx.sampleRate * 1000, includesWarmup: true }
  let scriptNode: ScriptProcessorNode | undefined
  const hostContext = extra.script ? {
    sampleRate: ctx.sampleRate,
    createScriptProcessor(size: number, inputs: number, outputs: number) {
      scriptTiming.requestedInputCapacity = inputs
      scriptNode = ctx.createScriptProcessor(size, inputs, outputs)
      return scriptNode
    },
  } : ctx
  let buffer = sourceBuffer(ctx, channels, extra.highestOnly)
  let fileEvidence: unknown = null
  if (extra.file) {
    const response = await fetch('/fixture-six-channel.wav')
    const bytes = await response.arrayBuffer()
    const decoded = await decodeSpatialAudioFile({ name: 'fixture-six-channel.wav', arrayBuffer: async () => bytes })
    if (decoded.channels.length !== 6 || decoded.layout !== '51') throw new Error('six-channel fixture routing failed')
    const markers = decoded.channels.map((plane, channel) => ({ channel, expected: (channel + 1) / 64, actual: plane[0] }))
    if (markers.some(item => Math.abs(item.actual - item.expected) > 1e-7)) throw new Error('fixture channel marker mismatch')
    fileEvidence = { byteLength: bytes.byteLength, frames: decoded.frames, sampleRate: decoded.sampleRate,
      encoding: decoded.encoding, channelMask: decoded.channelMask, sourceChannelLabels: decoded.sourceChannelLabels,
      channelLabels: decoded.channelLabels, channelMap: decoded.channelMap, markers }
    buffer = ctx.createBuffer(decoded.channels.length, decoded.frames, decoded.sampleRate)
    decoded.channels.forEach((plane, index) => buffer.copyToChannel(plane, index))
  }
  const gain = ctx.createGain()
  gain.channelCount = channels; gain.channelCountMode = 'explicit'; gain.channelInterpretation = 'discrete'
  const p = params(ctx.sampleRate, format, options.budget)
  if (extra.spectral || extra.pose) {
    p.spatial.instant.room = 'studio'; p.spatial.instant.roomAmount = 0.45
    p.spatial.earlyReflectionModel = 'spectral'; p.spatial.lateAmount = 0
  }
  if (extra.ab) p.spatial.mode = 'off'
  const host = new EngineV3Host({ mode: extra.script ? 'auto' : 'worklet', workletUrl: '/v3-worklet.js', blockSize: 1024 })
  progress(name, 'host-created')
  host.setSpatialInputChannelCount(channels)
  progress(name, 'input-hint-ready')
  const attachStarted = performance.now()
  progress(name, 'host-attach-start', { format, channels, spectral: extra.spectral || extra.pose })
  await host.attach({ audioContext: hostContext, masterGain: gain, analyser: capture }, p)
  progress(name, 'host-attached', { ms: performance.now() - attachStarted, mode: host.getMode(), state: ctx.state })
  if (host.getMode() !== (extra.script ? 'script' : 'worklet')) throw new Error('unexpected Host mode')
  const engine = host.getAudioNode() as unknown as AudioWorkletNode
  engine.onprocessorerror = () => errors.push('Host processorerror')
  capture.onprocessorerror = () => errors.push('capture processorerror')
  const watch = (node: AudioWorkletNode) => {
    if (!node.port) return
    node.port.addEventListener('message', event => {
      const message = event.data
      if (message.type !== 'stats') return
      if (Number.isInteger(message.inputChannels)) inputCounts.add(message.inputChannels)
      const t = message.timing
      if (!t) return
      timing.clock = t.clock; timing.resolutionMs = t.resolutionMs
      timing.callbacks += t.callbacks; timing.overruns += t.overruns
      timing.maxProcessMs = Math.max(timing.maxProcessMs, t.maxProcessMs)
      timing.maxConfigMs = Math.max(timing.maxConfigMs, t.maxConfigMs)
      timing.maxDspMs = Math.max(timing.maxDspMs, t.maxDspMs)
    })
    node.port.start()
  }
  watch(engine)
  if (scriptNode) {
    const target = scriptNode
    const original = target.onaudioprocess
    target.onaudioprocess = event => {
      const start = performance.now()
      if (!scriptCalls.includes(event.inputBuffer.numberOfChannels)) scriptCalls.push(event.inputBuffer.numberOfChannels)
      original?.call(target, event)
      const elapsed = performance.now() - start
      const consumed = host.engine.getStats().inputChannels
      if (Number.isInteger(consumed)) scriptConsumed.add(consumed!)
      scriptTiming.callbacks++; scriptTiming.maxProcessMs = Math.max(scriptTiming.maxProcessMs, elapsed)
      if (elapsed > event.outputBuffer.length / ctx.sampleRate * 1000) scriptTiming.overruns++
    }
  }
  const preparedMessages: Array<{ type: string; speakers: number; signature: string }> = []
  if (engine.port) {
    const post = engine.port.postMessage.bind(engine.port)
    engine.port.postMessage = ((message: any, transfer?: Transferable[]) => {
      const early = message.roomHrir?.early
      if (early) preparedMessages.push({ type: message.type, speakers: early.speakers.filter(Boolean).length, signature: early.signature })
      if (transfer) post(message, transfer)
      else post(message)
    }) as typeof engine.port.postMessage
  }
  progress(name, 'spectral-snapshot-start')
  const snapshotStarted = performance.now()
  const spectralPrepared = extra.spectral ? host.engine.takePreparedRoomHrir(true)?.early : undefined
  const spectralPreparation = spectralPrepared ? {
    speakers: spectralPrepared.speakers.length,
    preparedSpeakers: spectralPrepared.speakers.filter(Boolean).length,
    partitionCounts: spectralPrepared.speakers.map(value => value?.partitionCount ?? 0),
  } : null
  progress(name, 'spectral-snapshot-ready', { ms: performance.now() - snapshotStarted, ...spectralPreparation })
  let secondHost: EngineV3Host | undefined
  if (compare) {
    const secondGain = ctx.createGain()
    secondGain.channelCount = 2; secondGain.channelCountMode = 'explicit'; secondGain.channelInterpretation = 'discrete'
    const secondOutput = ctx.createGain()
    secondOutput.connect(capture, 0, 1)
    secondHost = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    progress(name, 'comparison-host-created')
    const comparison = extra.spectral ? structuredClone(p) : params(ctx.sampleRate, 'channels', options.budget)
    if (extra.spectral) comparison.spatial.earlyReflectionModel = 'cues'
    else comparison.spatial.instant.amount = 0
    const comparisonStarted = performance.now()
    progress(name, 'comparison-attach-start', { model: comparison.spatial.earlyReflectionModel })
    await secondHost.attach({ audioContext: ctx, masterGain: secondGain, analyser: secondOutput }, comparison)
    progress(name, 'comparison-attached', { ms: performance.now() - comparisonStarted })
    watch(secondHost.getAudioNode() as unknown as AudioWorkletNode)
    gain.connect(secondGain)
  }
  if (extra.ab) gain.connect(capture, 0, 2)
  const completion = new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${name} capture timeout`)), 10000)
    capture.port.onmessage = event => {
      if (event.data.type === 'checkpoint') { progress(name, 'capture-checkpoint', event.data); return }
      clearTimeout(timeout); progress(name, 'capture-complete', { frames: event.data.frames, peak: event.data.peak }); resolve(event.data)
    }
  })
  const source = ctx.createBufferSource()
  source.buffer = buffer; source.loop = true; source.channelInterpretation = 'discrete'
  source.connect(gain); capture.connect(ctx.destination)
  // 给两个引擎同样的静音时间完成非空间模块退场；A/B 仍严格比较整个静音和有声区间，
  // 计时也包含这些初始化回调，不剔除 warmup。
  source.start(ctx.currentTime + 0.1)
  progress(name, 'context-resume-start', { state: ctx.state, currentTime: ctx.currentTime })
  await ctx.resume()
  progress(name, 'context-running', { state: ctx.state, currentTime: ctx.currentTime })
  let sameTickUpdates = 0
  let hrtfReplacements = 0
  if (extra.pose) {
    // 同一个 JavaScript tick 连续提交两种消息，逼近真实 UI 同帧更新。
    // 仅改非空间 EQ；空间快照相同也必须提交新姿态。
    p.eq.enabled = true
    host.setParams(p); host.setSpatialHeadPose({ yaw: 27, pitch: 9, roll: -4 }); sameTickUpdates++
    await wait(120)
    // 再覆盖需要重建反射的空间参数快照，核对 params 消息本身也携带频谱。
    p.spatial.mode = 'world'
    host.setParams(p); host.setSpatialHeadPose({ yaw: 10, pitch: 3, roll: -2 }); sameTickUpdates++
    await wait(120)
    p.spatial.masterGain = 0.85
    const original = createMeasuredHrtfGrid(ctx.sampleRate)
    host.setSpatialHrtf({ ...original, left: Float32Array.from(original.left, value => value * 0.95),
      right: original.right.slice(), source: `${original.source}; superseded replacement` })
    hrtfReplacements++
    host.setSpatialHrtf({ ...original, left: Float32Array.from(original.left, value => value * 0.83),
      right: Float32Array.from(original.right, value => value * 0.91), source: `${original.source}; probe replacement` })
    hrtfReplacements++
    host.setParams(p); host.setSpatialHeadPose({ yaw: -13, pitch: -5, roll: 2 }); sameTickUpdates++
  }
  const pcm = await completion
  progress(name, 'teardown-start', { timing })
  timing.inputChannelCounts = [...inputCounts]
  scriptTiming.physicalInputCapacities = scriptCalls
  scriptTiming.consumedEngineChannels = [...scriptConsumed]
  const result = { name, format, expectedInputChannels: channels, highestOnly: Boolean(extra.highestOnly),
    sourceBufferChannels: buffer.numberOfChannels, mode: host.getMode(), sampleRate: ctx.sampleRate, state: ctx.state,
    timing, scriptTiming: extra.script ? scriptTiming : null, pcm, sameTickUpdates, hrtfReplacements, preparedMessages, errors, fileEvidence,
    spectralPreparation, comparison: extra.spectral ? 'full-spectral-versus-cues' : extra.ab ? 'off-versus-zero-amount' : null }
  progress(name, 'context-suspend-before-disconnect-start')
  await ctx.suspend()
  progress(name, 'context-suspend-before-disconnect-resolved')
  source.stop(); source.disconnect()
  progress(name, 'source-stopped')
  const comparisonNode = secondHost?.getAudioNode() as unknown as AudioWorkletNode | null
  host.dispose()
  progress(name, 'primary-host-disposed')
  secondHost?.dispose()
  progress(name, 'comparison-host-disposed')
  capture.disconnect()
  progress(name, 'capture-disconnected', { state: ctx.state })
  engine.port?.close()
  comparisonNode?.port?.close()
  capture.port.close()
  progress(name, 'ports-closed')
  const closeStarted = performance.now()
  progress(name, 'context-close-start')
  await ctx.close()
  progress(name, 'context-close-resolved', { ms: performance.now() - closeStarted })
  progress(name, 'context-closed')
  if (pcm.traces?.length) {
    pcm.correlations = pcm.traces.slice(1).map((reference: number[], index: number) => {
      const signal = pcm.traces[0]
      let bestLag = 0, bestError = Infinity
      for (let lag = -1024; lag <= 1024; lag++) {
        let sum = 0
        for (let i = 1024; i < Math.min(signal.length, reference.length) - 1024; i += 3)
          sum += (signal[i] - reference[i + lag]) ** 2
        if (sum < bestError) { bestLag = lag; bestError = sum }
      }
      return { input: index + 1, bestLag, squaredError: bestError }
    })
    delete pcm.traces
  }
  return result
}

export async function runSpatialCompletion(options: ProbeOptions) {
  const stages = []
  const selected = (name: string) => !options.scenario || options.scenario === name
  if (!options.scriptOnly) {
    if (selected('ambix2-highest-order')) stages.push(await scenario(options, 'ambix2-highest-order', 'ambix2', 9, { highestOnly: true }))
    if (selected('ambix3-highest-order')) stages.push(await scenario(options, 'ambix3-highest-order', 'ambix3', 16, { highestOnly: true }))
    if (selected('stereo-to-51')) stages.push(await scenario(options, 'stereo-to-51', 'stereo51', 2))
    if (selected('stereo-to-71')) stages.push(await scenario(options, 'stereo-to-71', 'stereo71', 2))
    if (selected('spectral-early')) stages.push(await scenario(options, 'spectral-early', 'channels', 2, { spectral: true }))
    if (selected('zero-amount-ab')) stages.push(await scenario(options, 'zero-amount-ab', 'channels', 2, { ab: true }))
    if (selected('same-tick-params-headpose')) stages.push(await scenario(options, 'same-tick-params-headpose', 'channels', 2, { pose: true }))
    if (selected('actual-wav-decode-six-channel')) stages.push(await scenario(options, 'actual-wav-decode-six-channel', 'channels', 6, { file: true }))
  }
  if ((options.scriptFallback || options.scriptOnly) && selected('script-fallback-sixteen-input'))
    stages.push(await scenario(options, 'script-fallback-sixteen-input', 'ambix3', 16, { script: true, highestOnly: true }))
  if (!stages.length) throw new Error(`No matching scene: ${options.scenario}`)
  return { requestedRate: options.rate, stages, timingScope: 'All delivered timing reports include initialization and warmup; final partial stats interval may not be delivered.',
    limitations: 'This validates Chromium graph PCM and callback observations, not physical-device deadlines or listening quality.' }
}

;(globalThis as any).runSpatialCompletion = runSpatialCompletion
