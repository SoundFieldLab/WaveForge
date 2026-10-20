import { build } from 'esbuild'

const root = new URL('../../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
const bundle = await build({
  stdin: {
    contents: `export { EngineV3 } from './src/services/waveforge-engine-v3/src/engine/EngineV3.ts';
      export { createDefaultParams } from './src/services/waveforge-engine-v3/src/types.ts';`,
    resolveDir: root,
    sourcefile: 'spatial-quality-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { EngineV3, createDefaultParams } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
)

if (process.argv.includes('--diagnose')) {
  for (const amount of [0, 1]) {
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.eq.enabled = false
    params.limiter.enabled = false
    params.spatial.mode = 'instant'
    params.spatial.instant.amount = amount
    params.spatial.instant.room = 'off'
    params.spatial.instant.roomAmount = 0
    engine.setParams(params)
    const input = new Float32Array(2048)
    input[0] = 0.2
    const outL = new Float32Array(input.length)
    const outR = new Float32Array(input.length)
    engine.process([input, input], [outL, outR])
    const peaks = Array.from(outL, (v, i) => ({ i, v: Math.abs(v) }))
      .sort((a, b) => b.v - a.v).slice(0, 8)
    console.log(JSON.stringify({ amount, peaks }))
  }
  process.exit(0)
}

const fs = Number(process.argv.find(arg => arg.startsWith('--rate='))?.slice(7) ?? 48000)
const mode = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7) ?? 'instant'
const samples = Math.round(8192 * fs / 48000)
const steadyStart = Math.round(3072 * fs / 48000)
const frequencies = [125, 250, 500, 1000, 2000, 4000, 8000, 12000]

function render(freq, amount, channel = 'mono') {
  const engine = new EngineV3(fs)
  const params = createDefaultParams(fs)
  params.eq.enabled = false
  params.limiter.enabled = false
  params.spatial.mode = amount === null ? 'off' : mode
  params.spatial.instant.amount = amount ?? 0
  params.spatial.instant.room = 'off'
  params.spatial.instant.roomAmount = 0
  params.spatial.stage.reverbAmount = 0
  engine.setParams(params)
  const input = Float32Array.from({ length: samples }, (_, i) => 0.2 * Math.sin(2 * Math.PI * freq * i / fs))
  const silence = new Float32Array(samples)
  const outL = new Float32Array(samples)
  const outR = new Float32Array(samples)
  engine.process([input, channel === 'mono' ? input : silence], [outL, outR])
  let left = 0, right = 0, mid = 0, side = 0
  for (let i = steadyStart; i < samples; i++) {
    left += outL[i] ** 2
    right += outR[i] ** 2
    mid += ((outL[i] + outR[i]) / 2) ** 2
    side += ((outL[i] - outR[i]) / 2) ** 2
  }
  return { left: Math.sqrt(left), right: Math.sqrt(right), mid: Math.sqrt(mid), side: Math.sqrt(side) }
}

const db = value => 20 * Math.log10(Math.max(value, 1e-10))
for (const amount of [0.35, 0.7, 1]) {
  const rows = frequencies.map(freq => {
    const base = render(freq, null)
    const spatial = render(freq, amount)
    const hardLeft = render(freq, amount, 'left')
    return {
      hz: freq,
      monoMidDb: +(db(spatial.mid / base.mid)).toFixed(1),
      monoSideDb: +(db(spatial.side / Math.max(spatial.mid, 1e-10))).toFixed(1),
      hardLeftNearFarDb: +(db(hardLeft.left / hardLeft.right)).toFixed(1),
    }
  })
  console.log(JSON.stringify({ amount, rows }, null, 2))
  if (process.argv.includes('--assert-quality') && (amount === 0.7 || amount === 1)) {
    const middle = rows.filter(row => row.hz >= 500 && row.hz <= 12000)
    const worst = Math.min(...middle.map(row => row.monoMidDb))
    const limit = amount === 0.7 ? -7 : -8
    if (worst < limit) throw new Error(`空间强度 ${amount} 使音乐频段单声道下陷 ${worst} dB（目标不低于 ${limit} dB）`)
  }
}
