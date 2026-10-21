import { build } from 'esbuild'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const result = await build({
  stdin: {
    contents: `export { BinauralConvolver } from './src/services/waveforge-engine-v3/src/spatial/BinauralConvolver.ts';
      export { createMeasuredHrtfGrid } from './src/services/waveforge-engine-v3/src/spatial/measuredHrtf.ts';`,
    resolveDir: root,
    sourcefile: 'binaural-partition-benchmark-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { BinauralConvolver, createMeasuredHrtfGrid } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`
)

const fs = Number(process.argv.find(arg => arg.startsWith('--rate='))?.slice(7) ?? 96000)
const partition = Number(process.argv.find(arg => arg.startsWith('--partition='))?.slice(12) ?? 512)
if (![44100, 48000, 96000].includes(fs) || ![128, 256, 512].includes(partition)) {
  throw new Error('rates: 44100/48000/96000; partitions: 128/256/512')
}
const grid = createMeasuredHrtfGrid(fs)
const convolvers = Array.from({ length: 13 }, (_, i) => {
  const convolver = new BinauralConvolver(partition)
  const base = i * 23 * grid.hrirLength
  convolver.loadIR(
    grid.left.subarray(base, base + grid.hrirLength),
    grid.right.subarray(base, base + grid.hrirLength),
  )
  return convolver
})
const left = convolvers.map(() => new Float32Array(128))
const right = convolvers.map(() => new Float32Array(128))
const source = Float32Array.from({ length: 128 }, (_, i) => 0.2 * Math.sin(i * 0.13))
const times = []
for (let call = 0; call < 1400; call++) {
  const start = performance.now()
  for (let s = 0; s < convolvers.length; s++) {
    left[s].set(source)
    right[s].set(source)
    convolvers[s].processStereo(left[s], right[s])
  }
  if (call >= 200) times.push(performance.now() - start)
}
times.sort((a, b) => a - b)
const at = p => times[Math.min(times.length - 1, Math.ceil(times.length * p) - 1)]
console.log(JSON.stringify({
  fs, partition, speakers: convolvers.length, hrirLength: grid.hrirLength,
  budgetMs: 128 / fs * 1000, medianMs: at(0.5), p95Ms: at(0.95),
  p99Ms: at(0.99), maxMs: times.at(-1),
}, null, 2))
