import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

// 验证打包文件能在无 DOM/import 的 Worklet 全局装载并处理 PCM；浏览器试听另行执行。
let Processor
const messages = []
const context = vm.createContext({
  sampleRate: 48000,
  AudioWorkletProcessor: class {
    port = { onmessage: null, postMessage: (msg) => messages.push(msg) }
  },
  registerProcessor: (name, ctor) => {
    assert.equal(name, 'waveforge-v3-effects')
    Processor = ctor
  },
})
vm.runInContext(readFileSync(new URL('../public/v3-worklet.js', import.meta.url), 'utf8'), context)
assert.ok(Processor)
const processor = new Processor()
const input = Float32Array.from({ length: 128 }, (_, i) => 0.2 * Math.sin(i * 0.1))
for (let frame = 0; frame < 180; frame++) {
  const output = [new Float32Array(128), new Float32Array(128)]
  assert.equal(processor.process([[input, input]], [output], {}), true)
  assert.ok(output.every((ch) => ch.every(Number.isFinite)))
}
assert.ok(messages.length > 0)
assert.ok(Number.isFinite(messages.at(-1).timing.blockBudgetMs))
assert.ok(messages.at(-1).timing.callbacks > 0)
assert.ok(['performance', 'date'].includes(messages.at(-1).timing.clock))
processor.port.onmessage({ data: { type: 'register-node', config: { id: 'mute', kind: 'gain', leftGain: 0, rightGain: 0 } } })
let muted = [new Float32Array(128), new Float32Array(128)]
for (let frame = 0; frame < 10; frame++) {
  muted = [new Float32Array(128), new Float32Array(128)]
  processor.process([[input, input]], [muted], {})
}
assert.ok(muted.every((channel) => channel.every((sample) => Math.abs(sample) < 1e-6)))
processor.port.onmessage({ data: { type: 'unregister-node', id: 'mute' } })
// 首个 80ms 遥测早于 LUFS 400ms 积分窗口，允许 NaN；最后一帧应已有有效测量。
assert.ok(Number.isFinite(messages.at(-1).stats.lufsIntegrated))
// 同一打包处理器内开启空间模式，覆盖内嵌 KEMAR 解码、插值与实际 PCM 路径。
// 注意：EngineV3.setParams 以「引擎自有快照」做结构化比较，绝不能直接改 engine._params
// 来构造测试参数（那样等于先改引擎快照、再发同一值，变更会被正确判为无变化）。
const spatialSource = processor.engine._params
const spatialParams = { ...spatialSource, spatial: { ...spatialSource.spatial, instant: { ...spatialSource.spatial.instant } } }
spatialParams.spatial.mode = 'instant'
spatialParams.spatial.hrtfInterp = 'spherical'
spatialParams.spatial.instant.room = 'hall'
spatialParams.spatial.instant.roomAmount = 0.5
const preparationSource = new Processor()
preparationSource.engine.setParams(spatialParams)
const roomHrir = preparationSource.engine.takePreparedRoomHrir(true)
assert.ok(roomHrir?.entries.length > 0)
// 连续两条参数消息合流到最后一份，但两批缓存增量都必须留下。
const split = Math.ceil(roomHrir.entries.length / 2)
processor.port.onmessage({ data: { type: 'params', params: { ...spatialParams, stereoWidth: 0.5 },
  roomHrir: { ...roomHrir, entries: roomHrir.entries.slice(0, split) } } })
processor.port.onmessage({ data: { type: 'params', params: spatialParams,
  roomHrir: { ...roomHrir, entries: roomHrir.entries.slice(split) } } })
let spatialPeak = 0
for (let frame = 0; frame < 24; frame++) {
  const output = [new Float32Array(128), new Float32Array(128)]
  assert.equal(processor.process([[input, input]], [output], {}), true)
  assert.ok(output.every((ch) => ch.every(Number.isFinite)))
  for (const channel of output) for (const sample of channel) spatialPeak = Math.max(spatialPeak, Math.abs(sample))
}
assert.ok(spatialPeak > 0.01)
assert.equal(processor.engine.takePreparedRoomHrir(), undefined, '房间线索应全部命中主线程预计算')
// IR 首次传入后，普通参数更新从 Worklet 缓存复用同一数组，避免重建分区 FFT。
const ir = Float32Array.from([1, 0.25, 0.125])
const convolutionParams = {
  ...processor.engine._params,
  spatial: { ...processor.engine._params.spatial, mode: 'off' },
  reverb: { ...processor.engine._params.reverb, enabled: true, mode: 'convolution',
    convolution: { ...processor.engine._params.reverb.convolution, ir, irName: 'verify.wav' } },
}
processor.port.onmessage({ data: { type: 'params', params: convolutionParams } })
assert.notEqual(processor.engine._params.reverb.mode, 'convolution')
processor.process([[input, input]], [[new Float32Array(128), new Float32Array(128)]], {})
assert.equal(processor.engine._params.reverb.mode, 'convolution')
assert.equal(processor.engine._loadedIr, ir)
const reuseParams = { ...convolutionParams, stereoWidth: 1.1, reverb: { ...convolutionParams.reverb,
  convolution: { ...convolutionParams.reverb.convolution, ir: null } } }
processor.port.onmessage({ data: { type: 'params', params: reuseParams, reuseIr: true } })
processor.process([[input, input]], [[new Float32Array(128), new Float32Array(128)]], {})
assert.equal(processor.engine._loadedIr, ir)
// 同一帧前 params→reset 不得丢失快照；reset→params 也必须保留最后的新配置。
const resetParams = { ...reuseParams, stereoWidth: 0.37 }
processor.port.onmessage({ data: { type: 'params', params: resetParams, reuseIr: true } })
processor.port.onmessage({ data: { type: 'reset' } })
const mono = new Float32Array(97)
assert.equal(processor.process([], [[mono]], {}), true)
assert.ok(mono.every(Number.isFinite))
assert.equal(processor.engine._params.stereoWidth, 0.37)
assert.equal(processor.engine._loadedIr, ir)
processor.port.onmessage({ data: { type: 'reset' } })
processor.port.onmessage({ data: { type: 'params', params: { ...resetParams, stereoWidth: 0.61 }, reuseIr: true } })
processor.process([[input, input]], [[new Float32Array(128), new Float32Array(128)]], {})
assert.equal(processor.engine._params.stereoWidth, 0.61)
// 大型 IR 的控制线程预计算状态在帧边界被 Worklet 直接接管，无须执行 IR FFT。
const irPreparationSource = new Processor()
const longIr = new Float32Array(8192)
for (let i = 0; i < longIr.length; i++) longIr[i] = (i === 0 ? 1 : 0) + 0.1 * Math.exp(-i / 1200)
const preparedParams = { ...irPreparationSource.engine._params,
  reverb: { ...irPreparationSource.engine._params.reverb, enabled: true, mode: 'convolution',
    convolution: { ...irPreparationSource.engine._params.reverb.convolution, ir: longIr, irName: 'prepared-long.wav',
      partitionSize: 256, dePeriodize: false } } }
irPreparationSource.engine.setParams(preparedParams)
const preparedConvolverIR = irPreparationSource.engine.createPreparedConvolverIRTransfer()
assert.ok(preparedConvolverIR)
const preparedMessageParams = { ...preparedParams, reverb: { ...preparedParams.reverb,
  convolution: { ...preparedParams.reverb.convolution, ir: null } } }
processor.port.onmessage({ data: { type: 'params', params: preparedMessageParams, irChanged: true, preparedConvolverIR } })
processor.process([[input, input]], [[new Float32Array(128), new Float32Array(128)]], {})
// 退场期间到来的普通参数不能丢掉尚未提交的 prepared IR。
processor.port.onmessage({ data: { type: 'params', params: { ...preparedMessageParams,
  reverb: { ...preparedMessageParams.reverb, convolution: { ...preparedMessageParams.reverb.convolution, mix: 0.7 } } }, reuseIr: true } })
// 活跃卷积先退场 10ms，再在零湿声点接管；不再要求首个量子立即替换。
for (let frame = 0; frame < 8; frame++) processor.process([[input, input]], [[new Float32Array(128), new Float32Array(128)]], {})
assert.equal(processor.engine._loadedIr.length, 1, 'prepared IR uses a lightweight identity token')
assert.equal(processor.engine._convolver.irSpecReal, preparedConvolverIR.irSpecReal)
const preparedReuseParams = { ...preparedMessageParams, stereoWidth: 0.77 }
processor.port.onmessage({ data: { type: 'params', params: preparedReuseParams, reuseIr: true, irChanged: false } })
processor.process([[input, input]], [[new Float32Array(128), new Float32Array(128)]], {})
assert.equal(processor.engine._loadedIr.length, 1)
assert.equal(processor.engine._convolver.irSpecReal, preparedConvolverIR.irSpecReal)
const multichannel = new Processor()
const multichannelSource = multichannel.engine._params
const multichannelParams = { ...multichannelSource,
  eq: { ...multichannelSource.eq }, limiter: { ...multichannelSource.limiter },
  spatial: { ...multichannelSource.spatial, instant: { ...multichannelSource.spatial.instant } } }
multichannelParams.eq.enabled = false
multichannelParams.limiter.enabled = false
multichannel.port.onmessage({ data: { type: 'params', params: multichannelParams } })
const input51 = [0, 0, 0.2, 0, 0, 0].map((value) => new Float32Array(128).fill(value))
const downmixed = [new Float32Array(128), new Float32Array(128)]
assert.equal(multichannel.process([input51], [downmixed], {}), true)
assert.ok(downmixed[0][127] > 0.1 && downmixed[1][127] > 0.1)
const quad = [0, 0, 0.2, 0].map((value) => new Float32Array(128).fill(value))
multichannel.process([quad], [downmixed], {})
assert.ok(Math.abs(downmixed[0][127] - 0.1) < 1e-6)
assert.equal(downmixed[1][127], 0)
multichannelParams.spatial.mode = 'instant'
multichannelParams.spatial.instant.multichannelAuto = true
multichannelParams.spatial.instant.multichannelLayout = '51'
multichannelParams.spatial.instant.room = 'off'
multichannel.port.onmessage({ data: { type: 'params', params: multichannelParams } })
let spatialInput = null
const spatialBackend = multichannel.engine._spatialBackend
const originalProcessMulti = spatialBackend.processMulti.bind(spatialBackend)
spatialBackend.processMulti = (channels, ...outputs) => { spatialInput = channels; originalProcessMulti(channels, ...outputs) }
const inputChannels = [0, 0, 0, 0, 0.4, 0.6].map((value) => new Float32Array(128).fill(value))
multichannel.process([inputChannels], [[new Float32Array(128), new Float32Array(128)]], {})
assert.equal(spatialInput?.length, 6)
assert.ok(Math.abs(spatialInput?.[4][127] - 0.4) < 1e-6)
assert.ok(Math.abs(spatialInput?.[5][127] - 0.6) < 1e-6)
console.log('Worklet 打包装载、空间/房间处理、多声道 HRTF 路由、IR 复用、帧边界参数与 reset 顺序、可序列化节点、四声道/5.1 折叠、统计与静音验证通过')

// 组合扩展节点须在真实打包处理器内保留顺序、历史和延迟。
const composed = new Processor()
const composedSource = composed.engine._params
const composedParams = { ...composedSource, eq: { ...composedSource.eq }, limiter: { ...composedSource.limiter } }
composedParams.eq.enabled = false
composedParams.limiter.enabled = false
composed.port.onmessage({ data: { type: 'params', params: composedParams } })
composed.port.onmessage({ data: { type: 'register-node', config: { id: 'combo', kind: 'chain', nodes: [
  { id: 'swap', kind: 'matrix', ll: 0, lr: 1, rl: 1, rr: 0 },
  { id: 'fir', kind: 'fir', coefficients: [0.5, 0.25] },
  { id: 'delay', kind: 'delay', samples: 130 },
] } } })
const pulse = [new Float32Array(128), new Float32Array(128)]
pulse[0][0] = 0.4; pulse[1][0] = 0.8
const comboOutput = [new Float32Array(128), new Float32Array(128)]
composed.process([pulse], [comboOutput], {})
assert.ok(comboOutput.every(channel => channel.every(sample => sample === 0)))
composed.process([[new Float32Array(128), new Float32Array(128)]], [comboOutput], {})
assert.ok(Math.abs(comboOutput[0][2] - 0.4) < 1e-6)
assert.ok(Math.abs(comboOutput[0][3] - 0.2) < 1e-6)
assert.ok(Math.abs(comboOutput[1][2] - 0.2) < 1e-6)
assert.equal(composed.engine.getLatencySamples(), 130)
// 输入声道数变化时，自动识别切换标准布局，包括回到立体声。
const detected = new Processor()
const detectedSource = detected.engine._params
const detectedParams = { ...detectedSource, spatial: { ...detectedSource.spatial, instant: { ...detectedSource.spatial.instant } } }
detectedParams.spatial.mode = 'instant'
detectedParams.spatial.instant.multichannelAuto = true
detectedParams.spatial.instant.multichannelLayout = 'auto'
detectedParams.spatial.instant.room = 'off'
detected.port.onmessage({ data: { type: 'params', params: detectedParams } })
for (const channels of [4, 6, 8, 12, 2]) {
  const output = [new Float32Array(128), new Float32Array(128)]
  const inputs = Array.from({ length: channels }, (_, i) => new Float32Array(128).fill(0.01 * (i + 1)))
  assert.equal(detected.process([inputs], [output], {}), true)
  assert.ok(output.every(channel => channel.every(Number.isFinite)))
  for (let frame = 0; frame < 16; frame++) detected.process([inputs], [output], {})
  assert.equal(detected.engine._spatialBackend.speakers.length, channels)
}
console.log('组合 DSP 节点、跨块延迟与自动输入布局验证通过')

// 第三方 TS 模块独立打包后，在同一 Worklet realm 注册自有 DSP 工厂。
const extension = await build({ entryPoints: [fileURLToPath(new URL('../examples/dc-blocker.ts', import.meta.url))],
  bundle: true, format: 'iife', write: false })
vm.runInContext(extension.outputFiles[0].text, context)
const custom = new Processor()
const customSource = custom.engine._params
const customParams = { ...customSource, eq: { ...customSource.eq }, limiter: { ...customSource.limiter } }
customParams.eq.enabled = false; customParams.limiter.enabled = false
custom.port.onmessage({ data: { type: 'params', params: customParams } })
custom.port.onmessage({ data: { type: 'register-node', config: {
  id: 'third-party', kind: 'custom', type: 'example/dc-blocker', data: vm.runInContext('({ cutoffHz: 20 })', context),
} } })
const dcOutput = [new Float32Array(128), new Float32Array(128)]
custom.process([[new Float32Array(128).fill(0.2), new Float32Array(128).fill(0.1)]], [dcOutput], {})
assert.ok(Math.abs(dcOutput[0][0] - 0.2) < 1e-6)
assert.ok(Math.abs(dcOutput[0][127] - 0.2 * Math.exp(-2 * Math.PI * 20 / 48000 * 127)) < 1e-6)
assert.ok(Math.abs(dcOutput[1][127] - dcOutput[0][127] * 0.5) < 1e-6)
console.log('独立第三方 TS 模块的工厂注册和实际 PCM 验证通过')
