/**
 * 共振「使用须知 / 免责声明」：首次进入共振模式时显示，5 秒倒计时后才可确认。
 * 文案与 docs/resonance-design.md 第 8 节一致（插件使用须知用同一份精简版）。
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ShieldCheck } from 'lucide-react'

export const RESONANCE_NOTICE_ACK_KEY = 'waveforge:resonance-notice-ack'
const COUNTDOWN_SECONDS = 5

export const RESONANCE_NOTICE_TITLE = '共振 · 一起听'

/**
 * 免责声明条目：这里是**风险与边界告知**，不是功能介绍。
 *
 * 按用户反馈改写过：须知要说清「这个功能怎么连、数据去哪、不会做什么」，
 * 而不是把玩法介绍再抄一遍。UI 与插件清单共用这一份文案，避免两处走样。
 */
export const RESONANCE_NOTICE_POINTS: Array<{ title: string; text: string }> = [
  {
    title: '点对点直连，不经我们的服务器',
    text: '共振是 P2P 架构：房间由房主主持，成员直接连房主，我们不运营任何中转或账号服务器，也不会上传你的听歌记录、账号或任何统计数据。',
  },
  {
    title: '全程端到端加密',
    text: '房间消息用 XChaCha20-Poly1305 加密，密钥由邀请串携带、不在网络上传输；中转只转发密文。房主在技术上可解密房间内容（与群聊主持人相同），可用房间指纹当面核对。',
  },
  {
    title: '不共享会员，不绕过版权限制',
    text: '各自用自己账号的音源播放，任何人的会员权益都不会被共享或借用。你听不了的歌就是听不了——我们会说明原因，房间可发起跳过投票（当前在线人数 8 成同意即跳过）。',
  },
  {
    title: '房间内可见的信息很少',
    text: '只有你的昵称与「已登录平台 / 会员档位」徽章。平台账号、Cookie、音源地址永远不离开你的设备。',
  },
  {
    title: '请对你分享的内容负责',
    text: '房间仅限你邀请的朋友一起听，请勿用于公开传播或商业用途。邀请串里含房间密钥，只发给你信任的人。',
  },
]

export function hasAcknowledgedNotice(): boolean {
  try {
    return localStorage.getItem(RESONANCE_NOTICE_ACK_KEY) === '1'
  } catch {
    return false
  }
}

export function acknowledgeNoticeForever(): void {
  try {
    localStorage.setItem(RESONANCE_NOTICE_ACK_KEY, '1')
  } catch {
    /* localStorage 不可用时仅本次生效 */
  }
}

interface ResonanceNoticeProps {
  playerTheme?: 'dark' | 'light'
  onAccept: (remember: boolean) => void
}

export default function ResonanceNotice({ playerTheme = 'dark', onAccept }: ResonanceNoticeProps) {
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    if (remaining <= 0) return
    const timer = window.setTimeout(() => setRemaining(value => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [remaining])

  const ready = remaining <= 0
  const dark = playerTheme === 'dark'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[60] flex items-center justify-center p-6"
      style={{ backgroundColor: dark ? 'rgba(4,6,11,0.82)' : 'rgba(240,242,247,0.86)', backdropFilter: 'blur(18px)' }}
      data-tv-scope
      role="dialog"
      aria-modal="true"
      aria-labelledby="resonance-notice-title"
    >
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', damping: 26, stiffness: 300 }}
        className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-[22px] border"
        style={{
          borderColor: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
          background: dark
            ? 'linear-gradient(150deg, rgba(18,22,32,0.98), rgba(10,13,20,0.98))'
            : 'linear-gradient(150deg, rgba(255,255,255,0.99), rgba(246,248,252,0.99))',
          color: dark ? '#fff' : '#101318',
        }}
      >
        <div className="flex items-center gap-3 border-b px-6 py-5" style={{ borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: 'rgba(255,90,112,0.16)', color: '#ff5a70' }}>
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="resonance-notice-title" className="text-lg font-semibold">{RESONANCE_NOTICE_TITLE}</h2>
            <p className="mt-0.5 text-xs" style={{ color: dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }}>
              开始之前，请先花 5 秒了解房间的边界
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5 text-sm leading-relaxed">
          {RESONANCE_NOTICE_POINTS.map((point, index) => (
            <div key={point.title} className="flex gap-3">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold" style={{ background: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)' }}>
                {index + 1}
              </span>
              <p className="min-w-0">
                <span className="font-medium">{point.title}：</span>
                <span style={{ color: dark ? 'rgba(255,255,255,0.68)' : 'rgba(0,0,0,0.62)' }}>{point.text}</span>
              </p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t px-6 py-4" style={{ borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>
          <label className="flex cursor-pointer items-center gap-2 text-xs" style={{ color: dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)' }}>
            <input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} className="h-3.5 w-3.5 accent-[#ff5a70]" />
            不再提示
          </label>
          <span className="flex-1" />
          <button
            type="button"
            disabled={!ready}
            onClick={() => onAccept(remember)}
            className="flex h-10 items-center gap-2 rounded-full px-5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-55"
            style={{ background: ready ? 'rgba(255,90,112,0.92)' : dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: ready ? '#fff' : dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)' }}
          >
            {ready ? '我已了解，开始使用' : `请阅读（剩余 ${remaining}s）`}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
