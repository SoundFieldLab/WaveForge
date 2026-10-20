import { build } from 'esbuild'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const result = await build({
  stdin: {
    contents: `export { TsConvolverBackend } from './src/services/waveforge-engine-v3/src/spatial/TsConvolverBackend.ts';
      export { createMeasuredHrtfGrid } from './src/services/waveforge-engine-v3/src/spatial/measuredHrtf.ts';
      export { createLayoutSpeakers } from './src/services/waveforge-engine-v3/src/spatial/layouts.ts';`,
    resolveDir: root,
    sourcefile: 'spatial-motion-benchmark-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { TsConvolverBackend, createMeasuredHrtfGrid, createLayoutSpeakers } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`
)

const fs = Number(process.argv.find(arg => arg.startsWith('--rate='))?.slice(7) ?? 96000)
const room = process.argv.find(arg => arg.startsWith('--room='))?.slice(7) ?? 'hall'
const interp = process.argv.find(arg => arg.startsWith('--interp='))?.slice(9) ?? 'spherical'
const preparedRoom = process.argv.includes('--prepared-room')
if (![44100, 48000, 96000].includes(fs)) throw new Error('unsupported sample rate')
if (!['off', 'hall'].includes(room)) throw new Error('unsupported room')
if (!['nearest', 'spherical'].includes(interp)) throw new Error('unsupported interpolation')

const backend = new TsConvolverBackend()
backend.loadHrtf(createMeasuredHrtfGrid(fs))
const speakers = createLayoutSpeakers('714')
const config = {
  speakers, room, roomAmount: room === 'off' ? 0 : 0.5,
  amount: 0.3, distanceModel: 'inverse', hrtfInterp: interp,
  convolution: 'partitioned', masterGain: 0.9,
}
backend.setConfig(config)
const producer = preparedRoom ? new TsConvolverBackend() : null
if (producer) producer.loadHrtf(createMeasuredHrtfGrid(fs))
const inputL = new Float32Array(128)
const inputR = new Float32Array(128)
const outputL = new Float32Array(128)
const outputR = new Float32Array(128)
for (let i = 0; i < 128; i++) {
  inputL[i] = Math.sin(i * 0.13) * 0.1
  inputR[i] = Math.sin(i * 0.17) * 0.1
}
const times = []
const configTimes = []
const renderTimes = []
const producerTimes = []
for (let step = 0; step < 120; step++) {
  // 单声源持续转动；每次都跨过连续插值 0.5° 更新门槛。
  speakers[0] = { ...speakers[0], azimuthDeg: -40 + step * 0.8 }
  const producerStarted = performance.now()
  producer?.setConfig(config)
  const prepared = producer?.takePreparedRoomHrir(step === 0)
  // 模拟消息结构化克隆；主线程准备与克隆不计入音频线程配置耗时，另列准备耗时。
  const packet = prepared ? structuredClone(prepared) : null
  const producerElapsed = performance.now() - producerStarted
  const start = performance.now()
  if (packet) backend.primeRoomHrir(packet)
  backend.setConfig(config)
  const configured = performance.now()
  backend.processStereo(inputL, inputR, outputL, outputR)
  const finished = performance.now()
  if (step >= 20) {
    configTimes.push(configured - start)
    renderTimes.push(finished - configured)
    times.push(finished - start)
    producerTimes.push(producerElapsed)
  }
}
for (const samples of [times, configTimes, renderTimes, producerTimes]) samples.sort((a, b) => a - b)
const at = (samples, fraction) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)]
console.log(JSON.stringify({ fs, room, interp, preparedRoom, speakers: speakers.length,
  quantumBudgetMs: 128 / fs * 1000,
  medianMs: at(times, 0.5), p95Ms: at(times, 0.95), p99Ms: at(times, 0.99), maxMs: times.at(-1),
  configMedianMs: at(configTimes, 0.5), configP95Ms: at(configTimes, 0.95),
  renderMedianMs: at(renderTimes, 0.5), renderP95Ms: at(renderTimes, 0.95),
  producerMedianMs: producer ? at(producerTimes, 0.5) : null }, null, 2))
