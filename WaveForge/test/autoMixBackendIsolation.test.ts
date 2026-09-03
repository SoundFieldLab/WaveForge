import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8').replace(/\r\n/g, '\n')

describe('AutoMix backend isolation contracts', () => {
  it('dispatches Folia to a dedicated worker function', () => {
    const runtime = read('desktop/render-runtime.cjs')
    const worker = read('desktop/workers/render_worker.py')

    expect(runtime).toContain("plan.v2?.backend === 'folia-htdemucs' ? 'render_folia' : 'render_v2'")
    expect(worker).toContain('def render_transition_folia(params: dict) -> dict:')
    expect(worker).toContain("elif message_type == 'render_folia':\n                result = render_transition_folia")
    expect(worker).not.toContain("elif message_type == 'render_folia':\n                result = render_transition_v2")
  })

  it('keeps Folia cache identity and actual render metadata explicit', () => {
    const planner = read('src/audio/transitionPlanner.ts')
    const runtime = read('desktop/render-runtime.cjs')

    expect(planner).toContain("RENDERER_VERSION_FOLIA = 'folia-beatthis-htdemucs-automix-v2-r1'")
    expect(planner).toContain(':${selectedBackend}:${beatProvider}')
    expect(runtime).toContain('meta.backend === expectedBackend')
    expect(runtime).toContain('meta.beatProvider === expectedBeatProvider')
    expect(runtime).toContain('stemMixApplied: result.stemMixApplied === true')
  })

  it('uses the same forty-second stem contract in planner and both runtimes', () => {
    const planner = read('src/audio/transitionPlanner.ts')
    const runtime = read('desktop/stem-runtime.cjs')
    const worker = read('desktop/workers/htdemucs_runner.py')

    expect(planner).toContain('sourceEndTime - 40')
    expect(planner).toContain('Math.min(40, target.duration - stemTargetStart)')
    expect(planner).toContain('maxStemWindowSeconds: 40')
    expect(runtime).toContain('duration > 40')
    expect(worker).toContain('MAX_DURATION_SECONDS = 40.0')
  })
})
