#!/usr/bin/env node
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const projectRoot = path.resolve(__dirname, '..')
const modelDir = path.join(projectRoot, 'resources', 'beat-this')
const modelPath = path.join(modelDir, 'final0.ckpt')
const metadataPath = path.join(modelDir, 'model.json')
const pythonPath = path.join(projectRoot, 'resources', 'python-embed', 'python.exe')

function fail(message) {
  console.error(`[Beat This] ${message}`)
  process.exit(1)
}

if (!fs.existsSync(metadataPath)) fail('model.json is missing')
if (!fs.existsSync(modelPath)) fail('final0.ckpt is missing')
if (!fs.existsSync(pythonPath)) fail('embedded Python is missing')

let metadata
try {
  metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
} catch {
  fail('model.json is invalid JSON')
}

const bytes = fs.statSync(modelPath).size
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(modelPath)).digest('hex')
if (metadata.file !== 'final0.ckpt' || metadata.bundled !== true || metadata.acquisitionRequired !== false) {
  fail('model metadata does not declare bundled final0')
}
if (bytes !== metadata.bytes || sha256 !== metadata.sha256) {
  fail(`final0 integrity mismatch (bytes=${bytes}, sha256=${sha256})`)
}

const probe = [
  'from beat_this.inference import File2Beats',
  'import torch, torchaudio',
  `File2Beats(checkpoint_path=${JSON.stringify(modelPath)}, device='cpu', float16=False, dbn=False)`,
  "print(f'Beat This ready: torch={torch.__version__}, torchaudio={torchaudio.__version__}')",
].join('; ')
const result = spawnSync(pythonPath, ['-c', probe], {
  cwd: projectRoot,
  encoding: 'utf8',
  timeout: 180000,
  windowsHide: true,
})
if (result.status !== 0) {
  fail((result.stderr || result.stdout || 'runtime probe failed').trim())
}
console.log(`[Beat This] final0 verified (${bytes} bytes, ${sha256})`)
console.log(result.stdout.trim())
