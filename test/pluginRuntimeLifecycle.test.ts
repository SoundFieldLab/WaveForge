import { describe, expect, it } from 'vitest'
import type { PluginContext } from '../src/plugins/types'
import { createImportedPluginRuntime } from '../src/plugins/registry'

const context: PluginContext = {
  audio: { subscribe: () => () => undefined },
  storage: { get: () => null, set: () => undefined },
  toast: () => undefined,
  log: () => undefined,
}

describe('imported plugin runtime lifecycle', () => {
  it('disables the lifecycle instance created during enable', async () => {
    const events: Array<[string, number]> = []
    const runtime = createImportedPluginRuntime(`function (ctx) {
      const instance = Math.random();
      return {
        onEnable: function () { ctx.log('enable', instance); },
        onDisable: function () { ctx.log('disable', instance); }
      };
    }`)
    const observedContext = { ...context, log: (event: unknown, instance: unknown) => events.push([String(event), Number(instance)]) }

    await runtime.onEnable?.(observedContext)
    await runtime.onDisable?.()

    expect(events.map(([event]) => event)).toEqual(['enable', 'disable'])
    expect(events[0][1]).toBe(events[1][1])
  })

  it('does not disable one lifecycle twice', async () => {
    let disabled = 0
    const runtime = createImportedPluginRuntime('function(ctx){ return { onDisable: function(){ ctx.log() } } }')
    const observedContext = { ...context, log: () => { disabled += 1 } }

    await runtime.onEnable?.(observedContext)
    await runtime.onDisable?.()
    await runtime.onDisable?.()

    expect(disabled).toBe(1)
  })
})
