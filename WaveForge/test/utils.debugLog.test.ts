import { describe, it, expect, vi, afterEach } from 'vitest'

const VERBOSE_KEY = 'waveforge:verbose-log'

// debugLog 的 verboseEnabled 会缓存模块级结果，且 debugLog.ts 依赖全局
// localStorage。为在干净状态下测试每个分支，这里用 vi.resetModules() 每次
// 重新加载模块，并用 vi.stubGlobal 注入不同的 localStorage 实现。
async function loadDebugLog() {
  vi.resetModules()
  return (await import('../src/utils/debugLog.ts')).debugLog
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('debugLog（热路径日志开关）', () => {
  it('无 localStorage（或访问抛错）时静默，不输出', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // 不 stub localStorage：node 环境下的全局对象访问 getItem 会抛错，
    // debugLog 应捕获并静默。
    const debugLog = await loadDebugLog()
    debugLog('hello', { a: 1 })
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('localStorage 返回 "1" 时输出日志', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => '1'),
    })
    const debugLog = await loadDebugLog()
    debugLog('verbose message', 42)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith('verbose message', 42)
  })

  it('localStorage 返回非 "1" 值时静默', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => '0'),
    })
    const debugLog = await loadDebugLog()
    debugLog('should not appear')
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('localStorage.getItem 抛错时静默降级', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => { throw new Error('storage unavailable') }),
    })
    const debugLog = await loadDebugLog()
    debugLog('should not appear')
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('开关结果被模块级缓存（首次取值后不再读取 localStorage）', async () => {
    const getItem = vi.fn(() => '0')
    vi.stubGlobal('localStorage', { getItem })
    const debugLog = await loadDebugLog()
    debugLog('first')
    debugLog('second')
    debugLog('third')
    // 只有第一次调用会访问 localStorage
    expect(getItem).toHaveBeenCalledTimes(1)
  })
})
