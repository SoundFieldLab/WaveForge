/**
 * TV 调试模式面板（developerMode 开启后显示）：
 *  - 后端日志：左下角（轮询 /api/tv/logs）
 *  - 前端日志：左下角（后端面板上方，两个都开时一上一下）
 *  - 性能信息：右上角（简约/详细两档）
 *
 * 特性：弹窗样式、半透明、整体 data-tv-skip——遥控器空间导航不会选中这些框。
 *
 * 交互性：纯 TV 遥控器场景（非 PC、未连手机远程遥控）下仅展示——
 * 不显示滚动条、关闭按钮与 简约/详细 切换（遥控器无法操作）；
 * PC 或手机远程遥控器连接时与 PC 行为一致，可正常滚动/关闭/切换。
 */
import { useEffect, useRef, useState } from 'react'
import { isTvModeActive } from '../platform'
import { useRemoteCursorMode } from './tvCore'
import {
  useDebugMode,
  useFrontendLogs,
  useBackendLogs,
  usePerf,
  startPerfMeasurement,
  stopPerfMeasurement,
  startBackendLogPolling,
  stopBackendLogPolling,
  DEBUG_PANEL_KEYS,
  getDebugPanelVisible,
  setDebugPanelVisible,
  type LogLine,
} from './debugStore'

const PANEL_BG = 'rgba(8, 12, 20, 0.55)'
const PANEL_BORDER = 'rgba(255,255,255,0.14)'

const levelColor: Record<LogLine['level'], string> = {
  log: '#9cdcfe',
  info: '#7ee787',
  warn: '#ffd28a',
  error: '#ff7b72',
  debug: '#8b949e',
}

function LogView({ lines, label, height, interactive }: { lines: LogLine[]; label: string; height: number; interactive: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])
  return (
    <div
      ref={ref}
      className={`overflow-auto font-mono text-[11px] leading-4 ${interactive ? '' : 'wf-no-scrollbar'}`}
      style={{ height, color: '#e6edf3', pointerEvents: interactive ? 'auto' : 'none' }}
    >
      {lines.length === 0 && <div style={{ color: '#8b949e' }}>{label}（暂无日志）</div>}
      {lines.map((line, i) => (
        <div key={i} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <span style={{ color: '#8b949e' }}>{line.time} </span>
          <span style={{ color: levelColor[line.level] || '#e6edf3' }}>{line.text}</span>
        </div>
      ))}
    </div>
  )
}

export default function DebugPanels() {
  const debug = useDebugMode()
  const frontendLogs = useFrontendLogs()
  const backendLogs = useBackendLogs()
  const perf = usePerf()
  const [perfDetailed, setPerfDetailed] = useState(false)
  // 面板可见性来自开发者模式子开关（localStorage）；事件触发时强制刷新
  const [, force] = useState(0)
  useEffect(() => {
    const onChange = () => force((v) => v + 1)
    window.addEventListener('debugPanelsChanged', onChange)
    return () => window.removeEventListener('debugPanelsChanged', onChange)
  }, [])
  const showBackend = getDebugPanelVisible(DEBUG_PANEL_KEYS.backend)
  const showFrontend = getDebugPanelVisible(DEBUG_PANEL_KEYS.frontend)
  const showPerf = getDebugPanelVisible(DEBUG_PANEL_KEYS.perf)
  // 交互模式：PC 或手机远程遥控器连接后，与 PC 行为一致（可滚动/关闭/切换）；
  // 纯 TV 遥控器下仅展示，隐藏滚动条、关闭按钮与显示模式切换。
  const interactive = !isTvModeActive() || useRemoteCursorMode()

  useEffect(() => {
    if (debug) {
      startPerfMeasurement()
      startBackendLogPolling()
    } else {
      stopPerfMeasurement()
      stopBackendLogPolling()
    }
  }, [debug])

  // 设备温度（从原生桥定期读取，性能面板详细模式展示）
  const [deviceTemp, setDeviceTemp] = useState<number | null>(null)
  useEffect(() => {
    if (!debug || !showPerf) return
    const readTemp = () => {
      try {
        const native = (window as any).WaveForgeNative
        if (!native?.getDeviceInfo) return
        const info = JSON.parse(String(native.getDeviceInfo()))
        setDeviceTemp(typeof info.cpuTempC === 'number' ? info.cpuTempC : null)
      } catch {
        setDeviceTemp(null)
      }
    }
    readTemp()
    const timer = window.setInterval(readTemp, 5000)
    return () => window.clearInterval(timer)
  }, [debug, showPerf])

  if (!debug) return null

  const fmtMB = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`
  const fmtGB = (b?: number) => (b ? `${b.toFixed(1)}GB` : '—')
  const stackBottom = showBackend ? 216 : 14

  const headerBtn = {
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)',
    color: '#fff',
    borderRadius: 6,
    fontSize: 11,
    padding: '2px 8px',
    cursor: 'pointer',
    pointerEvents: 'auto',
  } as const

  return (
    <div data-tv-skip style={{ pointerEvents: 'none' }}>
      {/* 后端日志（左下） */}
      {showBackend && (
        <div
          className="fixed bottom-3 left-3 z-[9000] rounded-lg border"
          style={{ background: PANEL_BG, borderColor: PANEL_BORDER, width: 460, maxHeight: 200, backdropFilter: 'blur(2px)' }}
        >
          <div className="flex items-center justify-between px-2 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <span style={{ color: '#7ee787', fontSize: 11, fontWeight: 600 }}>后端日志</span>
            {interactive && (
              <button
                style={headerBtn}
                onClick={() => setDebugPanelVisible(DEBUG_PANEL_KEYS.backend, false)}
                className="tv-debug-btn"
                aria-label="关闭后端日志"
              >
                ×
              </button>
            )}
          </div>
          <div style={{ padding: 4 }}>
            <LogView lines={backendLogs} label="后端" height={150} interactive={interactive} />
          </div>
        </div>
      )}

      {/* 前端日志（左下，后端面板上方） */}
      {showFrontend && (
        <div
          className="fixed bottom-3 left-3 z-[9000] rounded-lg border"
          style={{
            background: PANEL_BG,
            borderColor: PANEL_BORDER,
            width: 460,
            maxHeight: 200,
            bottom: stackBottom,
            backdropFilter: 'blur(2px)',
          }}
        >
          <div className="flex items-center justify-between px-2 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <span style={{ color: '#9cdcfe', fontSize: 11, fontWeight: 600 }}>前端日志</span>
            {interactive && (
              <button style={headerBtn} onClick={() => setDebugPanelVisible(DEBUG_PANEL_KEYS.frontend, false)} className="tv-debug-btn" aria-label="关闭前端日志">
                ×
              </button>
            )}
          </div>
          <div style={{ padding: 4 }}>
            <LogView lines={frontendLogs} label="前端" height={150} interactive={interactive} />
          </div>
        </div>
      )}

      {/* 性能信息（右上） */}
      {showPerf && (
      <div
        className="fixed right-3 top-3 z-[9000] rounded-lg border"
        style={{ background: PANEL_BG, borderColor: PANEL_BORDER, minWidth: 150, backdropFilter: 'blur(2px)' }}
      >
          <div className="flex items-center justify-between gap-2 px-2 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
            <span style={{ color: '#ffd28a', fontSize: 11, fontWeight: 600 }}>性能</span>
            {interactive && (
              <div className="flex items-center gap-1">
                <button style={headerBtn} onClick={() => setPerfDetailed((v) => !v)} className="tv-debug-btn" aria-label="切换性能显示模式">
                  {perfDetailed ? '简约' : '详细'}
                </button>
                <button style={headerBtn} onClick={() => setDebugPanelVisible(DEBUG_PANEL_KEYS.perf, false)} className="tv-debug-btn" aria-label="关闭性能面板">
                  ×
                </button>
              </div>
            )}
          </div>
        <div className="px-2 py-1.5 font-mono text-[11px] leading-4" style={{ color: '#e6edf3' }}>
          {perfDetailed ? (
            <>
              <div>帧率: {perf.fps} FPS（{perf.frameMs}ms/帧）</div>
              <div>内存: {fmtMB(perf.heapUsed)} / {fmtMB(perf.heapTotal)}</div>
              <div>设备内存: {fmtGB(perf.deviceMemory)} · CPU {perf.cores} 核</div>
              <div>DOM 节点: {perf.domNodes}</div>
              {deviceTemp != null && <div>CPU 温度: {deviceTemp > 0 ? `${deviceTemp.toFixed(1)} ℃` : '不可读'}</div>}
            </>
          ) : (
            <div>⚡ {perf.fps} FPS · {fmtMB(perf.heapUsed)}</div>
          )}
        </div>
      </div>
      )}
    </div>
  )
}
