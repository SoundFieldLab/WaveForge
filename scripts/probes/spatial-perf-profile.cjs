// node scripts/probes/spatial-perf-profile.cjs [--scene=hoa3|spectral|same-tick|all] [--profile]
// 离线 Node 微基准；真实设备 deadline 仍由 electron-spatial-completion.cjs 验证。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const args = process.argv.slice(2)
function value(name, fallback) { return args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback }
function integer(name, fallback, min, max) {
  const number = Number(value(name, fallback))
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`invalid --${name}`)
  return number
}
const rate = integer('rate', 192000, 8000, 192000)
const scene = value('scene', 'all'), label = value('label', 'current')
if (!['all', 'hoa3', 'spectral', 'same-tick'].includes(scene)) throw new Error('invalid --scene')
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(label)) throw new Error('invalid --label')
const options = { rate, scene, blocks: integer('blocks', 3000, 1, 1000000), warmup: integer('warmup', 512, 0, 100000),
  updates: integer('updates', 12, 1, 10000), profile: args.includes('--profile') }
const directory = path.join(root, '.verification/spatial-perf-20261019')
fs.mkdirSync(directory, { recursive: true })
const bundlePath = path.join(directory, 'spatial-perf-profile.bundle.cjs')
if (!args.includes('--child')) {
  require('esbuild').buildSync({ entryPoints: [path.join(__dirname, 'spatial-perf-profile.ts')], outfile: bundlePath,
    bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, keepNames: true })
  if (args.includes('--compile-only')) console.log(JSON.stringify({ compiled: bundlePath, bytes: fs.statSync(bundlePath).size }))
  else for (const selected of scene === 'all' ? ['hoa3', 'spectral', 'same-tick'] : [scene]) {
    // 每场景新进程，避免其他场景的 JIT/GC 状态冒充冷启；Root 可串行运行整个命令。
    const childArgs = args.filter(arg => !arg.startsWith('--scene='))
    const child = spawnSync(process.execPath, [__filename, ...childArgs, `--scene=${selected}`, '--child'], {
      cwd: root, stdio: 'inherit', windowsHide: true, timeout: 300000 })
    if (child.error) throw child.error
    if (child.status !== 0) { process.exitCode = child.status || 1; break }
  }
} else {
  globalThis.sampleRate = rate
  globalThis.AudioWorkletProcessor = class {
    constructor() { this.port = { onmessage: null, postMessage() {} } }
  }
  const { run } = require(bundlePath)
  const engineModule = value('engine-module', null)
  const implementation = engineModule ? import(require('node:url').pathToFileURL(path.resolve(root, engineModule)).href) : Promise.resolve(undefined)
  implementation.then(module => run(options, module)).then(({ result, profiles }) => {
    const prefix = `${label}-${scene}-${rate}${options.profile ? '-profiled' : ''}`
    const reportPath = path.join(directory, `${prefix}.json`)
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2))
    for (const [phase, profile] of Object.entries(profiles))
      fs.writeFileSync(path.join(directory, `${prefix}-${phase}.cpuprofile`), JSON.stringify(profile))
    console.log(JSON.stringify({ report: reportPath, scene, rate, pcm: result.pcm,
      coldMs: result.cold.elapsedMs, firstMs: result.first.value.callbackMs,
      steady: result.steady.value.callbackMs, updates: result.updates?.value.callbackMs }))
    if (result.pcm.badPcm || !result.pcm.nonzeroSamples) process.exitCode = 1
  }).catch(error => { console.error(error); process.exitCode = 1 })
}
