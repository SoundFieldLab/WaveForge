import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { buildWaveForgeNpmCommand, resolveWaveForgeProjectRoot } from '../scripts/workspace-root.mjs'

const workspace = resolve('/workspace')
const nestedWorkspace = resolve(workspace, 'WaveForge')

function existsForProjectRoots(roots: string[]) {
  return (path: string) => roots.some(root => String(path).startsWith(root))
}

describe('WaveForge workspace root discovery', () => {
  it('uses the current directory for the direct project layout', () => {
    expect(resolveWaveForgeProjectRoot(workspace, existsForProjectRoots([workspace]))).toBe(workspace)
  })

  it('uses the direct WaveForge child for the multi-project workspace layout', () => {
    expect(resolveWaveForgeProjectRoot(workspace, existsForProjectRoots([nestedWorkspace]))).toBe(nestedWorkspace)
  })

  it('prefers a valid current directory over its WaveForge child', () => {
    expect(resolveWaveForgeProjectRoot(workspace, existsForProjectRoots([workspace, nestedWorkspace]))).toBe(workspace)
  })

  it('does not select incomplete or similarly named directories', () => {
    expect(() => resolveWaveForgeProjectRoot(workspace, existsForProjectRoots([resolve(workspace, 'WaveForge-clean-check')])))
      .toThrow(`Checked: ${workspace}, ${nestedWorkspace}`)
  })

  it('builds an npm command pinned to the resolved package root', () => {
    expect(buildWaveForgeNpmCommand(workspace, 'npm', existsForProjectRoots([nestedWorkspace]))).toEqual({
      projectRoot: nestedWorkspace,
      command: 'npm',
      args: ['--prefix', nestedWorkspace, 'run', 'dev:electron'],
    })
  })
})
