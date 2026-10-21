import { build } from 'esbuild'

const root = new URL('../../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
const bundle = await build({
  stdin: {
    contents: `export { EngineV3 } from './src/services/waveforge-engine-v3/src/engine/EngineV3.ts';
      export { createDefaultParams } from './src/services/waveforge-engine-v3/src/types.ts';
      export { fft } from './src/services/waveforge-engine-v3/src/dsp/fft.ts';`,
    resolveDir: root,
    sourcefile: 'spatial-spectrum-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { EngineV3, createDefaultParams, fft } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
)

const sampleRate = Number(process.argv.find(arg => arg.startsWith('--rate='))?.slice(7) ?? 48000)
const modes = process.argv.find(arg => arg.startsWith('--mode='))
  ? [process.argv.find(arg => arg.startsWith('--mode='))?.slice(7)]
  : ['instant', 'headLocked', 'world', 'stage']
const size = 8192
const pulseAt = 4096
const frequencies = Array.from({ length: 24 * 7 + 1 }, (_, i) => 125 * 2 ** (i / 24))

function spectrum(mode, amount, channel = 'mono') {
  const engine = new EngineV3(sampleRate)
  const params = createDefaultParams(sampleRate)
  params.eq.enabled = false
  params.limiter.enabled = false
  params.spatial.mode = mode
  params.spatial.instant.amount = amount
  params.spatial.instant.room = 'off'
  params.spatial.instant.roomAmount = 0
  params.spatial.stage.reverbAmount = 0
  engine.setParams(params)

  const inputL = new Float32Array(pulseAt + size)
  const inputR = new Float32Array(pulseAt + size)
  inputL[pulseAt] = 0.01
  if (channel === 'mono') inputR[pulseAt] = 0.01
  const outL = new Float32Array(inputL.length)
  const outR = new Float32Array(inputL.length)
  engine.process([inputL, inputR], [outL, outR])
  const mid = new Float32Array(size)
  const imag = new Float32Array(size)
  for (let i = 0; i < size; i++) mid[i] = 0.5 * (outL[pulseAt + i] + outR[pulseAt + i])
  fft(mid, imag, false)
  const left = new Float32Array(size)
  const right = new Float32Array(size)
  const imagL = new Float32Array(size)
  const imagR = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    left[i] = outL[pulseAt + i]
    right[i] = outR[pulseAt + i]
  }
  fft(left, imagL, false)
  fft(right, imagR, false)
  const values = frequencies.filter(hz => hz < sampleRate * 0.45).map(hz => {
    const bin = Math.round(hz * size / sampleRate)
    const midDb = 20 * Math.log10(Math.max(1e-12, Math.hypot(mid[bin], imag[bin]) / 0.01))
    const leftDb = 20 * Math.log10(Math.max(1e-12, Math.hypot(left[bin], imagL[bin])))
    const rightDb = 20 * Math.log10(Math.max(1e-12, Math.hypot(right[bin], imagR[bin])))
    return channel === 'mono' ? midDb : leftDb - rightDb
  })
  return { frequencies: frequencies.slice(0, values.length), values }
}

for (const mode of modes) {
  for (const amount of [0.7, 1]) {
    const { frequencies: hz, values } = spectrum(mode, amount)
    const pairs = hz.map((f, i) => [f, values[i]])
    const minimum = pairs.reduce((a, b) => b[1] < a[1] ? b : a)
    const maximum = pairs.reduce((a, b) => b[1] > a[1] ? b : a)
    const sorted = values.slice().sort((a, b) => a - b)
    const percent = p => sorted[Math.floor(p * (sorted.length - 1))]
    console.log(JSON.stringify({ mode, amount, rate: sampleRate,
      min: minimum.map(x => +x.toFixed(2)), max: maximum.map(x => +x.toFixed(2)),
      p10: +percent(0.1).toFixed(2), median: +percent(0.5).toFixed(2),
      p90: +percent(0.9).toFixed(2) }))
    const hardLeft = spectrum(mode, amount, 'left')
    const imagePairs = hardLeft.frequencies.map((f, i) => [f, hardLeft.values[i]])
    const imageMin = imagePairs.reduce((a, b) => b[1] < a[1] ? b : a)
    console.log(JSON.stringify({ mode, amount, rate: sampleRate,
      hardLeftMinNearFarDb: imageMin.map(x => +x.toFixed(2)) }))
    if (process.argv.includes('--assert-quality')) {
      const limit = amount === 0.7 ? -7 : -8
      if (minimum[1] < limit) throw new Error(`${mode} ${sampleRate} Hz 强度 ${amount} 在 ${minimum[0].toFixed(0)} Hz 下陷 ${minimum[1].toFixed(1)} dB，目标 ≥${limit} dB`)
      if (maximum[1] > 5) throw new Error(`${mode} ${sampleRate} Hz 强度 ${amount} 在 ${maximum[0].toFixed(0)} Hz 抬升 ${maximum[1].toFixed(1)} dB，目标 ≤5 dB`)
      if (imageMin[1] < 4) throw new Error(`${mode} ${sampleRate} Hz 强度 ${amount} 在 ${imageMin[0].toFixed(0)} Hz 硬左输入的左右差仅 ${imageMin[1].toFixed(1)} dB，目标 ≥4 dB`)
    }
  }
}
