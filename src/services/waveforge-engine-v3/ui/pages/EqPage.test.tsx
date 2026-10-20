// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import EqPage from './EqPage'
import { createV3UiBridge } from '../bridge'
import { useHSETheme } from '../hse-theme'
import { useV3Params } from '../hooks'
import { EngineV3 } from '../../src/engine/EngineV3'
import type { EqBand } from '../../src/types'

function makePage() {
  const bridge = createV3UiBridge(new EngineV3(48000, 2), 48000)
  function Harness() {
    return <EqPage bridge={bridge} controller={useV3Params(bridge)} theme={useHSETheme()} onOpenEffect={() => {}} />
  }
  render(<Harness />)
  return { bridge }
}

afterEach(cleanup)

describe('均衡器预设库（64 段）', () => {
  it('内置预设一键应用为 64 段曲线', () => {
    const { bridge } = makePage()
    expect(screen.getByText('一键应用 64 段曲线')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '流行' }))
    const eq = bridge.getParams().eq
    expect(eq.enabled).toBe(true)
    expect(eq.mode).toBe('pro')
    expect(eq.bandCount).toBe(64)
    expect(eq.proBands).toHaveLength(64)
    expect(eq.proBands[0].frequency).toBeCloseTo(20, 1)
    expect(eq.proBands[0].q).toBeCloseTo(9.4, 5)
    expect(eq.proBands.some((band: EqBand) => band.gain !== 0)).toBe(true)
  })

  it('平直预设仍为 64 段全 0，且可被分享串往返', () => {
    const { bridge } = makePage()
    fireEvent.click(screen.getByRole('button', { name: '平直' }))
    const eq = bridge.getParams().eq
    expect(eq.bandCount).toBe(64)
    expect(eq.proBands).toHaveLength(64)
    expect(eq.proBands.every((band: EqBand) => band.gain === 0)).toBe(true)
  })
})
