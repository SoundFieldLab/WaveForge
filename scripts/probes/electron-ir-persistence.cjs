// Real IndexedDB round-trip across renderer reloads, using an isolated Electron profile.
const path = require('node:path')
const root = path.resolve(__dirname, '../..')

if (!process.versions.electron) {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  const deadline = setTimeout(() => { child.kill(); process.exitCode = 1; console.error('IR persistence probe timed out') }, 30000)
  child.on('error', error => { clearTimeout(deadline); console.error(error.message); process.exitCode = 1 })
  child.on('exit', code => { clearTimeout(deadline); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow } = require('electron')
  const { createServer } = require('node:http')
  const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const assert = require('node:assert/strict')
  const { buildSync } = require('esbuild')
  app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'hse-ir-probe-')))
  const bundle = buildSync({ stdin: {
    contents: `import * as store from './src/services/waveforge-engine-v3/ui/irStore.ts'; globalThis.irProbe = store;`,
    resolveDir: root, loader: 'ts',
  }, bundle: true, write: false, format: 'iife' }).outputFiles[0].text
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<title>HSE IR persistence probe</title><script>${bundle}</script>`)
  })
  let window
  app.whenReady().then(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
    const reload = () => window.loadURL(url)
    const evaluate = source => window.webContents.executeJavaScript(source)
    try {
      await reload()
      const saved = await evaluate(`(async () => {
        const input = Float32Array.from([1, 0.5, 0.25, 0.125]);
        const metadata = await irProbe.saveConvolutionIr('probe.wav', 'headphoneCorrection', 48000, input);
        input[0] = 0;
        return metadata;
      })()`)
      const id = JSON.stringify(saved.id)
      await reload()
      const restored = await evaluate(`(async () => {
        const entry = await irProbe.loadConvolutionIr(${id}, 48000);
        const converted = await irProbe.loadConvolutionIr(${id}, 96000);
        return { samples: Array.from(entry.ir), isFloat32: entry.ir instanceof Float32Array,
          sampleRate: entry.metadata.sampleRate, purpose: entry.metadata.purpose,
          convertedLength: converted.ir.length, count: (await irProbe.listConvolutionIr()).length };
      })()`)
      assert.deepEqual(restored.samples, [1, 0.5, 0.25, 0.125])
      assert.equal(restored.isFloat32, true)
      assert.equal(restored.convertedLength, 8)
      assert.equal(restored.count, 1)
      assert.equal(await evaluate(`irProbe.updateConvolutionIrPurpose(${id}, 'speakerCorrection')`), true)
      await reload()
      const updatedPurpose = await evaluate(`irProbe.loadConvolutionIr(${id}, 48000).then(entry => entry.metadata.purpose)`)
      assert.equal(updatedPurpose, 'speakerCorrection')
      assert.equal(await evaluate(`irProbe.removeConvolutionIr(${id})`), true)
      await reload()
      const deleted = await evaluate(`(async () => ({ entry: await irProbe.loadConvolutionIr(${id}, 48000), count: (await irProbe.listConvolutionIr()).length }))()`)
      assert.equal(deleted.entry, null)
      assert.equal(deleted.count, 0)
      await evaluate(`(async () => {
        for (let index = 0; index < 31; index++) await irProbe.saveConvolutionIr('capacity-' + index, 'reverb', 48000, Float32Array.of(1));
      })()`)
      await reload()
      const concurrentFinalSlot = await evaluate(`(async () => {
        const results = await Promise.allSettled([
          irProbe.saveConvolutionIr('last-a', 'reverb', 48000, Float32Array.of(1)),
          irProbe.saveConvolutionIr('last-b', 'reverb', 48000, Float32Array.of(1)),
        ]);
        return results.map(result => result.status);
      })()`)
      assert.equal(concurrentFinalSlot.filter(status => status === 'fulfilled').length, 1)
      assert.equal(concurrentFinalSlot.filter(status => status === 'rejected').length, 1)
      await reload()
      const capacity = await evaluate(`(async () => {
        let rejected = false;
        try { await irProbe.saveConvolutionIr('overflow', 'reverb', 48000, Float32Array.of(1)); }
        catch { rejected = true; }
        const entries = await irProbe.listConvolutionIr();
        const result = { rejectedAfterReload: rejected, count: entries.length };
        for (const entry of entries) await irProbe.removeConvolutionIr(entry.id);
        return result;
      })()`)
      assert.equal(capacity.rejectedAfterReload, true)
      assert.equal(capacity.count, 32)
      await reload()
      assert.equal(await evaluate('irProbe.listConvolutionIr().then(entries => entries.length)'), 0)
      const result = { measuredAt: new Date().toISOString(), restored, updatedPurpose, deleted, concurrentFinalSlot, capacity, passed: true }
      const output = path.join(root, '.verification', 'ir-persistence.json')
      mkdirSync(path.dirname(output), { recursive: true })
      writeFileSync(output, JSON.stringify(result, null, 2))
      console.log(JSON.stringify(result, null, 2))
      window.destroy(); server.close(); app.exit(0)
    } catch (error) {
      console.error(error.stack ?? error.message)
      window?.destroy(); server.close(); app.exit(1)
    }
  }).catch(error => { console.error(error.message); app.exit(1) })
}
