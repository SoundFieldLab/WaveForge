import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('analysis runtime source signature wiring', () => {
  it('passes sourceSignature from IPC input to the Python worker', () => {
    const source = fs.readFileSync(path.resolve('desktop/analysis-runtime.cjs'), 'utf8')
    const workerCall = source.match(/sendToWorker\('analyze',\s*\{([\s\S]*?)\}\)/)?.[1] || ''

    expect(workerCall).toContain('audioPath')
    expect(workerCall).toContain('trackKey')
    expect(workerCall).toContain('duration: input.duration')
    expect(workerCall).toContain('sourceSignature: input.sourceSignature')
  })
})
