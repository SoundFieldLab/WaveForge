'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const python = process.platform === 'win32'
  ? path.join(root, 'resources', 'python-embed', 'python.exe')
  : (process.env.PYTHON || 'python3')
const tests = [
  'test/test_htdemucs_runner.py',
  'test/test_stem_render.py',
  'test/test_track_stem_runner.py',
  'test/test_local_service_auth.py',
]

for (const testFile of tests) {
  const result = spawnSync(python, [path.join(root, testFile)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (result.error) {
    console.error(`[stem-tests] 无法启动 Python: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status || 1)
}
