// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useHSETheme } from '../hse-theme'
import { HeadTrackingBridgeControls } from './HeadTrackingBridgeControls'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function setup() {
  const onBridgeUrl = vi.fn()
  const getBridgeState = vi.fn(async () => ({ running: false, udpPort: 9000, wsUrl: 'ws://127.0.0.1:8989/pose' }))
  const startBridge = vi.fn(async () => ({ running: true, udpPort: 9000, wsUrl: 'ws://127.0.0.1:8989/pose' }))
  const stopBridge = vi.fn(async () => ({ running: false, udpPort: 9000, wsUrl: 'ws://127.0.0.1:8989/pose' }))
  vi.stubGlobal('electron', { hseHeadTracking: { getBridgeState, startBridge, stopBridge } })
  function Harness() { return <HeadTrackingBridgeControls theme={useHSETheme()} onBridgeUrl={onBridgeUrl} /> }
  render(<Harness />)
  return { getBridgeState, startBridge, stopBridge, onBridgeUrl }
}

describe('主程序 OSC 桥控件', () => {
  it('读取状态不启动；用户启动后只填写地址，停止后显示结果', async () => {
    const api = setup()
    await waitFor(() => expect(screen.getByRole('button', { name: '启动本机 OSC 桥' })).toBeTruthy())
    expect(api.startBridge).not.toHaveBeenCalled()
    expect(api.onBridgeUrl).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '启动本机 OSC 桥' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '停止本机 OSC 桥' })).toBeTruthy())
    expect(api.onBridgeUrl).toHaveBeenCalledWith('ws://127.0.0.1:8989/pose')
    fireEvent.click(screen.getByRole('button', { name: '停止本机 OSC 桥' }))
    await waitFor(() => expect(screen.getByText('本机 OSC 桥已停止')).toBeTruthy())
    expect(api.stopBridge).toHaveBeenCalledOnce()
  })

  it('启动失败反馈具体原因，保留可重试操作', async () => {
    const api = setup()
    api.startBridge.mockRejectedValueOnce(new Error('UDP 9000 端口已被占用'))
    await waitFor(() => expect(screen.getByRole('button', { name: '启动本机 OSC 桥' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '启动本机 OSC 桥' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('端口已被占用'))
    expect(api.onBridgeUrl).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: '启动本机 OSC 桥' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
