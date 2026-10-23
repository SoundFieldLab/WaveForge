// Hidden, silent, isolated Electron Host -> DSP -> capture graph.
// node scripts/probes/electron-spatial-completion.cjs --rate=192000 [--script-fallback] [--require-deadline]
// --script-only tests actual ScriptProcessor fallback; --compile-only builds without launching Electron.
const path = require('node:path')
const fs = require('node:fs')
const root = path.resolve(__dirname, '../..')
const args = process.argv.slice(2)
const rateIndex = args.indexOf('--rate')
const rateArg = args.find(value => value.startsWith('--rate='))?.slice(7) ?? (rateIndex >= 0 ? args[rateIndex + 1] : undefined)
const rate = Number(rateArg ?? 48000)
const scenarioName = args.find(value => value.startsWith('--scenario='))?.slice(11)
const label = args.find(value => value.startsWith('--label='))?.slice(8)
if (label && !/^[a-zA-Z0-9_-]{1,64}$/.test(label)) throw new Error('invalid evidence label')
const workletFile = args.find(value => value.startsWith('--worklet-file='))?.slice(15)
const workletPath = path.resolve(root, workletFile ?? 'public/v3-worklet.js')
const relativeWorklet = path.relative(root, workletPath)
if (path.isAbsolute(relativeWorklet) || relativeWorklet === '..' || relativeWorklet.startsWith(`..${path.sep}`))
  throw new Error('worklet file must stay inside the independent snapshot')
if (scenarioName && !/^[a-z0-9-]+$/.test(scenarioName)) throw new Error('invalid scene name')
if (![44100, 48000, 96000, 192000].includes(rate)) throw new Error('rate must be 44100, 48000, 96000 or 192000')

function bundle() {
  return require('esbuild').buildSync({
    entryPoints: [path.join(__dirname, 'spatial-completion-scenarios.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife', target: 'chrome130',
  }).outputFiles[0].text
}

function fixture(sampleRate) {
  const channels = 6, frames = Math.ceil(sampleRate / 4), align = channels * 4
  const bytes = Buffer.alloc(68 + frames * align)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(40, 16); bytes.writeUInt16LE(0xfffe, 20); bytes.writeUInt16LE(channels, 22)
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * align, 28)
  bytes.writeUInt16LE(align, 32); bytes.writeUInt16LE(32, 34); bytes.writeUInt16LE(22, 36)
  bytes.writeUInt16LE(32, 38); bytes.writeUInt32LE(0x3f, 40); bytes.writeUInt32LE(3, 44)
  Buffer.from([0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]).copy(bytes, 48)
  bytes.write('data', 60); bytes.writeUInt32LE(frames * align, 64)
  for (let i = 0; i < frames; i++) for (let channel = 0; channel < channels; channel++) {
    const cycles = Math.max(1, Math.round((240 + channel * 173) * frames / sampleRate))
    const value = i === 0 ? (channel + 1) / 64 : Math.sin(2 * Math.PI * cycles * i / frames) * 0.025
    bytes.writeFloatLE(value, 68 + (i * channels + channel) * 4)
  }
  return bytes
}

if (args.includes('--compile-only')) {
  const output = bundle()
  console.log(JSON.stringify({ status: 'compiled-only', bytes: Buffer.byteLength(output), requestedRate: rate }))
} else if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename, ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  const timeout = setTimeout(() => { child.kill(); console.error('spatial completion probe exceeded 45 seconds'); process.exitCode = 1 }, 45000)
  child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1 })
  child.on('exit', code => { clearTimeout(timeout); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow } = require('electron')
  const { createServer } = require('node:http')
  const { tmpdir } = require('node:os')
  const outputDir = path.join(root, '.verification/spatial-completion-20261019')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `worklet-${rate}${scenarioName ? `-${scenarioName}` : ''}${label ? `-${label}` : ''}.json`)
  const fixturePath = path.join(outputDir, `fixture-six-channel-${rate}.wav`)
  fs.writeFileSync(fixturePath, fixture(rate))
  app.setPath('userData', fs.mkdtempSync(path.join(tmpdir(), 'hse-completion-')))
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  const renderer = bundle(), worklet = fs.readFileSync(workletPath)
  const captureScript = `class CompletionCapture extends AudioWorkletProcessor {
    constructor(options) {
      super(); this.target = options.processorOptions.frames; this.compare = options.processorOptions.compare;
      this.frames = 0; this.bad = 0; this.peak = 0; this.nonzero = 0; this.energy = 0;
      this.maxDifference = 0; this.comparedSamples = 0; this.done = false; this.channelCounts = new Set();
      this.firstNonzero = [-1, -1, -1]; this.firstSamples = [[], [], []];
      this.traces = [[], [], []]; this.traceStarted = false;
      this.differenceEvent = null; this.missingComparisonSamples = 0; this.maxDifferenceByChannel = [0,0];
      this.maxRawDifferenceA = 0; this.maxRawDifferenceB = 0;
      this.nextCheckpoint = sampleRate / 5;
    }
    process(inputs, outputs) {
      for (const channel of outputs[0] || []) channel.fill(0);
      if (this.done) return true;
      const channels = inputs[0] || []; const count = outputs[0][0].length;
      this.channelCounts.add(channels.length);
      for (let input = 0; input < inputs.length; input++) {
        const plane = inputs[input] && inputs[input][0];
        if (!plane) continue;
        for (let i = 0; i < count; i++) if (Math.abs(plane[i]) > 1e-7) {
          if (this.firstNonzero[input] < 0) this.firstNonzero[input] = this.frames + i;
          this.traceStarted = true;
          break;
        }
        if (this.firstNonzero[input] >= 0 && this.firstSamples[input].length < 24)
          for (let i = Math.max(0,this.firstNonzero[input]-this.frames); i < count && this.firstSamples[input].length < 24; i++) this.firstSamples[input].push(plane[i]);
      }
      if (this.compare && this.traceStarted) for (let input = 0; input < inputs.length; input++) {
        const plane = inputs[input] && inputs[input][0];
        for (let i = 0; i < count && this.traces[input].length < 8192; i++) this.traces[input].push(plane ? plane[i] : 0);
      }
      for (let channel = 0; channel < channels.length; channel++) for (let i = 0; i < count; i++) {
        const sample = channels[channel][i];
        if (!Number.isFinite(sample)) this.bad++;
        else { this.peak = Math.max(this.peak, Math.abs(sample)); this.energy += sample * sample; if (Math.abs(sample) > 1e-7) this.nonzero++; }
        if (this.compare) {
          const other = inputs[1] && inputs[1][channel] ? inputs[1][channel][i] : 0;
          if (!(inputs[1] && inputs[1][channel])) this.missingComparisonSamples++;
          if (!Number.isFinite(other)) this.bad++;
          if (inputs[2] && inputs[2][channel]) {
            const raw = inputs[2][channel][i];
            this.maxRawDifferenceA = Math.max(this.maxRawDifferenceA,Math.abs(sample-raw));
            this.maxRawDifferenceB = Math.max(this.maxRawDifferenceB,Math.abs(other-raw));
          }
          const difference = Math.abs(sample - other);
          if (difference > this.maxDifference) this.differenceEvent = {
            frame: this.frames+i, channel, sample, other, counts: inputs.map(port=>port.length),
            raw: inputs[2] && inputs[2][channel] ? inputs[2][channel][i] : null
          };
          this.maxDifferenceByChannel[channel] = Math.max(this.maxDifferenceByChannel[channel] || 0,difference);
          this.maxDifference = Math.max(this.maxDifference, Math.abs(sample - other)); this.comparedSamples++;
        }
      }
      this.frames += count;
      if (this.frames >= this.nextCheckpoint && this.frames < this.target) {
        this.port.postMessage({ type: 'checkpoint', frames: this.frames, peak: this.peak, nonzero: this.nonzero, bad: this.bad });
        this.nextCheckpoint += sampleRate / 5;
      }
      if (this.frames >= this.target) {
        this.done = true;
        this.port.postMessage({ frames: this.frames, bad: this.bad, peak: this.peak, nonzero: this.nonzero,
          energy: this.energy, maxDifference: this.maxDifference, comparedSamples: this.comparedSamples,
          firstNonzero: this.firstNonzero, firstSamples: this.firstSamples, traces: this.compare ? this.traces.slice(0, inputs.length) : [],
          differenceEvent: this.differenceEvent, missingComparisonSamples: this.missingComparisonSamples, maxDifferenceByChannel: this.maxDifferenceByChannel,
          maxRawDifferenceA: this.maxRawDifferenceA, maxRawDifferenceB: this.maxRawDifferenceB,
          channelCounts: Array.from(this.channelCounts), captureOutput: 'silence' });
      }
      return true;
    }
  }; registerProcessor('hse-completion-capture', CompletionCapture);`
  const server = createServer((request, response) => {
    const resources = {
      '/v3-worklet.js': ['text/javascript', worklet],
      '/completion-capture.js': ['text/javascript', captureScript],
      '/scenarios.js': ['text/javascript', renderer],
      '/fixture-six-channel.wav': ['audio/wav', fs.readFileSync(fixturePath)],
      '/': ['text/html', '<meta charset="utf-8"><title>HSE spatial completion probe</title><script src="/scenarios.js"></script>'],
    }
    const resource = resources[request.url]
    if (!resource) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': resource[0], 'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' })
    response.end(resource[1])
  })
  let window
  const checkpoints = []
  function recordCheckpoint(checkpoint) {
    checkpoints.push({ measuredAt: new Date().toISOString(), ...checkpoint })
    fs.writeFileSync(outputPath, JSON.stringify({ status: 'in-progress', requestedRate: rate, checkpoints }, null, 2))
    console.log(JSON.stringify(checkpoint))
  }
  const stop = code => { server.close(); window?.destroy(); app.exit(code) }
  app.whenReady().then(async () => {
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      window = new BrowserWindow({ show: false, webPreferences: {
        nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
      } })
      window.webContents.setAudioMuted(true)
      window.webContents.on('console-message', (_event, ...values) => {
        const message = values.map(value => typeof value === 'string' ? value : value?.message).find(value =>
          typeof value === 'string' && value.startsWith('HSE_COMPLETION_PROGRESS:'))
        if (message) {
          try { recordCheckpoint(JSON.parse(message.slice('HSE_COMPLETION_PROGRESS:'.length))) } catch {}
        }
      })
      recordCheckpoint({ scene: scenarioName ?? 'all', stage: 'electron-window-created' })
      await window.loadURL(`http://127.0.0.1:${server.address().port}/`)
      const budget = args.find(value => value.startsWith('--budget='))?.slice(9) ?? 'quality'
if (!['quality', 'auto', 'lowLatency'].includes(budget)) throw new Error('budget must be quality, auto or lowLatency')
const options = { rate, scriptFallback: args.includes('--script-fallback'), scriptOnly: args.includes('--script-only'), scenario: scenarioName, budget }
      const result = await window.webContents.executeJavaScript(`runSpatialCompletion(${JSON.stringify(options)})`)
      const failures = []
      for (const stage of result.stages) {
        if (stage.sampleRate !== rate || stage.state !== 'running' || stage.errors.length || stage.pcm.bad ||
          stage.pcm.frames < rate / 2 || stage.pcm.peak < 1e-7 || !stage.pcm.nonzero) failures.push(`${stage.name}: invalid or silent PCM`)
        if (stage.mode === 'worklet' && (!stage.timing.callbacks || !stage.timing.inputChannelCounts.includes(stage.expectedInputChannels)))
          failures.push(`${stage.name}: actual Worklet input count not proven`)
        if (stage.scriptTiming && (!stage.scriptTiming.callbacks || stage.scriptTiming.declaredInputChannels !== 16 ||
          stage.scriptTiming.requestedInputCapacity < 16 || !stage.scriptTiming.physicalInputCapacities.some(value => value >= 16) ||
          !stage.scriptTiming.consumedEngineChannels.includes(16)))
          failures.push(`${stage.name}: actual ScriptProcessor sixteen-input path not proven`)
        if (stage.name === 'zero-amount-ab' && (!stage.pcm.comparedSamples || stage.pcm.maxDifference !== 0 ||
          stage.pcm.missingComparisonSamples || stage.pcm.maxRawDifferenceA !== 0 || stage.pcm.maxRawDifferenceB !== 0))
          failures.push(`${stage.name}: PCM A/B differs`)
        if (stage.name === 'spectral-early' && (!stage.spectralPreparation?.preparedSpeakers ||
          stage.pcm.maxDifference < 1e-7)) failures.push(`${stage.name}: spectral preparation or spectral/cues PCM difference missing`)
        if (stage.name === 'same-tick-params-headpose' && stage.sameTickUpdates !== 3)
          failures.push(`${stage.name}: combined parameter update missing`)
        if (stage.name === 'same-tick-params-headpose' && (stage.hrtfReplacements !== 2 ||
          !stage.preparedMessages.some(value => value.type === 'spatial-hrtf') ||
          !stage.preparedMessages.some(value => value.type === 'head-pose') ||
          !stage.preparedMessages.some(value => value.type === 'params')))
          failures.push(`${stage.name}: HRTF replacement or same-frame prepared payload not observed`)
        if (stage.name === 'actual-wav-decode-six-channel' && !stage.fileEvidence) failures.push(`${stage.name}: file decode missing`)
      }
      const workletStages = result.stages.filter(stage => stage.mode === 'worklet')
      const measured = result.stages.length > 0 && result.stages.every(stage =>
        stage.mode === 'worklet' ? stage.timing.callbacks > 0 : stage.scriptTiming?.callbacks > 0)
      const overruns = result.stages.reduce((sum, stage) => sum +
        (stage.mode === 'worklet' ? stage.timing.overruns : stage.scriptTiming?.overruns ?? 0), 0)
      const highResolution = workletStages.every(stage => stage.timing.clock === 'performance')
      const deadlineStatus = !measured ? 'not-measured' :
        overruns ? 'over-budget' : highResolution ? 'no-overrun-observed' : 'no-overrun-observed-clock-limited'
      if (args.includes('--require-deadline') && deadlineStatus !== 'no-overrun-observed')
        failures.push(`deadline: ${deadlineStatus}`)
      const report = { measuredAt: new Date().toISOString(), electron: process.versions.electron, checkpoints,
        chrome: process.versions.chrome, fixturePath, outputPath, workletPath, ...result, deadlineStatus, failures }
      fs.writeFileSync(outputPath, JSON.stringify(report, null, 2))
      console.log(JSON.stringify(report, null, 2))
      stop(failures.length ? 1 : 0)
    } catch (error) {
      const report = { measuredAt: new Date().toISOString(), requestedRate: rate, status: 'failed', checkpoints, error: String(error.stack || error) }
      fs.writeFileSync(outputPath, JSON.stringify(report, null, 2)); console.error(report.error); stop(1)
    }
  }).catch(error => { console.error(error); stop(1) })
}
