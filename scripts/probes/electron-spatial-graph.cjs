// Real Electron AudioWorklet graph probe; the capture processor outputs silence.
// Usage: node scripts/probes/electron-spatial-graph.cjs --rate=96000
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
    console.error('Electron graph probe timed out')
    process.exitCode = 1
  }, 45000)
  child.on('error', error => { clearTimeout(deadline); console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { clearTimeout(deadline); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow } = require('electron')
  const { createServer } = require('node:http')
  const { readFileSync, mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const { buildSync } = require('esbuild')
  const fs = Number(process.argv.find(arg => arg.startsWith('--rate='))?.slice(7) ?? 48000)
  if (![44100, 48000, 96000].includes(fs)) throw new Error('unsupported sample rate')
  const budgetMode = process.argv.find(arg => arg.startsWith('--budget='))?.slice(9) ?? 'quality'
  if (!['quality', 'auto', 'lowLatency'].includes(budgetMode)) throw new Error('unsupported budget mode')
  app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'hse-graph-probe-')))
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  const paramsScript = buildSync({
    stdin: {
      contents: `import './examples/dc-blocker.ts';
        import { createDefaultParams } from './src/services/waveforge-engine-v3/src/types.ts';
        import { EngineV3Host } from './src/services/waveforge-engine-v3/src/integration/EngineV3Host.ts';
        globalThis.createProbeParams = createDefaultParams;
        globalThis.ProbeHost = EngineV3Host;`,
      resolveDir: root, loader: 'ts',
    }, bundle: true, write: false, format: 'iife',
  }).outputFiles[0].text
  const extensionScript = buildSync({ entryPoints: [path.join(root, 'examples/dc-blocker.ts')],
    bundle: true, write: false, format: 'iife' }).outputFiles[0].text
  const captureScript = `class Capture extends AudioWorkletProcessor {
    frames = 0; bad = 0; peak = 0; nonzero = 0; maxStep = 0; previous = [0, 0];
    process(inputs, outputs) {
      const channels = inputs[0] || [];
      const n = outputs[0][0].length;
      for (let c = 0; c < channels.length; c++) for (const x of channels[c]) {
        if (!Number.isFinite(x)) this.bad++;
        else { this.peak = Math.max(this.peak, Math.abs(x)); this.maxStep = Math.max(this.maxStep, Math.abs(x - (this.previous[c] || 0))); this.previous[c] = x; if (Math.abs(x) > 1e-5) this.nonzero++; }
      }
      this.frames += n;
      if (this.frames >= sampleRate / 4) {
        this.port.postMessage({ frames: this.frames, bad: this.bad, peak: this.peak, nonzero: this.nonzero, maxStep: this.maxStep });
        this.frames = 0; this.bad = 0; this.peak = 0; this.nonzero = 0; this.maxStep = 0;
      }
      for (const channel of outputs[0]) channel.fill(0);
      return true;
    }
  }; registerProcessor('hse-probe-capture', Capture);`
  // --source-worklet：直接从源码打包当前 worklet（不写 public/v3-worklet.js），
  // 便于并行代理在 lead 统一重建产物前测量最新代码。
  const worklet = process.argv.includes('--source-worklet')
    ? buildSync({
      entryPoints: [path.join(root, 'src/services/waveforge-engine-v3/src/worklet/AudioEffectsProcessor.ts')],
      bundle: true, format: 'iife', minify: true, write: false,
      banner: { js: '// probe source worklet (not the public bundle)' },
    }).outputFiles[0].text
    : readFileSync(path.join(root, 'public/v3-worklet.js'))
  const server = createServer((req, res) => {
    if (req.url === '/v3-worklet.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(worklet)
    } else if (req.url === '/dc-blocker.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(extensionScript)
    } else if (req.url === '/capture.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(captureScript)
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<meta charset="utf-8"><title>HSE graph probe</title><script>${paramsScript}</script>`)
    }
  })
  let window
  app.whenReady().then(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    window = new BrowserWindow({ show: false, webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
    } })
    try {
      await window.loadURL(`http://127.0.0.1:${server.address().port}/`)
      const result = await window.webContents.executeJavaScript(`(async () => {
        const ctx = new AudioContext({ sampleRate: ${fs}, latencyHint: 'interactive' });
        const errors = [];
        const stages = [];
        let currentStage;
        let stageStartedAt = 0;
        let stats = 0;
        let invalidStats = 0;
        const timing = { clock: 'unavailable', resolutionMs: null, callbacks: 0, overruns: 0, maxProcessMs: null, maxConfigMs: null, maxDspMs: null, blockBudgetMs: 128 / ctx.sampleRate * 1000 };
        // 超预算归因与配置工作量计数（worklet 每 stats 窗口回传；这里累加）。
        const TIMING_COUNTERS = ['overrunConfig', 'overrunSteady', 'configCallbacks', 'preparedIrCallbacks',
          'hrtfCallbacks', 'poseCallbacks', 'resetCallbacks', 'paramsApplied', 'poseUpdates', 'roomHrirItems',
          'hrtfLoads', 'spatialConfigs', 'preparedIrLoads', 'localIrLoads',
          'spatialConfigMs', 'reverbConfigMs', 'blockConfigMs', 'maxBlockConfigMs',
          'directPreparedHits', 'directPreparedMisses', 'preparedSpeakerIrs', 'localSpeakerIrs',
          'roomPreparedHits', 'roomPreparedMisses', 'roomRebuilds', 'convolverInstances',
          'preparedPrimes', 'preparedEntries'];
        for (const key of TIMING_COUNTERS) timing[key] = 0;
        const inputChannelCounts = new Set();
        const steadyTiming = { collectionStartsAfterMs: 500, callbacks: 0, overruns: 0, maxProcessMs: 0, maxConfigMs: 0, maxDspMs: 0 };
        for (const key of TIMING_COUNTERS) steadyTiming[key] = 0;
        await ctx.audioWorklet.addModule('/v3-worklet.js');
        await ctx.audioWorklet.addModule('/capture.js');
        if (${process.argv.includes('--probe-nodes') && process.argv.includes('--direct-worklet')}) await ctx.audioWorklet.addModule('/dc-blocker.js');
        const capture = new AudioWorkletNode(ctx, 'hse-probe-capture', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        });
        const inputChannelCount = ${process.argv.includes('--stereo-input') ? 2 : 6};
        const merger = ctx.createChannelMerger(inputChannelCount);
        const params = createProbeParams(ctx.sampleRate);
        params.spatial.instant.room = 'hall'; params.spatial.instant.roomAmount = 0.5;
        params.spatial.instant.multichannelAuto = inputChannelCount > 2;
        params.spatial.instant.multichannelLayout = ${JSON.stringify(process.argv.includes('--auto-layout') ? 'auto' : '51')};
        params.spatial.budgetMode = ${JSON.stringify(budgetMode)};
        params.spatial.hrtfInterp = 'spherical';
        params.spatial.headLocked.layout = '714';
        const direct = ${process.argv.includes('--direct-worklet')};
        const host = new ProbeHost({ mode: 'worklet', workletUrl: '/v3-worklet.js',
          processingModuleUrls: ${JSON.stringify(process.argv.includes('--probe-nodes') ? ['/dc-blocker.js'] : [])} });
        let engine;
        if (direct) {
          engine = new AudioWorkletNode(ctx, 'waveforge-v3-effects', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
            channelCount: 32, channelCountMode: 'max', channelInterpretation: 'discrete',
          });
          merger.connect(engine).connect(capture);
        } else {
          // --channel-hint：模拟真实适配层在 attach 时声明输入声道数，让控制线程预准备与
          // 渲染线程实际声道数一致（避免首次空间配置因声道数未知而走本地 HRIR 重算）。
          const hostHandle = { audioContext: ctx, masterGain: merger, analyser: capture };
          if (false) hostHandle.inputChannels = inputChannelCount;
          await host.attach(hostHandle, params);
          engine = host.getAudioNode();
        }
        if (${process.argv.includes('--probe-nodes')}) {
          const config = { id: 'probe-composition', kind: 'chain', nodes: [
            { id: 'matrix', kind: 'matrix', ll: 0.9, lr: 0.1, rl: 0.1, rr: 0.9 },
            { id: 'fir', kind: 'fir', coefficients: [0.7, 0.2, 0.1] },
            { id: 'delay', kind: 'delay', samples: 17 },
            { id: 'shape', kind: 'waveshaper', drive: 1.5, mix: 0.15 },
            { id: 'dc', kind: 'custom', type: 'example/dc-blocker', data: { cutoffHz: 20 } },
          ] };
          if (direct) engine.port.postMessage({ type: 'register-node', config });
          else host.registerSerializableProcessingNode(config);
        }
        const sendParams = () => direct ? engine.port.postMessage({ type: 'params', params }) : host.setParams(params);
        engine.onprocessorerror = () => errors.push('engine processorerror');
        capture.onprocessorerror = () => errors.push('capture processorerror');
        engine.port.onmessage = event => {
          if (event.data.type === 'stats') {
            stats++;
            if (stats > 20 && !Number.isFinite(event.data.stats.lufsIntegrated)) invalidStats++;
            const t = event.data.timing;
            if (Number.isInteger(event.data.inputChannels)) inputChannelCounts.add(event.data.inputChannels);
            if (t && t.callbacks > 0) {
              timing.clock = t.clock; timing.resolutionMs = t.resolutionMs;
              timing.callbacks += t.callbacks;
              timing.overruns += t.overruns;
              timing.maxProcessMs = Math.max(timing.maxProcessMs || 0, t.maxProcessMs);
              timing.maxConfigMs = Math.max(timing.maxConfigMs || 0, t.maxConfigMs);
              timing.maxDspMs = Math.max(timing.maxDspMs || 0, t.maxDspMs);
              for (const key of TIMING_COUNTERS) {
                if (typeof t[key] === 'number') timing[key] += t[key];
              }
              const inStage = currentStage && performance.now() - stageStartedAt > 500;
              if (currentStage && typeof t.maxConfigMs === 'number') {
                currentStage.maxConfigMs = Math.max(currentStage.maxConfigMs || 0, t.maxConfigMs);
                currentStage.maxDspMs = Math.max(currentStage.maxDspMs || 0, t.maxDspMs);
                for (const key of TIMING_COUNTERS) {
                  if (typeof t[key] === 'number') currentStage[key] = (currentStage[key] || 0) + t[key];
                }
              }
              if (inStage) {
                steadyTiming.callbacks += t.callbacks; steadyTiming.overruns += t.overruns;
                steadyTiming.maxProcessMs = Math.max(steadyTiming.maxProcessMs, t.maxProcessMs);
                steadyTiming.maxConfigMs = Math.max(steadyTiming.maxConfigMs, t.maxConfigMs);
                steadyTiming.maxDspMs = Math.max(steadyTiming.maxDspMs, t.maxDspMs);
                for (const key of TIMING_COUNTERS) {
                  if (typeof t[key] === 'number') steadyTiming[key] += t[key];
                }
              }
            }
          }
        };
        capture.port.onmessage = event => {
          if (!currentStage) return;
          const m = event.data;
          currentStage.frames += m.frames; currentStage.bad += m.bad;
          currentStage.peak = Math.max(currentStage.peak, m.peak);
          currentStage.nonzero += m.nonzero;
          currentStage.maxStep = Math.max(currentStage.maxStep || 0, m.maxStep || 0);
        };
        const sources = [];
        for (let channel = 0; channel < inputChannelCount; channel++) {
          const source = ctx.createOscillator(); source.frequency.value = 997 + channel * 173;
          const gain = ctx.createGain(); gain.gain.value = channel === 3 ? 0 : 0.025;
          source.connect(gain).connect(merger, 0, channel); sources.push(source);
        }
        capture.connect(ctx.destination);
        for (const source of sources) source.start(); await ctx.resume();
        for (const mode of ['instant', 'headLocked', 'world', 'stage']) {
          currentStage = { mode, frames: 0, bad: 0, peak: 0, nonzero: 0, updates: 0 };
          stageStartedAt = performance.now();
          stages.push(currentStage); params.spatial.mode = mode;
          sendParams();
          let timer;
          if (mode === 'world') {
            params.spatial.world.propagation = true;
            let tick = 0;
            timer = setInterval(() => {
              params.spatial.world.listener.yaw = 20 * Math.sin(tick++ * 0.03);
              sendParams();
              currentStage.updates++;
            }, 1000 / 60);
          }
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (timer) clearInterval(timer);
        }
        const smoothingStages = [];
        if (${process.argv.includes('--probe-smoothing')}) {
          params.spatial.mode = 'off'; params.eq.enabled = true;
          const changes = [
            ['dynamics', () => {
              params.compressor.enabled = true; params.compressor.thresholdDb = -35; params.compressor.makeupDb = 8;
              params.deesser.enabled = true; params.deesser.centerHz = 2500; params.deesser.thresholdDb = -45;
              params.bassEnhancer.enabled = true; params.bassEnhancer.lowBoostDb = 8;
              params.eq.proBands[3].gain = -12; params.eq.qCompensation = false;
            }],
            ['topology', () => {
              params.compressor.mode = 'multiband'; params.compressor.multiband.lowMidHz = 400;
              params.eq.bandCount = 1; params.eq.proBands = [{ frequency: 2000, gain: 0, q: 2, type: 'highpass' }];
              params.eq.qCompensation = true; params.stereoWidth = 2;
              params.crossfeed.enabled = true; params.crossfeed.amount = 1;
              params.surround3d.enabled = true; params.surround3d.angle = 120;
            }],
            ['reverb', () => {
              params.reverb.enabled = true; params.reverb.mode = 'algorithmic';
              params.reverb.algorithmic.type = 'spring'; params.reverb.algorithmic.preDelayMs = 20;
              params.nightMode.enabled = true; params.nightMode.amount = 8;
              params.loudnessCompensation.enabled = true; params.loudnessCompensation.mode = 'preset'; params.loudnessCompensation.preset = 'bright';
              params.ieq.enabled = true; params.ieq.targetCurve = 'bright'; params.ieq.strength = 1;
            }],
            ['convolution', () => {
              params.reverb.mode = 'convolution'; params.reverb.convolution.partitionSize = 128;
              params.reverb.convolution.ir = Float32Array.from([0.5, 0.3, 0.1]);
              params.reverb.convolution.preDelayMs = 8; params.reverb.convolution.mix = 0.6;
              params.limiter.lookaheadMs = 20; params.limiter.thresholdDb = -10; params.limiter.truePeak = false;
              params.subsonicEnabled = true; params.subsonicCutoffHz = 40;
            }],
            ['disable', () => {
              params.eq.enabled = params.compressor.enabled = params.deesser.enabled = params.bassEnhancer.enabled = false;
              params.reverb.enabled = params.nightMode.enabled = params.loudnessCompensation.enabled = params.ieq.enabled = false;
              params.crossfeed.enabled = params.surround3d.enabled = params.subsonicEnabled = false;
              params.limiter.lookaheadMs = 5; params.limiter.thresholdDb = -1; params.limiter.truePeak = true;
            }],
          ];
          for (const [name, change] of changes) {
            currentStage = { mode: 'smoothing-' + name, frames: 0, bad: 0, peak: 0, nonzero: 0, updates: 1 };
            stageStartedAt = performance.now(); smoothingStages.push(currentStage);
            change(); sendParams(); await new Promise(resolve => setTimeout(resolve, 650));
          }
          currentStage = { mode: 'smoothing-rapid', frames: 0, bad: 0, peak: 0, nonzero: 0, updates: 0 };
          stageStartedAt = performance.now(); smoothingStages.push(currentStage);
          params.compressor.enabled = true; params.bassEnhancer.enabled = true;
          for (let tick = 0; tick < 24; tick++) {
            params.compressor.makeupDb = tick % 2 ? -6 : 12;
            params.bassEnhancer.harmonicType = tick % 2 ? 'even' : 'atan';
            params.crossfeed.enabled = tick % 2 === 0; params.stereoWidth = tick % 2 ? 0 : 2;
            sendParams(); currentStage.updates++;
            await new Promise(resolve => setTimeout(resolve, 8));
          }
          await new Promise(resolve => setTimeout(resolve, 650));
        }
        const preparedIrStages = [];
        if (${process.argv.includes('--probe-prepared-ir')}) {
          params.spatial.mode = 'off';
          params.spatial.instant.room = 'off';
          params.reverb.enabled = true;
          params.reverb.mode = 'convolution';
          params.reverb.convolution.partitionSize = 256;
          params.reverb.convolution.dePeriodize = false;
          params.reverb.convolution.mix = 0.6;
          params.reverb.convolution.preDelayMs = 0;
          params.reverb.convolution.irName = 'electron-prepared-8192';
          params.reverb.convolution.ir = new Float32Array(8192);
          for (let i = 0; i < params.reverb.convolution.ir.length; i++) {
            params.reverb.convolution.ir[i] = (i === 0 ? 1 : 0) + 0.08 * Math.exp(-i / 1300) * Math.sin(i * 0.12);
          }
          for (const partitionSize of [256, 512]) {
            params.reverb.convolution.partitionSize = partitionSize;
            currentStage = { mode: 'prepared-ir-' + partitionSize, frames: 0, bad: 0, peak: 0, nonzero: 0, updates: 0 };
            stageStartedAt = performance.now();
            preparedIrStages.push(currentStage);
            sendParams();
            await new Promise(resolve => setTimeout(resolve, 1200));
          }
          params.reverb.enabled = false;
          currentStage = { mode: 'prepared-ir-disabled', frames: 0, bad: 0, peak: 0, nonzero: 0, updates: 0 };
          stageStartedAt = performance.now();
          preparedIrStages.push(currentStage);
          sendParams();
          await new Promise(resolve => setTimeout(resolve, 600));
          params.reverb.enabled = true;
          currentStage = { mode: 'prepared-ir-reenabled', frames: 0, bad: 0, peak: 0, nonzero: 0, updates: 0 };
          stageStartedAt = performance.now();
          preparedIrStages.push(currentStage);
          sendParams();
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
        const result = { budgetMode: params.spatial.budgetMode, inputLayout: params.spatial.instant.multichannelLayout,
          composedNodes: ${process.argv.includes('--probe-nodes')}, parameterPath: direct ? 'direct-worklet' : 'host-prepared', requestedRate: ${fs}, sampleRate: ctx.sampleRate, state: ctx.state,
          baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency,
          stats, invalidStats, errors, inputChannelCounts: Array.from(inputChannelCounts), timing, steadyTiming, preparedIrStages, smoothingStages,
          deadlineStatus: timing.callbacks === 0 ? 'not-measured' : timing.overruns > 0 ? 'over-budget' : 'no-overrun-observed', stages };
        for (const source of sources) source.stop(); if (!direct) host.dispose(); await ctx.close();
        return result;
      })()`)
      console.log(JSON.stringify(result, null, 2))
      const outputArg = process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
      if (outputArg) {
        const outputPath = path.resolve(root, outputArg)
        if (!outputPath.startsWith(root + path.sep)) throw new Error('probe output must remain inside snapshot')
        mkdirSync(path.dirname(outputPath), { recursive: true })
        writeFileSync(outputPath, JSON.stringify({ measuredAt: new Date().toISOString(), ...result }, null, 2))
      }
      if (result.state !== 'running' || result.sampleRate !== fs || result.stats < 20 || result.invalidStats
        || !result.inputChannelCounts.includes(process.argv.includes('--stereo-input') ? 2 : 6) || result.errors.length
        || result.stages.some(stage => stage.frames === 0 || stage.bad || stage.peak < 0.001 || !stage.nonzero)
        || result.smoothingStages.some(stage => stage.frames === 0 || stage.bad || stage.peak < 0.001 || stage.peak > 1.00001 || !stage.nonzero)
        || result.preparedIrStages.some(stage => stage.frames === 0 || stage.bad || stage.peak < 0.001 || !stage.nonzero)) {
        throw new Error('real AudioWorklet graph validation failed')
      }
      if (process.argv.includes('--require-deadline') && result.deadlineStatus !== 'no-overrun-observed') {
        throw new Error('AudioWorklet deadline validation failed: ' + result.deadlineStatus)
      }
      console.log('Real Electron AudioWorklet graph passed; device deadlines and listening remain separate checks.')
      server.close(); window.destroy(); app.exit(0)
    } catch (error) {
      console.error(error.message); server.close(); window?.destroy(); app.exit(1)
    }
  }).catch(error => { console.error(error.message); app.exit(1) })
}
