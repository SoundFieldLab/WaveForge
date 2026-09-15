import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const PROJECT_MARKERS = ['package.json', 'scripts/dev-electron.mjs', 'desktop/main.cjs']

export function isWaveForgeProjectRoot(candidate, exists = existsSync) {
  return PROJECT_MARKERS.every(marker => exists(resolve(candidate, marker)))
}

export function resolveWaveForgeProjectRoot(workingDirectory = process.cwd(), exists = existsSync) {
  const cwd = resolve(workingDirectory)
  const candidates = [cwd, resolve(cwd, 'WaveForge')]
  const projectRoot = candidates.find(candidate => isWaveForgeProjectRoot(candidate, exists))
  if (projectRoot) return projectRoot

  throw new Error(
    `WaveForge project root was not found. Checked: ${candidates.join(', ')}. ` +
    `A valid root must contain ${PROJECT_MARKERS.join(', ')}.`,
  )
}

export function buildWaveForgeNpmCommand(workingDirectory = process.cwd(), npmCommand = 'npm', exists = existsSync) {
  const projectRoot = resolveWaveForgeProjectRoot(workingDirectory, exists)
  return { projectRoot, command: npmCommand, args: ['--prefix', projectRoot, 'run', 'dev:electron'] }
}
