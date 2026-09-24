/**
 * DG-LAB 连接引导（OOBE）—— 讲清楚「手机 App 怎么连上当前插件」。
 *
 * 用户提供的 6 张手机截图（1-6，外加一张「设置网格」附加图）按步骤框选动画展示：
 *   0 版本选择    DG-LAB 3.0 / 4.0（本期先做 3.0 动画）
 *   1 首页        框出底部「SOCKET 控制」入口
 *   2 连接中      等待主机连上 App
 *   3 SOCKET 页   框右上角齿轮「设置」→ 再框「输出设置」
 *   4 输出设置    框 A/B 上限 + 增加速率（1 建议）+ 用异色框出「连接服务器」
 *   5 二维码      实时生成 3.0 二维码，扫码成功→下一步；可跳过进主界面
 *   6 已连接      框出「服务器连接成功」提示，引导结束
 *
 * 设计：金黑配色对齐 DG-LAB 控制台；截图用 SVG 1:1 高亮层 + 框选脉冲/扫描光动画；
 * 二维码走真实插件链路（client.getQR），扫码成功检测用 useDGLabStatus().state==='bound'。
 * 与现有 OOBE1（OobeGuide）解耦：本组件只讲连接，未来可挂进 OOBE2 功能引导或独立复用。
 */
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, ArrowRight, Check, QrCode, Smartphone, Wifi, X } from 'lucide-react'
import { useDGLabStatus, getDGLabClient, saveDGLabSettings, type DGLabSettings } from '@/plugins/clients/DGLabClient'
import homeImg from '@/assets/oobe-dglab/app-home.webp'
import connectingImg from '@/assets/oobe-dglab/app-connecting.webp'
import socketPageImg from '@/assets/oobe-dglab/app-socket-page.webp'
import settingsGridImg from '@/assets/oobe-dglab/app-settings-grid.webp'
import configImg from '@/assets/oobe-dglab/app-socket-config.webp'
import remoteImg from '@/assets/oobe-dglab/app-remote-scan.webp'
import connectedImg from '@/assets/oobe-dglab/app-connected.webp'
import './dglabOobe.css'

const GOLD = '#FFE89C'
const SCAN = '#22d3ee'
const SLIDER = '#fb923c'

/** 截图内高亮矩形（像素，基于源图 1206×2622，已用脚本逐张核对）。 */
const IMG_W = 1206
const IMG_H = 2622
const RECTS = {
  socketEntry: { x: 912, y: 2256, w: 264, h: 264 },
  connectingDialog: { x: 120, y: 1037, w: 966, h: 527 },
  settingsEntry: { x: 1066, y: 181, w: 100, h: 100 },
  outputSettings: { x: 831, y: 1011, w: 318, h: 315 },
  capSliders: { x: 182, y: 1138, w: 844, h: 810 },
  connectServerBtn: { x: 180, y: 949, w: 846, h: 90 },
  scanCamera: { x: 523, y: 1361, w: 160, h: 138 },
  successToast: { x: 420, y: 2212, w: 367, h: 143 },
} as const

type StepKind = 'version' | 'mark' | 'qr' | 'done'
interface StepDef {
  kind: StepKind
  img?: string
  /** 高亮框（mark 步骤用，渲染不同颜色） */
  marks?: { key: keyof typeof RECTS; color?: string }[]
  /** 该步骤真实可点「下一步」的前置条件：'none' | 'scanned' */
  advanceWhen?: 'none' | 'scanned'
}

const STEPS: StepDef[] = [
  { kind: 'version' },
  { kind: 'mark', img: homeImg, marks: [{ key: 'socketEntry', color: GOLD }] },
  { kind: 'mark', img: connectingImg, marks: [{ key: 'connectingDialog', color: GOLD }] },
  { kind: 'mark', img: socketPageImg, marks: [{ key: 'settingsEntry', color: GOLD }] },
  { kind: 'mark', img: settingsGridImg, marks: [{ key: 'outputSettings', color: GOLD }] },
  { kind: 'mark', img: configImg, marks: [{ key: 'capSliders', color: SLIDER }, { key: 'connectServerBtn', color: SCAN }] },
  { kind: 'qr', img: remoteImg, marks: [{ key: 'scanCamera', color: GOLD }], advanceWhen: 'scanned' },
  { kind: 'done', img: connectedImg, marks: [{ key: 'successToast', color: GOLD }] },
]

const STEP_TITLES = [
  '选择 APP 版本',
  '打开 SOCKET 控制',
  '等待主机连接',
  '打开设置',
  '进入输出设置',
  '设置强度上限并连接',
  '扫码连接（3.0）',
  '连接成功',
]

const COPY = {
  intro:
    '本引导用你手机里的 DG-LAB App 截图，一步步讲清楚「怎么连上当前插件」。请先确保手机与电脑连在同一局域网（同一 WiFi / 同一热点）。',
  version: '请选择你的 DG-LAB App 版本。本期引导先以 3.0 为例（4.0 稍后补齐）。',
  v30: 'DG-LAB 3.0',
  v40: 'DG-LAB 4.0',
  v30desc: '界面为经典「SOCKET 控制 / 扫码连接」入口，下方步骤按 3.0 截图演示。',
  v40desc: '4.0 引导稍后上线，本步骤仍可点击体验，正式连接流程以后续版本为准。',
  s1: '在 App 首页底部四个入口里，点最右侧的「SOCKET 控制」（蓝底黄字卡片）。',
  s2: '进入后保持页面开启——等待你的主机（本插件）连上 App，出现「蓝牙连接中 / 连接服务器」弹窗即可。',
  s3a: '在 SOCKET 控制页右上角点齿轮「设置」，打开功能菜单。',
  s3b: '在功能菜单里选「输出设置」，进入强度与连接设置。',
  s4: '按自身情况设置 A/B 通道强度上限；本插件提供「软上限」，稍后可在插件设置中调整。增加速率无特殊情况建议设为 1。设置完毕，点异色框出的「连接服务器」。',
  s5: '此时弹出远程控制页，点相机图标唤出 3.0 二维码。用手机扫码——扫码成功将自动进入下一步；也可直接「跳过」进入插件主界面。',
  s6: '扫码成功后页面底部出现「服务器连接成功」。连接已建立，可以开始体验音乐体感了。',
  tipLan: '手机与电脑必须在同一局域网：连同一 WiFi 或同一热点，否则扫码地址不可达。',
  skip: '跳过引导',
  prev: '上一步',
  next: '下一步',
  finish: '完成，进入插件',
  scanning: '等待扫码…（用手机 DG-LAB App 扫描右侧二维码）',
  scanned: '已检测到连接！',
}

export interface DglabOobeGuideProps {
  /** 引导结束（完成 / 跳过 / 关闭） */
  onComplete?: () => void
  /** 跳过时回调（用于静默标记，区别于正常完成） */
  onSkip?: () => void
  /** 是否显示右上角关闭（调试平台常驻时不一定要） */
  closable?: boolean
}

export default function DglabOobeGuide({ onComplete, onSkip, closable = true }: DglabOobeGuideProps) {
  const [step, setStep] = useState(0)
  const [version, setVersion] = useState<'v3' | 'v4'>('v3')
  const [scanned, setScanned] = useState(false)
  const [cardVisible, setCardVisible] = useState(true) // 切图时重放扫描光
  const [dismissed, setDismissed] = useState(false)
  const status = useDGLabStatus()
  const cardKey = useRef(0)

  const current = STEPS[step]
  const isLast = step === STEPS.length - 1
  const canAdvance = current.advanceWhen === 'scanned' ? scanned : true

  // 切换图片 → 重放扫描光 + 重置该步的「已扫」状态（仅 qr 步需要）
  useEffect(() => {
    cardKey.current += 1
    setCardVisible(false)
    const t = window.setTimeout(() => setCardVisible(true), 30)
    if (current.kind !== 'qr') setScanned(false)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // 真实扫码成功检测（仅在 qr 步关心）
  useEffect(() => {
    if (current.kind === 'qr' && status.state === 'bound') setScanned(true)
  }, [current.kind, status.state])

  // 选版本时同步插件设置（影响后续二维码 schema / 地址）
  const applyVersion = (v: 'v3' | 'v4') => {
    setVersion(v)
    const next = saveDGLabSettings({ version: v } as Partial<DGLabSettings>)
    getDGLabClient().setSettings({ version: v })
    void next
  }

  // qr 步实时二维码：跟随版本 / 状态生成
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (current.kind !== 'qr') { setQrUrl(null); return }
    const content = version === 'v3' ? status.qrV3 : status.qrV4
    if (!content) { setQrUrl(null); return }
    void getDGLabClient().getQR(content).then((url) => { if (!cancelled) setQrUrl(url) })
    return () => { cancelled = true }
  }, [current.kind, version, status.qrV3, status.qrV4])

  if (dismissed) return null

  const goNext = () => {
    if (!canAdvance) return
    if (isLast) { onComplete?.(); setDismissed(true) }
    else setStep((s) => Math.min(STEPS.length - 1, s + 1))
  }
  const goPrev = () => setStep((s) => Math.max(0, s - 1))
  const skip = () => { onSkip?.(); onComplete?.(); setDismissed(true) }
  const close = () => { onSkip?.(); setDismissed(true) }

  const renderMarks = (marks: { key: keyof typeof RECTS; color?: string }[]) => (
    <svg viewBox={`0 0 ${IMG_W} ${IMG_H}`} preserveAspectRatio="none" aria-hidden>
      {marks.map((m) => {
        const r = RECTS[m.key]
        const color = m.color ?? GOLD
        return (
          <g key={m.key}>
            <rect
              className="dglab-oobe-mark-stroke"
              x={r.x} y={r.y} width={r.w} height={r.h} rx={14}
              fill="none" stroke={color} strokeWidth={8}
              style={{ filter: `drop-shadow(0 0 8px ${color})` }}
            />
            {/* 四角装饰，强调「框选」 */}
            {[
              [r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1],
              [r.x, r.y + r.h, 1, -1], [r.x + r.w, r.y + r.h, -1, -1],
            ].map(([cx, cy, sx, sy], i) => (
              <path
                key={i}
                className="dglab-oobe-mark"
                d={`M ${cx} ${cy + 26 * sy} L ${cx} ${cy} L ${cx + 26 * sx} ${cy}`}
                fill="none" stroke={color} strokeWidth={9} strokeLinecap="round"
              />
            ))}
          </g>
        )
      })}
      {/* 扫描光：一条贯穿所有高亮区的渐变带，仅在图片首次出现时播放一次 */}
      {cardVisible && marks.length > 0 && (() => {
        const r0 = RECTS[marks[0].key]
        return (
          <rect key={cardKey.current} className="dglab-oobe-sweep" x={r0.x} y={r0.y} width={r0.w} height={r0.h}
            fill={`url(#sweep-${cardKey.current})`} />
        )
      })()}
      <defs>
        {Array.from({ length: cardKey.current + 1 }).map((_, i) => (
          <linearGradient key={i} id={`sweep-${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0" />
            <stop offset="50%" stopColor="white" stopOpacity="0.55" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
    </svg>
  )

  return (
    <div className="dglab-oobe-root dglab-oobe-scroll">
      {/* 背景 */}
      <div className="dglab-oobe-aurora" aria-hidden />

      {/* 顶部：进度点 + 关闭 */}
      <div className="relative z-20 flex items-center justify-center gap-2 pt-5">
        {STEPS.map((_, i) => (
          <span key={i} className={`dglab-oobe-dot ${i === step ? 'active' : ''}`} />
        ))}
      </div>
      {closable && (
        <button
          onClick={close}
          aria-label="关闭引导"
          className="absolute top-4 right-4 z-30 p-2 rounded-full bg-white/10 hover:bg-red-500/25 text-white/70 hover:text-red-300 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      )}

      <div className="relative z-10 mx-auto max-w-3xl px-5 pb-32 pt-3">
        {/* 标题 */}
        <div className="text-center mb-4">
          <h2 className="text-xl sm:text-2xl font-bold" style={{ color: GOLD }}>
            {STEP_TITLES[step]}
          </h2>
          <p className="text-[11px] mt-1 text-white/45">DG-LAB 连接引导 · 第 {step + 1} / {STEPS.length} 步</p>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            {/* ── 版本选择 ── */}
            {current.kind === 'version' && (
              <div className="space-y-3">
                <p className="text-sm text-white/70 leading-relaxed">{COPY.version}</p>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { v: 'v3', label: COPY.v30, desc: COPY.v30desc },
                    { v: 'v4', label: COPY.v40, desc: COPY.v40desc },
                  ] as const).map((opt) => {
                    const active = version === opt.v
                    return (
                      <button
                        key={opt.v}
                        onClick={() => applyVersion(opt.v)}
                        className={`dglab-oobe-version rounded-2xl border px-4 py-5 text-left ${active ? 'active' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-2 font-semibold text-white">
                            <Smartphone className="w-4 h-4" style={{ color: GOLD }} /> {opt.label}
                          </span>
                          {active && (
                            <span className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: GOLD }}>
                              <Check className="w-3 h-3 text-black" />
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-white/55 mt-1.5 leading-relaxed">{opt.desc}</p>
                      </button>
                    )
                  })}
                </div>
                <div className="flex items-start gap-2 rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-2.5">
                  <Wifi className="w-4 h-4 mt-0.5 shrink-0" style={{ color: GOLD }} />
                  <p className="text-[11px] text-amber-100/80 leading-relaxed">{COPY.tipLan}</p>
                </div>
              </div>
            )}

            {/* ── 截图 + 高亮 ── */}
            {(current.kind === 'mark' || current.kind === 'qr' || current.kind === 'done') && current.img && (
              <div className="flex flex-col items-center gap-4">
                <div className="dglab-oobe-phone">
                  <img src={current.img} alt={STEP_TITLES[step]} draggable={false} />
                  {current.marks && renderMarks(current.marks)}
                </div>
                {current.kind === 'qr' && (
                  <div className="flex flex-col items-center gap-3 w-full">
                    <div className="dglab-oobe-qr">
                      {qrUrl ? (
                        <img src={qrUrl} alt="DG-LAB 3.0 连接二维码" className="w-44 h-44 object-contain" draggable={false} />
                      ) : (
                        <div className="w-44 h-44 flex items-center justify-center text-black/45 text-xs">
                          <QrCode className="w-10 h-10 animate-pulse" />
                        </div>
                      )}
                    </div>
                    <p className={`text-[11px] ${scanned ? 'text-emerald-300' : 'text-white/55'}`}>
                      {scanned ? COPY.scanned : COPY.scanning}
                    </p>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {/* 文案区 */}
        <div className="mt-5 mx-auto max-w-xl">
          <AnimatePresence mode="wait">
            <motion.p
              key={step}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="text-sm text-white/75 leading-relaxed text-center"
            >
              {current.kind === 'version' ? COPY.intro :
               current.kind === 'qr' ? COPY.s5 :
               current.kind === 'done' ? COPY.s6 :
               [COPY.s1, COPY.s2, COPY.s3a, COPY.s3b, COPY.s4][step - 1] ?? ''}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>

      {/* 底部操作栏（吸底） */}
      <div className="fixed bottom-0 inset-x-0 z-20 flex items-center justify-between gap-3 px-5 py-4"
        style={{ background: 'linear-gradient(to top, #08080b 60%, rgba(8,8,11,0))' }}>
        <button
          onClick={skip}
          className="text-xs text-white/45 hover:text-white/70 transition-colors underline underline-offset-2"
        >
          {COPY.skip}
        </button>
        <div className="flex items-center gap-2">
          {step > 0 && (
            <button
              onClick={goPrev}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium bg-white/10 hover:bg-white/15 text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> {COPY.prev}
            </button>
          )}
          <button
            onClick={goNext}
            disabled={!canAdvance}
            className="flex items-center gap-1.5 px-6 py-2.5 rounded-xl text-sm font-semibold text-black transition-all active:scale-[0.98]"
            style={{
              background: canAdvance ? GOLD : 'rgba(255,255,255,0.12)',
              color: canAdvance ? '#000' : 'rgba(255,255,255,0.4)',
              boxShadow: canAdvance ? `0 8px 24px ${GOLD}44` : 'none',
              cursor: canAdvance ? 'pointer' : 'not-allowed',
            }}
          >
            {isLast ? COPY.finish : COPY.next} <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
