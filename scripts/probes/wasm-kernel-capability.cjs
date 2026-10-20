// HSE WASM SIMD128 复数乘法内核 —— 真实 AudioWorklet 能力探针
// 用法：node scripts/probes/wasm-kernel-capability.cjs [--count=8192] [--output=.verification/wasm-kernel-capability.json]
//
// 做什么：
//  1. 用 esbuild 把本快照的 wasmSimdKernel.ts 打包成单文件 Worklet 模块（WASM 二进制由 JS 常量 +
//     LEB128 编码器在运行时生成，不 fetch 任何外部 .wasm；探针会断言打包结果里没有外部引用）；
//  2. 在隐藏 Electron 窗口的真实 AudioWorkletGlobalScope 里注册处理器并实例化内核；
//  3. 在音频线程里跑一块复数乘法，与 TS 回退路径和标量参考逐样本对拍，并测单块耗时；
//  4. 输出 JSON：wasmAvailable / simdCompiled / kernelMatches / elapsed。
const path = require('node:path')
const root = path.resolve(__dirname, '../..')

if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  })
  const deadline = setTimeout(() => {
    child.kill()
    console.error('WASM kernel capability probe timed out')
    process.exitCode = 1
  }, 55000)
  child.on('error', error => { clearTimeout(deadline); console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { clearTimeout(deadline); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow } = require('electron')
  // 顶层构建/加载异常时立即退出，避免父进程空等超时
  process.on('uncaughtException', error => { console.error(error && error.message ? error.message : error); app.exit(1) })
  const { createServer } = require('node:http')
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const { buildSync } = require('esbuild')

  const countArg = Number(process.argv.find(arg => arg.startsWith('--count='))?.slice(8) ?? 8192)
  if (!Number.isFinite(countArg) || countArg < 4 || countArg > (1 << 20)) throw new Error('invalid --count')
  const count = Math.floor(countArg)

  app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'hse-wasm-kernel-probe-')))
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  // Worklet 处理器源码：在 AudioWorkletGlobalScope 内实例化内核、对拍并计时。
  const workletEntry = [
    "import { createComplexProductKernel } from './src/services/waveforge-engine-v3/src/dsp/vectorKernel.ts'",
    "import { isWasmSimdKernelAvailable, getComplexProductWasmModuleBytes, getWasmKernelViewAllocationCount } from './src/services/waveforge-engine-v3/src/dsp/wasmSimdKernel.ts'",
    '',
    'const COUNT = ' + count,
    '',
    'function makeRandom(seed) {',
    '  let state = seed >>> 0 || 0x9e3779b9',
    '  return () => {',
    '    state ^= state << 13; state >>>= 0',
    '    state ^= state >>> 17',
    '    state ^= state << 5; state >>>= 0',
    '    return state / 0xffffffff',
    '  }',
    '}',
    '',
    '// 标量参考：逐次单精度舍入（等价 f32x4 mul + add/sub）',
    'function scalarReference(xr, xi, hr, hi, outR, outI, n) {',
    '  for (let i = 0; i < n; i++) {',
    '    const a = xr[i], b = xi[i], c = hr[i], d = hi[i]',
    '    outR[i] = Math.fround(Math.fround(a * c) - Math.fround(b * d))',
    '    outI[i] = Math.fround(Math.fround(a * d) + Math.fround(b * c))',
    '  }',
    '}',
    '',
    'class WasmKernelProbe extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super()',
    '    this.report = null',
    '    this.reported = false',
    '    this.port.onmessage = (event) => { if (event.data && event.data.type === \'run\') this.report = this.runProbe() }',
    '  }',
    '',
    '  runProbe() {',
    '    const hasPerformance = typeof performance === \'object\' && typeof performance.now === \'function\'',
    '    const clock = hasPerformance ? () => performance.now() : () => Date.now()',
    '    let wasmAvailable = false',
    '    let simdCompiled = false',
    '    let detectionError = null',
    '    try {',
    '      wasmAvailable = isWasmSimdKernelAvailable() === true',
    '      const bytes = getComplexProductWasmModuleBytes()',
    '      simdCompiled = wasmAvailable && WebAssembly.validate(bytes) === true && bytes.length > 0',
    '    } catch (error) {',
    '      detectionError = String(error && error.message ? error.message : error)',
    '    }',
    '',
    '    const random = makeRandom(0x51d1234)',
    '    const xr = new Float32Array(COUNT), xi = new Float32Array(COUNT)',
    '    const hr = new Float32Array(COUNT), hi = new Float32Array(COUNT)',
    '    for (let i = 0; i < COUNT; i++) {',
    '      xr[i] = random() * 2 - 1; xi[i] = random() * 2 - 1',
    '      hr[i] = random() * 2 - 1; hi[i] = random() * 2 - 1',
    '    }',
    '    const simdR = new Float32Array(COUNT), simdI = new Float32Array(COUNT)',
    '    const tsR = new Float32Array(COUNT), tsI = new Float32Array(COUNT)',
    '    const refR = new Float32Array(COUNT), refI = new Float32Array(COUNT)',
    '',
    '    const simdKernel = createComplexProductKernel({ wasmThreshold: 1, wasmThresholdF64: 1 })',
    '    const tsKernel = createComplexProductKernel({ backend: \'typescript\' })',
    '    const simdOk = simdKernel.process(xr, xi, hr, hi, simdR, simdI, COUNT) === true',
    '    const tsOk = tsKernel.process(xr, xi, hr, hi, tsR, tsI, COUNT) === true',
    '    scalarReference(xr, xi, hr, hi, refR, refI, COUNT)',
    '',
    '    let mismatchesAgainstTs = 0',
    '    let mismatchesAgainstScalar = 0',
    '    for (let i = 0; i < COUNT; i++) {',
    '      if (!Object.is(simdR[i], tsR[i]) || !Object.is(simdI[i], tsI[i])) mismatchesAgainstTs++',
    '      if (!Object.is(simdR[i], refR[i]) || !Object.is(simdI[i], refI[i])) mismatchesAgainstScalar++',
    '    }',
    '',
    '    // f64x2 路径：与 JS double 参考逐位比较',
    '    const xr64 = new Float64Array(COUNT), xi64 = new Float64Array(COUNT)',
    '    const hr64 = new Float64Array(COUNT), hi64 = new Float64Array(COUNT)',
    '    for (let i = 0; i < COUNT; i++) { xr64[i] = xr[i]; xi64[i] = xi[i]; hr64[i] = hr[i]; hi64[i] = hi[i] }',
    '    const dR = new Float64Array(COUNT), dI = new Float64Array(COUNT)',
    '    const doubleOk = simdKernel.processDouble(xr64, xi64, hr64, hi64, dR, dI, COUNT) === true',
    '    let doubleMismatches = 0',
    '    for (let i = 0; i < COUNT; i++) {',
    '      if (!Object.is(dR[i], xr64[i] * hr64[i] - xi64[i] * hi64[i])) doubleMismatches++',
    '      if (!Object.is(dI[i], xr64[i] * hi64[i] + xi64[i] * hr64[i])) doubleMismatches++',
    '    }',
    '',
    '    const measure = (run) => {',
    '      for (let i = 0; i < 20; i++) run()',
    '      const samples = []',
    '      for (let round = 0; round < 5; round++) {',
    '        const started = clock()',
    '        for (let i = 0; i < 2000; i++) run()',
    '        samples.push((clock() - started) / 2000)',
    '      }',
    '      samples.sort((a, b) => a - b)',
    '      return samples[Math.floor(samples.length / 2)]',
    '    }',
    '    const simdMs = measure(() => simdKernel.process(xr, xi, hr, hi, simdR, simdI, COUNT))',
    '    const tsMs = measure(() => tsKernel.process(xr, xi, hr, hi, tsR, tsI, COUNT))',
    '    const beforeViews = getWasmKernelViewAllocationCount()',
    '    for (let i = 0; i < 100; i++) simdKernel.process(xr, xi, hr, hi, simdR, simdI, COUNT)',
    '    const viewAllocationsAfterWarmup = getWasmKernelViewAllocationCount() - beforeViews',
    '',
    '    return {',
    '      sampleRate,',
    '      count: COUNT,',
    '      clock: hasPerformance ? \'performance\' : \'date\',',
    '      wasmAvailable,',
    '      simdCompiled,',
    '      detectionError,',
    '      backend: simdKernel.backend,',
    '      kernelMatches: simdOk && tsOk && mismatchesAgainstTs === 0 && mismatchesAgainstScalar === 0,',
    '      mismatchesAgainstTs,',
    '      mismatchesAgainstScalar,',
    '      doublePath: { ok: doubleOk, mismatches: doubleMismatches },',
    '      viewAllocationsAfterWarmup,',
    '      elapsed: {',
    '        simdMsPerBlock: Number(simdMs.toFixed(5)),',
    '        tsMsPerBlock: Number(tsMs.toFixed(5)),',
    '        speedup: tsMs > 0 ? Number((tsMs / simdMs).toFixed(2)) : null,',
    '      },',
    '    }',
    '  }',
    '',
    '  process(inputs, outputs) {',
    '    const out = outputs[0]',
    '    if (out) for (const channel of out) channel.fill(0)',
    '    if (this.report && !this.reported) {',
    '      this.reported = true',
    '      this.port.postMessage(this.report)',
    '    }',
    '    return true',
    '  }',
    '}',
    "registerProcessor('hse-wasm-kernel-probe', WasmKernelProbe)",
  ].join('\n')

  const bundle = buildSync({
    stdin: { contents: workletEntry, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'iife', target: 'es2022',
  }).outputFiles[0].text

  // 内联检查：打包结果不得出现 .wasm 路径字面量（外部文件引用）或动态 import。
  // 源码注释里可能提到 ".wasm" 字样，因此只匹配字符串字面量中的路径。
  const wasmUrlLiterals = (bundle.match(/['"][^'"\n]*\.wasm['"]/g) || [])
  const inlineWasmConstant = wasmUrlLiterals.length === 0 && !/\bimport\s*\(/.test(bundle)
  const hasModuleBuilder = bundle.indexOf('complexProductF32') !== -1 && bundle.indexOf('WebAssembly') !== -1

  const html = '<!doctype html><meta charset="utf-8"><title>HSE wasm kernel probe</title>'
  const server = createServer((req, res) => {
    if (req.url === '/wasm-kernel-probe.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(bundle)
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    }
  })

  let window
  app.whenReady().then(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    window = new BrowserWindow({ show: false, webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
    } })
    try {
      await window.loadURL('http://127.0.0.1:' + server.address().port + '/')
      const pageScript = [
        '(async () => {',
        '  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: \'interactive\' })',
        '  await ctx.audioWorklet.addModule(\'/wasm-kernel-probe.js\')',
        '  const node = new AudioWorkletNode(ctx, \'hse-wasm-kernel-probe\', {',
        '    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],',
        '  })',
        '  const silent = ctx.createGain()',
        '  silent.gain.value = 0',
        '  node.connect(silent).connect(ctx.destination)',
        '  const errors = []',
        '  node.onprocessorerror = () => errors.push(\'processorerror\')',
        '  await ctx.resume()',
        '  const report = await new Promise((resolve, reject) => {',
        '    const timer = setTimeout(() => reject(new Error(\'worklet report timeout\')), 25000)',
        '    node.port.onmessage = event => { clearTimeout(timer); resolve(event.data) }',
        '    node.port.postMessage({ type: \'run\' })',
        '  })',
        '  await ctx.close()',
        '  return Object.assign({}, report, { errors })',
        '})()',
      ].join('\n')
      const result = await window.webContents.executeJavaScript(pageScript)
      const output = Object.assign({
        measuredAt: new Date().toISOString(),
        probe: 'wasm-kernel-capability',
        resolvedPath: 'worklet/AudioWorkletGlobalScope',
        inlineWasmConstant,
        wasmUrlLiterals,
        hasModuleBuilder,
        bundleBytes: Buffer.byteLength(bundle),
      }, result)
      console.log(JSON.stringify(output, null, 2))
      const outputArg = process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
      if (outputArg) {
        const outputPath = path.resolve(root, outputArg)
        if (!outputPath.startsWith(root + path.sep)) throw new Error('probe output must remain inside snapshot')
        mkdirSync(path.dirname(outputPath), { recursive: true })
        writeFileSync(outputPath, JSON.stringify(output, null, 2))
      }
      if (!output.wasmAvailable || !output.simdCompiled || !output.kernelMatches
        || !output.doublePath || !output.doublePath.ok || output.doublePath.mismatches !== 0
        || output.viewAllocationsAfterWarmup !== 0
        || !output.inlineWasmConstant || !output.hasModuleBuilder || output.errors.length) {
        throw new Error('WASM SIMD128 kernel capability validation failed')
      }
      console.log('WASM SIMD128 complex-product kernel passed inside a real AudioWorklet.')
      server.close(); window.destroy(); app.exit(0)
    } catch (error) {
      console.error(error.message); server.close(); window?.destroy(); app.exit(1)
    }
  }).catch(error => { console.error(error.message); app.exit(1) })
}
