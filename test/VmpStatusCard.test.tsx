// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import VmpStatusCard, { getVmpStatusPresentation } from '../src/components/VmpStatusCard'
import type { VmpStatus } from '../src/electron'

const status = (value: Partial<VmpStatus>): VmpStatus => ({
  status: 'valid',
  kind: 'streaming',
  daysLeft: 1416,
  expiresAt: null,
  checkedAt: Date.now(),
  source: 'development-verify',
  ...value,
})

afterEach(() => {
  cleanup()
  delete (window as any).electron
})

describe('VmpStatusCard', () => {
  it('shows a valid production streaming signature', async () => {
    const getVmpStatus = vi.fn().mockResolvedValue(status({}))
    ;(window as any).electron = { diagnostics: { getVmpStatus } }

    render(<VmpStatusCard dark accent="#22c55e" />)

    expect(screen.getByText('正在校验…')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('有效，剩余 1416 天')).toBeTruthy())
    expect(getVmpStatus).toHaveBeenCalledTimes(1)
  })

  it('shows warning and urgent expiration states', () => {
    expect(getVmpStatusPresentation(status({ status: 'expiring', daysLeft: 180 })).tone).toBe('warning')
    expect(getVmpStatusPresentation(status({ status: 'expiring', daysLeft: 30 })).tone).toBe('danger')
    expect(getVmpStatusPresentation(status({ status: 'expired', daysLeft: 0 })).label).toBe('已过期')
  })

  it('falls back safely when the desktop bridge is unavailable', async () => {
    render(<VmpStatusCard dark={false} accent="#22c55e" />)
    await waitFor(() => expect(screen.getByText('状态不可用')).toBeTruthy())
  })
})
