import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const tempDir = resolve(root, '.tmp/bilibili-mv-benchmark')
const runnerPath = resolve(tempDir, 'runner.mjs')
const port = Number(process.env.BILIBILI_BENCHMARK_PORT || 3011)
let server
let runner
let cleaningUp = false

async function cleanup() {
  if (cleaningUp) return
  cleaningUp = true
  if (runner && runner.exitCode === null) runner.kill('SIGTERM')
  if (server && server.exitCode === null) server.kill('SIGTERM')
  await Promise.all([
    runner && runner.exitCode === null ? new Promise((resolveExit) => runner.once('exit', resolveExit)) : undefined,
    server && server.exitCode === null ? new Promise((resolveExit) => server.once('exit', resolveExit)) : undefined,
  ].filter(Boolean))
  await rm(tempDir, { recursive: true, force: true })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130))
  })
}

await mkdir(tempDir, { recursive: true })
await build({
  entryPoints: [resolve(root, 'scripts/bilibili-mv-benchmark-runner.ts')],
  outfile: runnerPath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
})

server = spawn(process.execPath, [resolve(root, 'scripts/bilibili-mv-benchmark-server.mjs')], {
  cwd: root,
  env: { ...process.env, PORT: String(port), WAVEFORGE_LOCAL_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
})

const waitForReady = new Promise((resolveReady, reject) => {
  const timeout = setTimeout(() => reject(new Error('Benchmark API startup timed out')), 15_000)
  server.stdout.on('data', (chunk) => {
    const text = String(chunk)
    process.stdout.write(text)
    if (text.includes('api ready')) {
      clearTimeout(timeout)
      resolveReady(undefined)
    }
  })
  server.once('exit', (code) => reject(new Error(`Benchmark API exited early (${code})`)))
})

try {
  await waitForReady
  runner = spawn(process.execPath, [runnerPath, ...process.argv.slice(2)], {
    cwd: root,
    env: {
      ...process.env,
      BILIBILI_BENCHMARK_API: `http://127.0.0.1:${port}/api/bilibili`,
      BILIBILI_BENCHMARK_ROOT: root,
    },
    stdio: 'inherit',
  })
  const code = await new Promise((resolveCode) => runner.once('exit', (value) => resolveCode(value ?? 1)))
  if (code !== 0) process.exitCode = code
} finally {
  await cleanup()
}
