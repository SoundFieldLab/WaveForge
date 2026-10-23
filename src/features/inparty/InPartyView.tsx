/**
 * In Party 模式根：免责声明闸门 → 大厅（档案 + 房间列表 + 创建/加入）/ 房间。
 *
 * 布局约定（对照共振/探索模式）：内容区全宽利用，max-w 仅作超宽屏兜底；
 * 大厅三栏（档案｜房间列表｜创建/加入）铺满可视宽度，不再留大片空白。
 * 数据与规则在 session（单例）里；本组件负责装配、档案编辑与交互编排。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Users, Settings2, ArrowLeft, Loader2, Send, Image as ImageIcon, Mic, Square, X, Pencil,
  LogOut, Crown, Volume2, Copy, Check, Video, VideoOff, Hand, Eye, RefreshCw, Radio,
  Clock, EyeOff, Trash2, MonitorUp, Link2, Timer, Zap, Dices, Bell, UserPlus, Music2,
  ScrollText, AtSign, ShieldBan, SlidersHorizontal, Coffee, Hourglass, MicOff, MessageCircle, Gamepad2, HeartHandshake, TrafficCone, Zap as ZapIcon, Music4, Trophy,
  Heart, ThumbsUp, Laugh, Flame,
} from 'lucide-react'
import ModeSelectionPanel from '../../components/ModeSelectionPanel'
import { useModeParked } from '../../utils/modeLayer'
import { getInPartySession, type InPartySessionSnapshot } from './session'
import { compressImage, useCameraBroadcast, useVoiceRoom } from './call'
import { DICE_SLOTS, GAME_HINT, GAME_LABEL, type GameKind } from './games'
import { AvatarImagePicker, FancySelect, HotkeyCapture } from './controls'
import { QRCodeSVG } from 'qrcode.react'
import { AchievementToastLayer } from './AchievementToast'
import { readPanicKeys, savePanicKeys } from './settings'
import { ACHIEVEMENTS, achievementSummary, displayDef, readUnlockedAchievements, type AchievementRecord } from './achievements'
import {
  ensureLocalProfile, readEntryMode, readFriends, readInPartySettings, readRecentRooms,
  rememberEntryMode, rememberPassword, rememberRecentRoom, removeFriend, removeRecentRoom,
  saveLocalProfile, setInPartySetting, upsertFriend,
  INPARTY_SETTINGS_EVENT, type InPartySettings, type RecentRoomEntry,
} from './settings'
import {
  readDeviceSettings, saveDeviceSettings, unlockCountdown, resetDeviceGuard, peekDeviceGuard,
  type CoyoteDeviceSettings,
} from './deviceSettings'
import {
  INPARTY_AUDIO_MAX_SEC, INPARTY_CHAT_LIMIT, INPARTY_IMAGE_MAX_EDGE, INPARTY_MAX_MEMBERS,
  QUICK_STRENGTH_PRESETS, ROULETTE_SLOTS,
  type ControlPolicy, type ControlLogEntry, type PartyMember, type PartyProfile, type QuickActionId, type QuickChannel,
} from './model'

const GOLD = '#FFE89C'
const GOLD_DEEP = '#d9bd6e'
const PANEL = 'rgba(255,255,255,0.045)'
const PANEL_2 = 'rgba(255,255,255,0.03)'
const BORDER = 'rgba(255,232,156,0.14)'

const MODE_LABEL: Record<string, string> = {
  explore: '探索', minimal: '简约', traditional: '传统', desktop: '桌面',
}

/** 全屏容器：内容铺满（超宽屏兜底 max-w-[1680px]），与探索/简约模式一致 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <AchievementToastLayer />
      {children}
    </div>
  )
}

function useSessionSnapshot(): InPartySessionSnapshot {
  const session = getInPartySession()
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
}

/** 头像（本地生成：emoji + 渐变底） */
function PartyAvatar({ profile, size = 36, ring }: { profile: { avatarEmoji: string; avatarGradient: [string, string]; avatarImage?: string; nickname: string }; size?: number; ring?: string }) {
  // 自定义头像图优先（成员卡上传的图片随档案广播，其他人也能看到）
  if (profile.avatarImage) {
    return (
      <span
        className="inline-flex shrink-0 select-none overflow-hidden rounded-full"
        style={{
          width: size, height: size,
          boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
        }}
        title={profile.nickname}
      >
        <img src={profile.avatarImage} alt={profile.nickname} className="h-full w-full object-cover" />
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded-full shrink-0 select-none"
      style={{
        width: size, height: size, fontSize: size * 0.55,
        background: `linear-gradient(135deg,${profile.avatarGradient[0]},${profile.avatarGradient[1]})`,
        boxShadow: ring ? `0 0 0 2px ${ring}` : undefined,
      }}
      title={profile.nickname}
    >
      {profile.avatarEmoji}
    </span>
  )
}

/** 文本渲染：@昵称 高亮 */
function renderTextWithMentions(text: string, members: PartyMember[]): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const parts = text.split(/(@[^s@]+)/g)
  for (const part of parts) {
    if (part.startsWith('@') && members.some(m => m.nickname === part.slice(1))) {
      nodes.push(<span key={part + nodes.length} className="rounded px-1 font-medium" style={{ background: 'rgba(255,232,156,0.16)', color: GOLD }}>{part}</span>)
    } else {
      nodes.push(part)
    }
  }
  return nodes
}

/** 表情回应条（悬停消息时显示 + 已回应计数） */
const REACTION_EMOJIS = ['👍', '❤️', '😂', '🔥', '😮', '😢']

function ReactionBar({ snapshot, messageId, onToggle }: {
  snapshot: InPartySessionSnapshot
  messageId: string
  onToggle: (messageId: string, emoji: string) => void
}) {
  const reactions = snapshot.reactions[messageId] ?? {}
  const selfId = getInPartySession().getProfile()?.peerId || ''
  return (
    <div className="mt-1 flex items-center gap-1">
      {REACTION_EMOJIS.map(emoji => {
        const users = reactions[emoji] ?? []
        const mine = users.includes(selfId)
        return (
          <button
            key={emoji} type="button"
            onClick={() => onToggle(messageId, emoji)}
            className={'flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] transition-colors ' + (mine ? '' : 'opacity-55 hover:opacity-100')}
            style={{ background: mine ? 'rgba(255,232,156,0.16)' : 'rgba(255,255,255,0.06)' }}
          >
            {emoji}{users.length > 0 && <span className="text-white/60">{users.length}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** 图片灯箱（点开全屏看） */
function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[98] flex items-center justify-center bg-black/88 p-8" onClick={onClose}
    >
      <img src={src} alt="图片" className="max-h-full max-w-full rounded-xl object-contain" onClick={e => e.stopPropagation()} />
      <button type="button" onClick={onClose} className="absolute right-5 top-5 rounded-xl bg-white/10 p-2 text-white/80 hover:bg-white/20">
        <X className="h-5 w-5" />
      </button>
    </motion.div>
  )
}

/** 轻量输入弹窗（替代 window.prompt：原生弹框在深色主题里非常突兀且不可粘贴长文本） */
function PromptModal({ title, placeholder, initialValue = '', confirmText = '确定', onConfirm, onClose }: {
  title: string
  placeholder?: string
  initialValue?: string
  confirmText?: string
  onConfirm: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])
  const submit = () => { onConfirm(value.trim()); onClose() }
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[97] flex items-center justify-center p-6"
      style={{ backgroundColor: 'rgba(2,2,4,0.72)', backdropFilter: 'blur(10px)' }} onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.94, y: 12, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.94, y: 12, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-xs rounded-2xl border p-5"
        style={{ background: 'linear-gradient(160deg,#12100a,#0b0b0e)', borderColor: BORDER }}
      >
        <p className="text-sm font-bold text-white/90">{title}</p>
        <input
          ref={inputRef} value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit(); if (e.key === 'Escape') onClose() }}
          placeholder={placeholder}
          maxLength={80}
          className="mt-3 w-full rounded-xl bg-black/40 border px-3 py-2 text-sm text-white/90 outline-none focus:border-amber-300/40"
          style={{ borderColor: BORDER }}
        />
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border py-2 text-xs text-white/55 hover:bg-white/[0.06]" style={{ borderColor: BORDER }}>取消</button>
          <button
            type="button" onClick={submit} disabled={!value.trim()}
            className="flex-1 rounded-xl py-2 text-xs font-bold text-black transition-opacity disabled:opacity-40"
            style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}
          >
            {confirmText}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

/** 语音消息气泡（自绘播放器：进度条金色调，替代原生控件的突兀白块） */
function VoiceBubble({ src, durationSec, mine }: { src: string; durationSec: number; mine: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const seconds = Math.max(1, Math.round(durationSec || 0))
  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) { audio.pause(); return }
    void audio.play()
  }
  return (
    <button
      type="button" onClick={toggle}
      className="flex items-center gap-2.5 rounded-full px-3 py-2 min-w-[180px]"
      style={{ background: mine ? 'rgba(255,232,156,0.14)' : 'rgba(255,255,255,0.06)' }}
    >
      <span
        className="flex h-8 w-8 items-center justify-center rounded-full shrink-0 text-black"
        style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}
      >
        {playing
          ? <span className="flex gap-[3px]"><span className="h-3 w-[3px] bg-black" /><span className="h-3 w-[3px] bg-black" /></span>
          : <span className="ml-0.5 h-0 w-0 border-y-[6px] border-l-[9px] border-y-transparent border-l-black" />}
      </span>
      <span className="flex flex-1 items-center gap-[2px]" aria-hidden>
        {Array.from({ length: 22 }).map((_, index) => {
          const active = (index / 22) < progress
          const height = 5 + Math.abs(Math.sin(index * 1.7)) * 12
          return <span key={index} className="w-[2px] rounded-full transition-colors" style={{ height, background: active ? GOLD : 'rgba(255,255,255,0.22)' }} />
        })}
      </span>
      <span className="text-[10px] tabular-nums text-white/50">{seconds}s</span>
      <audio
        ref={audioRef} src={src} preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0) }}
        onTimeUpdate={(e) => {
          const audio = e.currentTarget
          if (audio.duration) setProgress(audio.currentTime / audio.duration)
        }}
      />
    </button>
  )
}

/** 成员详情卡（交友式：资料 + 正在听 + 互控/私聊/看摄像头/加好友） */
function MemberCard({ member, onClose, canControl, onRequestControl, onWatch, watching, onChat, onAddFriend, isFriend, onOpenCoyote, onMute, muted, isHostView, onRemark, remark, onPromote, isAdminTarget, roomHostId }: {
  member: PartyMember
  onClose: () => void
  canControl: boolean
  onRequestControl: () => void
  onWatch: () => void
  watching: boolean
  onChat: () => void
  onAddFriend: () => void
  isFriend: boolean
  onOpenCoyote: () => void
  /** 房主视角：禁言/解除（分钟） */
  onMute?: (minutes: number) => void
  muted?: boolean
  isHostView?: boolean
  onRemark?: (name: string) => void
  remark?: string
  onPromote?: (peerId: string) => void
  isAdminTarget?: boolean
  roomHostId?: string
}) {
  const POLICY_LABEL: Record<ControlPolicy, string> = { off: '不接受控制', ask: '需要询问', open: '开放控制' }
  const [remarkPromptOpen, setRemarkPromptOpen] = useState(false)
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[96] flex items-center justify-center p-6"
      style={{ backgroundColor: 'rgba(2,2,4,0.7)', backdropFilter: 'blur(10px)' }} onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, y: 14, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.92, y: 14, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-sm rounded-3xl border p-6"
        style={{ background: 'linear-gradient(160deg,#12100a,#0b0b0e)', borderColor: BORDER }}
      >
        <div className="flex items-center gap-4">
          <PartyAvatar profile={member} size={64} ring={member.online ? GOLD : 'rgba(255,255,255,0.2)'} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-white truncate">{remark ? `${member.nickname}（${remark}）` : member.nickname}</h3>
              {member.online
                ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-400/15 text-emerald-300">在线</span>
                : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 text-white/40">离线</span>}
            </div>
            {member.bio && <p className="text-xs text-white/50 mt-0.5 truncate">{member.bio}</p>}
          </div>
        </div>
        <div className="mt-4 space-y-2 text-xs">
          <div className="flex items-center justify-between rounded-xl px-3 py-2" style={{ background: PANEL }}>
            <span className="text-white/50">DG-LAB 设备</span>
            <span style={{ color: member.device.connected ? GOLD : 'rgba(255,255,255,0.35)' }}>
              {member.device.connected ? `已连接 · ${member.device.version === 'v4' ? '4.0' : '3.0'}` : '未连接'}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-xl px-3 py-2" style={{ background: PANEL }}>
            <span className="text-white/50">控制策略</span>
            <span className="text-white/80">{POLICY_LABEL[member.controlPolicy]}</span>
          </div>
          <div className="flex items-center justify-between rounded-xl px-3 py-2" style={{ background: PANEL }}>
            <span className="flex items-center gap-1.5 text-white/50"><SlidersHorizontal className="h-3.5 w-3.5" style={{ color: GOLD }} />郊狼设备设置</span>
            <button type="button" onClick={() => { onOpenCoyote(); onClose() }} className="rounded-lg px-2 py-0.5 text-[10px]" style={{ background: 'rgba(255,232,156,0.1)', color: GOLD }}>
              调整
            </button>
          </div>
          <div className="flex items-center justify-between rounded-xl px-3 py-2" style={{ background: PANEL }}>
            <span className="flex items-center gap-1.5 text-white/50"><Music2 className="h-3.5 w-3.5" />正在听</span>
            {member.nowPlaying
              ? <span className="max-w-[60%] truncate text-white/80" title={member.nowPlaying.title}>
                  {member.nowPlaying.playing ? '' : '⏸ '}{member.nowPlaying.title || '未知'}{member.nowPlaying.artists ? ' · ' + member.nowPlaying.artists : ''}
                </span>
              : <span className="text-white/30">没有在听 / 未分享</span>}
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button" disabled={isFriend} onClick={() => { onAddFriend(); onClose() }}
            className="flex items-center justify-center gap-1.5 rounded-2xl py-2.5 text-[11px] border transition-colors disabled:opacity-40"
            style={{ background: PANEL, borderColor: BORDER, color: isFriend ? 'rgba(255,255,255,0.4)' : GOLD }}
          >
            {isFriend ? <Check className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}{isFriend ? '已是好友' : '加好友'}
          </button>
          <button
            type="button" onClick={() => { onChat(); onClose() }}
            className="flex items-center justify-center gap-1.5 rounded-2xl py-2.5 text-[11px] border transition-colors"
            style={{ background: PANEL, borderColor: BORDER, color: 'rgba(255,255,255,0.8)' }}
          >
            <Send className="w-4 h-4" />私聊
          </button>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <button
            type="button" disabled={!canControl} onClick={() => { onRequestControl(); onClose() }}
            className="flex flex-col items-center gap-1 rounded-2xl py-3 text-[11px] border transition-colors disabled:opacity-35"
            style={{ background: PANEL, borderColor: BORDER, color: canControl ? GOLD : 'rgba(255,255,255,0.4)' }}
          >
            <Hand className="w-4 h-4" />{canControl ? '可控制' : '申请控制'}
          </button>
          <button
            type="button" onClick={() => { onChat(); onClose() }}
            className="flex flex-col items-center gap-1 rounded-2xl py-3 text-[11px] border transition-colors"
            style={{ background: PANEL, borderColor: BORDER, color: 'rgba(255,255,255,0.8)' }}
          >
            <Send className="w-4 h-4" />私聊
          </button>
          <button
            type="button" disabled={!watching} onClick={() => { onWatch(); onClose() }}
            className="flex flex-col items-center gap-1 rounded-2xl py-3 text-[11px] border transition-colors disabled:opacity-35"
            style={{ background: PANEL, borderColor: BORDER, color: watching ? GOLD : 'rgba(255,255,255,0.4)' }}
          >
            <Eye className="w-4 h-4" />{watching ? '关闭画面' : '看摄像头'}
          </button>
        </div>
        {isHostView && member.peerId !== roomHostId && (
          <button
            type="button" onClick={() => { onPromote?.(member.peerId); onClose() }}
            className="mt-2 w-full rounded-2xl border py-2.5 text-[11px] transition-colors"
            style={{ background: 'rgba(255,232,156,0.08)', borderColor: GOLD + '55', color: GOLD }}
          >
            {isAdminTarget ? '撤回管理员' : '任命为管理员'}
          </button>
        )}
        {isHostView && (
          <div className="mt-2 flex gap-2">
            <button
              type="button" onClick={() => { onMute?.(muted ? 0 : 10); onClose() }}
              className="flex-1 rounded-2xl border py-2.5 text-[11px] transition-colors"
              style={{ background: muted ? 'rgba(52,211,153,0.12)' : 'rgba(255,90,60,0.1)', borderColor: muted ? 'rgba(52,211,153,0.4)' : 'rgba(255,120,90,0.4)', color: muted ? '#6ee7b7' : '#ff9c8a' }}
            >
              {muted ? '解除禁言' : '禁言 10 分钟'}
            </button>
            <button
              type="button" onClick={() => setRemarkPromptOpen(true)}
              className="flex-1 rounded-2xl border py-2.5 text-[11px] text-white/70"
              style={{ background: PANEL, borderColor: BORDER }}
            >
              {remark ? '修改备注' : '设备注'}
            </button>
          </div>
        )}
        <AnimatePresence>
          {remarkPromptOpen && (
            <PromptModal
              title="好友备注（留空清除）"
              initialValue={remark || ''}
              confirmText="保存"
              onConfirm={name => { onRemark?.(name); onClose() }}
              onClose={() => setRemarkPromptOpen(false)}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  )
}

/** 附近房间列表条目 */
interface DiscoveredRoom {
  address: string
  port: number
  name: string
  memberCount: number
  open: boolean
  kind: string
  visibility: 'public' | 'private'
  roomName?: string
}

/** 房间列表：附近（局域网扫描，实时）+ 最近（本机记录） */
function RoomBrowser({ settings, busy, onJoinDiscovery, onJoinRecent, onRefresh }: {
  settings: InPartySettings
  busy: boolean
  onJoinDiscovery: (room: DiscoveredRoom) => void
  onJoinRecent: (entry: RecentRoomEntry) => void
  onRefresh: () => void
}) {
  const [discovered, setDiscovered] = useState<DiscoveredRoom[]>([])
  const [scanning, setScanning] = useState(false)
  const [recent, setRecent] = useState<RecentRoomEntry[]>(() => readRecentRooms())
  const [tab, setTab] = useState<'nearby' | 'recent'>('nearby')
  const [removingInvite, setRemovingInvite] = useState<string | null>(null)

  const scan = useCallback(async () => {
    if (!settings.lanDiscovery) { setDiscovered([]); return }
    setScanning(true)
    try {
      const list = (await window.electron?.resonance?.scanLan() ?? []) as DiscoveredRoom[]
      setDiscovered(list.filter(item => item.kind === 'inparty'))
    } catch { /* 扫描失败保持空 */ } finally { setScanning(false) }
  }, [settings.lanDiscovery])

  useEffect(() => { void scan() }, [scan])
  // 最近列表在挂载/移除后同步
  useEffect(() => { setRecent(readRecentRooms()) }, [])

  return (
    <section className="flex min-h-[320px] flex-col rounded-3xl border" style={{ background: PANEL, borderColor: BORDER }}>
      <div className="flex items-center gap-2 px-5 pt-4">
        <h2 className="text-sm font-bold text-white/85">房间列表</h2>
        <div className="ml-auto flex items-center gap-1">
          {(['nearby', 'recent'] as const).map(key => (
            <button
              key={key} type="button" onClick={() => setTab(key)}
              className={`rounded-lg px-2.5 py-1 text-[11px] transition-colors ${tab === key ? 'text-black' : 'text-white/50 hover:text-white/85'}`}
              style={tab === key ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : undefined}
            >
              {key === 'nearby' ? '附近' : '最近'}
            </button>
          ))}
          {tab === 'nearby' && (
            <button type="button" onClick={() => { onRefresh(); void scan() }} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10" title="重新扫描">
              <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 pt-3">
        {tab === 'nearby' ? (
          !settings.lanDiscovery ? (
            <p className="py-10 text-center text-xs text-white/35">局域网发现已关闭（设置里可打开）</p>
          ) : discovered.length === 0 ? (
            <div className="py-10 text-center">
              {scanning
                ? <p className="text-xs text-white/40 flex items-center justify-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在扫描同一网络…</p>
                : <p className="text-xs text-white/35">附近没有正在进行的派对<br /><span className="text-[10px] text-white/25">公开房会出现在这里；私有房要房主发邀请</span></p>}
            </div>
          ) : discovered.map(room => (
            <button
              key={`${room.address}:${room.port}`} type="button" disabled={busy}
              onClick={() => onJoinDiscovery(room)}
              className="flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors hover:bg-white/[0.07] disabled:opacity-50"
              style={{ background: PANEL_2, borderColor: BORDER }}
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl text-black" style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}>
                <Radio className="h-4.5 w-4.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-white/90">{room.roomName || `${room.name} 的房间`}</span>
                  {room.visibility === 'public' && <span className="shrink-0 rounded-full bg-emerald-400/12 px-1.5 py-0.5 text-[9px] text-emerald-300">公开</span>}
                </span>
                <span className="mt-0.5 block text-[10px] text-white/35">{room.name} · {room.address}</span>
              </span>
              <span className="flex items-center gap-1 text-[11px] text-white/50"><Users className="h-3 w-3" />{room.memberCount}</span>
            </button>
          ))
        ) : recent.length === 0 ? (
          <p className="py-10 text-center text-xs text-white/35">还没有加入过房间</p>
        ) : recent.map(entry => (
          <div
            key={entry.invite} className={`flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors ${removingInvite === entry.invite ? '' : 'hover:bg-white/[0.07]'}`}
            style={{ background: PANEL_2, borderColor: BORDER }}
            onMouseEnter={() => setRemovingInvite(entry.invite)}
            onMouseLeave={() => setRemovingInvite(null)}
          >
            <button type="button" disabled={busy} onClick={() => onJoinRecent(entry)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: 'rgba(255,232,156,0.1)', color: GOLD }}>
                <Clock className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-white/90">{entry.name || '未命名房间'}</span>
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] ${entry.visibility === 'private' ? 'bg-orange-400/12 text-orange-300' : 'bg-emerald-400/12 text-emerald-300'}`}>
                    {entry.visibility === 'private' ? '私有' : '公开'}
                  </span>
                </span>
                <span className="mt-0.5 block text-[10px] text-white/35">{new Date(entry.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </span>
            </button>
            {removingInvite === entry.invite && (
              <button
                type="button" title="移除记录"
                onClick={() => { setRecent(removeRecentRoom(entry.invite)) }}
                className="rounded-lg p-1.5 text-white/30 hover:bg-red-400/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/** 郊狼设备设置（对照 DG-LAB App：远程上限/倒计时停/工作休息/跳变保护/自动增强/延迟/频率）。
 *  控制「我的设备接受什么样的远端输入」——对每个成员的设备独立记忆。 */
function CoyoteSettingsModal({ memberPeerId, memberName, onClose }: { memberPeerId: string; memberName: string; onClose: () => void }) {
  const [settings, setSettings] = useState<CoyoteDeviceSettings>(() => readDeviceSettings(memberPeerId))
  const guard = peekDeviceGuard(memberPeerId)
  const save = (patch: Partial<CoyoteDeviceSettings>) => setSettings(saveDeviceSettings(memberPeerId, patch))
  const row = 'flex items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5'
  const toggle = (on: boolean, onClick: () => void) => (
    <button type="button" role="switch" aria-checked={on} onClick={onClick}
      className={'relative h-5 w-9 shrink-0 rounded-full transition-colors ' + (on ? '' : 'bg-white/15')}
      style={on ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : undefined}>
      <span className={'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ' + (on ? 'translate-x-4' : '')} />
    </button>
  )
  const num = (value: number, onChange: (n: number) => void, min: number, max: number, disabled = false) => (
    <input type="number" min={min} max={max} value={value} disabled={disabled}
      onChange={e => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
      className="no-spinner w-14 shrink-0 rounded-lg border bg-black/50 px-1.5 py-1 text-center text-xs text-white/85 outline-none disabled:opacity-40"
      style={{ borderColor: BORDER }} />
  )

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[97] flex items-center justify-center p-6"
      style={{ backgroundColor: 'rgba(2,2,4,0.74)', backdropFilter: 'blur(10px)' }} onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.94, y: 14, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.94, y: 14, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="max-h-[82vh] w-full max-w-md overflow-y-auto rounded-3xl border p-5"
        style={{ background: 'linear-gradient(160deg,#12100a,#0b0b0e)', borderColor: BORDER }}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-bold text-white"><SlidersHorizontal className="h-4 w-4" style={{ color: GOLD }} />郊狼设备 · {memberName}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
        <p className="mt-1 text-[10px] text-white/35">控制「远端成员能把你的设备打到什么程度」；与 DG-LAB App 同名设置同一套语义，只存本机</p>

        <div className="mt-3 space-y-2">
          <div className={row} style={{ background: PANEL }}>
            <div className="min-w-0">
              <p className="text-xs text-white/85">远程强度上限 <span className="text-white/35">(A / B，0-200)</span></p>
              <p className="text-[9.5px] text-white/35">App「远程控制」模式的独立上限——远端一切指令的硬顶</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {(['A', 'B'] as const).map(ch => (
                <input key={ch} type="number" min={0} max={200} value={settings.remoteStrengthUL[ch]}
                  onChange={e => save({ remoteStrengthUL: { ...settings.remoteStrengthUL, [ch]: Math.max(0, Math.min(200, Number(e.target.value) || 0)) } })}
                  className="no-spinner w-14 rounded-lg border bg-black/50 px-1.5 py-1 text-center text-xs text-white/85 outline-none"
                  style={{ borderColor: BORDER }} />
              ))}
            </div>
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs text-white/85"><ShieldBan className="h-3.5 w-3.5" style={{ color: GOLD }} />强度跳变保护</p>
              <p className="text-[9.5px] text-white/35">远端单次调整最多 ±N（防恶意识拉）</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {toggle(settings.strengthJump.enabled, () => save({ strengthJump: { ...settings.strengthJump, enabled: !settings.strengthJump.enabled } }))}
              {num(settings.strengthJump.max, n => save({ strengthJump: { ...settings.strengthJump, max: n } }), 1, 60, !settings.strengthJump.enabled)}
            </div>
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs text-white/85"><Hourglass className="h-3.5 w-3.5" style={{ color: GOLD }} />倒计时停止</p>
              <p className="text-[9.5px] text-white/35">远端开始输出 N 分钟后自动归零锁定{guard?.countdownTriggered ? ' · 已触发！' : ''}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {toggle(settings.countdownstop.enabled, () => save({ countdownstop: { ...settings.countdownstop, enabled: !settings.countdownstop.enabled } }))}
              {num(settings.countdownstop.minutes, n => save({ countdownstop: { ...settings.countdownstop, minutes: n } }), 1, 120, !settings.countdownstop.enabled)}
            </div>
          </div>
          {guard?.countdownTriggered && (
            <button type="button" onClick={() => { unlockCountdown(memberPeerId); setSettings({ ...settings }) }} className="w-full rounded-xl py-2 text-[11px] font-bold text-black" style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}>
              倒计时已触发 · 点我复位继续
            </button>
          )}
          <div className={row} style={{ background: PANEL }}>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs text-white/85"><Coffee className="h-3.5 w-3.5" style={{ color: GOLD }} />工作休息循环</p>
              <p className="text-[9.5px] text-white/35">工作 N 分 → 休息 M 分自动交替{guard?.resting ? ' · 休息中' : guard?.cycle?.phase === 'work' ? ' · 工作中' : ''}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {num(settings.workRest.workMinutes, n => save({ workRest: { ...settings.workRest, workMinutes: n } }), 1, 60, !settings.workRest.enabled)}
              <span className="text-[10px] text-white/40">/</span>
              {num(settings.workRest.restMinutes, n => save({ workRest: { ...settings.workRest, restMinutes: n } }), 1, 60, !settings.workRest.enabled)}
              {toggle(settings.workRest.enabled, () => { save({ workRest: { ...settings.workRest, enabled: !settings.workRest.enabled } }); resetDeviceGuard(memberPeerId) })}
            </div>
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div className="min-w-0">
              <p className="text-xs text-white/85">自动增强限制</p>
              <p className="text-[9.5px] text-white/35">远端连续拉强度时每秒最多 +N</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {toggle(settings.autoAddLimit.enabled, () => save({ autoAddLimit: { ...settings.autoAddLimit, enabled: !settings.autoAddLimit.enabled } }))}
              {num(settings.autoAddLimit.perSecond, n => save({ autoAddLimit: { ...settings.autoAddLimit, perSecond: n } }), 1, 60, !settings.autoAddLimit.enabled)}
            </div>
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div className="min-w-0">
              <p className="text-xs text-white/85">延迟启动</p>
              <p className="text-[9.5px] text-white/35">远端首次输出前等 N 秒（留贴片时间）</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {toggle(settings.delayStart.enabled, () => save({ delayStart: { ...settings.delayStart, enabled: !settings.delayStart.enabled } }))}
              {num(settings.delayStart.seconds, n => save({ delayStart: { ...settings.delayStart, seconds: n } }), 1, 30, !settings.delayStart.enabled)}
            </div>
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div className="min-w-0">
              <p className="text-xs text-white/85">波形频率上限 <span className="text-white/35">(Hz，App 默认 160)</span></p>
              <p className="text-[9.5px] text-white/35">远端脉冲帧频率的最高值（×2 上限校验）</p>
            </div>
            {num(settings.freqPara, n => save({ freqPara: n }), 1, 240)}
          </div>
        </div>
        <button type="button" onClick={onClose} className="mt-4 w-full rounded-2xl py-2.5 text-xs font-bold text-black" style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}>完成</button>
      </motion.div>
    </motion.div>
  )
}

/** 设置弹窗（真面板：人数/策略/端口/发现/视频/摄像头安全） */
function SettingsModal({ settings, onClose, panicKeys, onSavePanicKeys }: { settings: InPartySettings; onClose: () => void; panicKeys: string[]; onSavePanicKeys: (keys: string[]) => void }) {
  const row = 'flex items-center justify-between gap-4 rounded-2xl px-4 py-3'
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[96] flex items-center justify-center p-6"
      style={{ backgroundColor: 'rgba(2,2,4,0.72)', backdropFilter: 'blur(10px)' }} onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.94, y: 14, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.94, y: 14, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-3xl border p-6"
        style={{ background: 'linear-gradient(160deg,#12100a,#0b0b0e)', borderColor: BORDER }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-white">In Party 设置</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-4 space-y-2.5">
          <div className={row} style={{ background: PANEL }}>
            <div>
              <p className="text-sm text-white/85">房间人数上限</p>
              <p className="text-[10.5px] text-white/40">含房主；2–{INPARTY_MAX_MEMBERS} 人</p>
            </div>
            <FancySelect
              value={settings.maxMembers}
              options={[5, 8, 10, 15, 20, 30, 50].map(n => ({ value: n, label: n + ' 人' }))}
              onChange={n => setInPartySetting('maxMembers', n)}
              width={110}
            />
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div>
              <p className="text-sm text-white/85">我的控制策略</p>
              <p className="text-[10.5px] text-white/40">别人怎么才能控制你的设备</p>
            </div>
            <FancySelect
              value={settings.controlPolicy}
              options={[
                { value: 'off' as ControlPolicy, label: '不接受任何控制' },
                { value: 'ask' as ControlPolicy, label: '每次询问我' },
                { value: 'open' as ControlPolicy, label: '房间内直接开放' },
              ]}
              onChange={v => setInPartySetting('controlPolicy', v)}
              width={150}
            />
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div>
              <p className="text-sm text-white/85">允许局域网发现</p>
              <p className="text-[10.5px] text-white/40">关掉后别人扫不到你的公开房</p>
            </div>
            <button
              type="button" role="switch" aria-checked={settings.lanDiscovery}
              onClick={() => setInPartySetting('lanDiscovery', !settings.lanDiscovery)}
              className={`relative h-6 w-11 rounded-full transition-colors ${settings.lanDiscovery ? '' : 'bg-white/15'}`}
              style={settings.lanDiscovery ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : undefined}
            >
              <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.lanDiscovery ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div>
              <p className="text-sm text-white/85">中继端口</p>
              <p className="text-[10.5px] text-white/40">占用时自动顺延 +1（最多 10 个）</p>
            </div>
            <input
              type="number" min={1024} max={65535} value={settings.port}
              onChange={e => setInPartySetting('port', Number(e.target.value) || 25570)}
              className="no-spinner w-24 rounded-lg border bg-black/50 px-2.5 py-1.5 text-xs text-white/85 outline-none"
              style={{ borderColor: BORDER }}
            />
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div>
              <p className="text-sm text-white/85">摄像头广播</p>
              <p className="text-[10.5px] text-white/40">允许在房间里直接开摄像头</p>
            </div>
            <button
              type="button" role="switch" aria-checked={settings.videoAllowed}
              onClick={() => setInPartySetting('videoAllowed', !settings.videoAllowed)}
              className={`relative h-6 w-11 rounded-full transition-colors ${settings.videoAllowed ? '' : 'bg-white/15'}`}
              style={settings.videoAllowed ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : undefined}
            >
              <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.videoAllowed ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div>
              <p className="flex items-center gap-1.5 text-sm text-white/85"><Timer className="h-3.5 w-3.5" style={{ color: GOLD }} />摄像头自动停止</p>
              <p className="text-[10.5px] text-white/40">安全倒计时：到点自动关摄像头（观众可见剩余时间）</p>
            </div>
            <FancySelect
              value={settings.cameraAutoStop}
              options={[
                { value: 0, label: '不自动停' },
                { value: 60, label: '1 分钟' },
                { value: 180, label: '3 分钟' },
                { value: 600, label: '10 分钟' },
              ]}
              onChange={v => setInPartySetting('cameraAutoStop', v)}
              width={110}
            />
          </div>
          <div className={row} style={{ background: PANEL }}>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm text-white/85"><EyeOff className="h-3.5 w-3.5" style={{ color: GOLD }} />一键全黑快捷键</p>
              <p className="text-[10.5px] text-white/40">仅 In Party 模式内生效：开播中立刻黑屏（流不断开），再按恢复</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button" role="switch" aria-checked={settings.cameraPanicHotkey}
                onClick={() => setInPartySetting('cameraPanicHotkey', !settings.cameraPanicHotkey)}
                className={`relative h-6 w-11 rounded-full transition-colors ${settings.cameraPanicHotkey ? '' : 'bg-white/15'}`}
                style={settings.cameraPanicHotkey ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : undefined}
              >
                <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.cameraPanicHotkey ? 'translate-x-5' : ''}`} />
              </button>
              {settings.cameraPanicHotkey && <HotkeyCapture value={panicKeys} onChange={onSavePanicKeys} />}
            </div>
          </div>
        </div>
        <p className="mt-4 text-[10px] leading-relaxed text-white/30">
          档案、最近房间、设置全部只存在本机；房间密钥随邀请串在成员间传递，不经任何服务器。
        </p>
      </motion.div>
    </motion.div>
  )
}

/** 大厅：档案 + 房间列表 + 创建/加入（三栏全宽） */
function Lobby({ settings, busy, error, onCreate, onJoin, onOpenSettings }: {
  settings: InPartySettings
  busy: boolean
  error: string
  onCreate: (options: { name: string; visibility: 'public' | 'private'; password: string }) => void
  onJoin: (invite: string, password: string, name?: string) => void
  onOpenSettings: () => void
}) {
  const session = getInPartySession()
  const [profile, setProfile] = useState<PartyProfile>(() => ensureLocalProfile())
  const [editing, setEditing] = useState(false)
  const [visibility, setVisibility] = useState<'public' | 'private'>(settings.visibility)
  const [roomName, setRoomName] = useState('')
  const [password, setPassword] = useState('')
  const [joinInvite, setJoinInvite] = useState('')
  const [joinPassword, setJoinPassword] = useState('')
  const [tab, setTab] = useState<'create' | 'join'>('create')

  const applyProfile = (patch: Partial<PartyProfile>) => {
    const next = saveLocalProfile(patch)
    setProfile(next)
    session.setProfile(next, readInPartySettings().controlPolicy)
  }

  const cycleEmoji = () => {
    const emojis = ['🐺', '🦊', '🐼', '🦁', '🐯', '🐨', '🐸', '🐙', '🦋', '🐳', '🦉', '🦄', '🔥', '⚡', '🌙', '⭐', '🎧', '🎸', '🌶️', '🍑']
    const index = emojis.indexOf(profile.avatarEmoji)
    applyProfile({ avatarEmoji: emojis[(index + 1) % emojis.length] })
  }

  const randomizeGradient = () => {
    const gradients: Array<[string, string]> = [
      ['#FFE89C', '#d9a13c'], ['#ff8fa3', '#c9184a'], ['#8ecae6', '#126782'],
      ['#b8f2c9', '#2d6a4f'], ['#cdb4db', '#6d23b6'], ['#ffd6a5', '#bc6c25'],
    ]
    applyProfile({ avatarGradient: gradients[Math.floor(Math.random() * gradients.length)] })
  }

  const canCreate = profile.nickname.trim().length > 0 && (visibility === 'public' || password.length >= 4)
  const canJoin = profile.nickname.trim().length > 0 && joinInvite.trim().length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6 pt-4">
      {error && (
        <div className="rounded-xl px-4 py-3 text-xs" style={{ background: 'rgba(255,120,90,0.14)', color: '#ffb9a8' }}>{error}</div>
      )}
      <div className="grid flex-1 gap-4 xl:grid-cols-[300px_1fr_360px] lg:grid-cols-[280px_1fr]">
        {/* 档案卡 */}
        <section className="rounded-3xl border p-5" style={{ background: PANEL, borderColor: BORDER }}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white/85">我的档案</h2>
            <button type="button" onClick={() => setEditing(v => !v)} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10" title="编辑档案">
              {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
            </button>
          </div>
          <div className="mt-4 flex items-center gap-4">
            {/* 自定义头像图（≤512KB 自动压缩；右键移除回到 emoji） */}
            <AvatarImagePicker
              image={profile.avatarImage}
              onChange={dataUrl => applyProfile({ avatarImage: dataUrl ?? undefined })}
              size={64}
            />
            <button type="button" onClick={cycleEmoji} onContextMenu={e => { e.preventDefault(); randomizeGradient() }} className="transition-transform hover:scale-105" title="点击换表情 · 右键换底色（有自定义头像时它作为无图成员的兜底显示）">
              <PartyAvatar profile={profile} size={64} ring={GOLD} />
            </button>
            <div className="min-w-0 flex-1">
              {editing ? (
                <input
                  value={profile.nickname} maxLength={16}
                  onChange={e => applyProfile({ nickname: e.target.value })}
                  placeholder="昵称"
                  className="w-full rounded-lg bg-black/40 border px-3 py-2 text-sm text-white/90 outline-none focus:border-amber-300/40"
                  style={{ borderColor: BORDER }}
                />
              ) : (
                <p className="truncate text-base font-semibold text-white">{profile.nickname || '未命名玩家'}</p>
              )}
              {editing ? (
                <input
                  value={profile.bio || ''} maxLength={40}
                  onChange={e => applyProfile({ bio: e.target.value })}
                  placeholder="一句话签名（可选）"
                  className="mt-2 w-full rounded-lg bg-black/40 border px-3 py-1.5 text-xs text-white/80 outline-none focus:border-amber-300/40"
                  style={{ borderColor: BORDER }}
                />
              ) : (
                <p className="mt-0.5 truncate text-xs text-white/45">{profile.bio || '这个人很神秘，什么都没有写'}</p>
              )}
            </div>
          </div>
          <div className="mt-4 space-y-2 text-[11px]">
            <div className="flex items-center justify-between rounded-xl px-3 py-2" style={{ background: PANEL_2 }}>
              <span className="text-white/45">控制策略</span>
              <span style={{ color: GOLD }}>
                {{ off: '不接受控制', ask: '询问后开放', open: '直接开放' }[settings.controlPolicy]}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Settings2 className="h-3.5 w-3.5 shrink-0" style={{ color: GOLD }} />
              <button type="button" onClick={onOpenSettings} className="text-white/50 underline-offset-2 hover:text-white/85 hover:underline">
                打开 In Party 设置
              </button>
            </div>
            <p className="text-white/35">档案只存在你自己的电脑里；房间内别人只看到昵称/头像/设备状态</p>
          </div>
        </section>

        {/* 房间列表（附近/最近） */}
        <RoomBrowser
          settings={settings} busy={busy}
          onRefresh={() => undefined}
          onJoinDiscovery={room => {
            // 发现条目只有 ip:port，没有邀请串密钥——向房主 /discover 无密钥可解；
            // 私有房必须邀请串。这里引导用「加入」页签：公开房直接按 discovery 组装加入
            // 邀请串密钥拿不到 → 扫描列表仅展示；点击跳到加入页签并提示要邀请串
            setTab('join')
            window.dispatchEvent(new CustomEvent('app-toast', {
              detail: { message: `「${room.roomName || room.name}」需要房主的邀请串才能加入（列表只展示公开房的存在）`, type: 'info', duration: 5000 },
            }))
          }}
          onJoinRecent={entry => {
            // 公开房直接重进；私有房把邀请串填进加入页签，只差密码（不悄悄失败）
            if (entry.visibility === 'private') {
              setTab('join')
              setJoinInvite(entry.invite)
              window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `「${entry.name || '房间'}」是私有房：输入密码后加入`, type: 'info' } }))
            } else {
              onJoin(entry.invite, '', entry.name)
            }
          }}
        />

        {/* 创建 / 加入 */}
        <section className="rounded-3xl border p-5" style={{ background: PANEL, borderColor: BORDER }}>
          <div className="flex gap-2">
            {(['create', 'join'] as const).map(key => (
              <button
                key={key} type="button" onClick={() => setTab(key)}
                className={`rounded-xl px-4 py-1.5 text-xs font-medium transition-colors ${tab === key ? 'text-black' : 'text-white/55 hover:text-white/85'}`}
                style={tab === key ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : { background: 'rgba(255,255,255,0.06)' }}
              >
                {key === 'create' ? '创建' : '加入'}
              </button>
            ))}
          </div>

          {tab === 'create' ? (
            <div className="mt-4 space-y-3.5">
              <div>
                <span className="mb-1.5 block text-xs text-white/55">房间名</span>
                <input
                  value={roomName} maxLength={24}
                  onChange={e => setRoomName(e.target.value)}
                  placeholder={`例如「${profile.nickname}的深夜场」（公开房会出现在附近列表）`}
                  className="w-full rounded-lg bg-black/40 border px-3 py-2 text-sm text-white/90 outline-none focus:border-amber-300/40"
                  style={{ borderColor: BORDER }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                {([['public', '公开房间', '附近列表可见'], ['private', '私有房间', '凭邀请串 + 密码进']] as const).map(([value, label, desc]) => (
                  <button
                    key={value} type="button" onClick={() => setVisibility(value)}
                    className={`rounded-2xl border p-3 text-left transition-all ${visibility === value ? '' : 'hover:bg-white/[0.06]'}`}
                    style={{
                      background: visibility === value ? 'rgba(255,232,156,0.08)' : PANEL_2,
                      borderColor: visibility === value ? `${GOLD}77` : BORDER,
                    }}
                  >
                    <p className="text-sm font-semibold text-white/90">{label}</p>
                    <p className="mt-0.5 text-[10px] text-white/40">{desc}</p>
                  </button>
                ))}
              </div>
              {visibility === 'private' && (
                <div>
                  <span className="mb-1.5 block text-xs text-white/55">房间密码（4-16 位，数字 / 英文 / 特殊符号）</span>
                  <input
                    value={password}
                    onChange={e => setPassword(e.target.value.replace(/[^\x21-\x7e]/g, ''))}
                    maxLength={16}
                    placeholder="例如 a1b2c3 或 p@ss"
                    className="w-full rounded-lg bg-black/40 border px-3 py-2 text-sm text-white/90 outline-none focus:border-amber-300/40"
                    style={{ borderColor: BORDER }}
                  />
                </div>
              )}
              <div className="flex items-center gap-2 text-[11px] text-white/40">
                <Users className="h-3.5 w-3.5" />
                <span>最多 {settings.maxMembers} 人（设置里可调，上限 {INPARTY_MAX_MEMBERS}）</span>
              </div>
              <button
                type="button" disabled={!canCreate || busy} onClick={() => onCreate({ name: roomName.trim() || `${profile.nickname}的房间`, visibility, password })}
                className="flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm font-bold transition-opacity disabled:opacity-40"
                style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})`, color: '#1a1408' }}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                创建我的房间
              </button>
            </div>
          ) : (
            <div className="mt-4 space-y-3.5">
              <div>
                <span className="mb-1.5 block text-xs text-white/55">房主邀请串</span>
                <textarea
                  value={joinInvite}
                  onChange={e => setJoinInvite(e.target.value)}
                  placeholder="粘贴 wf-resonance://… 邀请串"
                  rows={3}
                  className="w-full resize-none rounded-lg bg-black/40 border px-3 py-2 text-xs font-mono text-white/85 outline-none focus:border-amber-300/40"
                  style={{ borderColor: BORDER }}
                />
              </div>
              <div>
                <span className="mb-1.5 block text-xs text-white/55">房间密码（公开房留空）</span>
                <input
                  value={joinPassword}
                  onChange={e => setJoinPassword(e.target.value)}
                  placeholder="私有房必填"
                  className="w-full rounded-lg bg-black/40 border px-3 py-2 text-sm text-white/90 outline-none focus:border-amber-300/40"
                  style={{ borderColor: BORDER }}
                />
              </div>
              <button
                type="button" disabled={!canJoin || busy} onClick={() => onJoin(joinInvite.trim(), joinPassword)}
                className="flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm font-bold transition-opacity disabled:opacity-40"
                style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})`, color: '#1a1408' }}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                加入这个房间
              </button>
              <p className="text-[10px] leading-relaxed text-white/30">
                邀请串包含房间密钥，等同房间门钥匙——请只发给信任的人。私有房还需房主告知密码。
              </p>
            </div>
          )}
        </section>
      </div>

    </div>
  )
}

/** 互控面板：手动强度 + 快捷电击盘 + 波形绑定 */
function ControlDeck({ snapshot, selfPeerId, onSendOp, onQuickAction, onBindWave, onGain, session, liveLevel }: {
  snapshot: InPartySessionSnapshot
  selfPeerId: string
  onSendOp: (peerId: string, op: { kind: 'strength'; channel: 'A' | 'B'; value: number } | { kind: 'clear' }) => void
  onQuickAction: (peerId: string, actionId: QuickActionId, channel: QuickChannel) => void
  onBindWave: (peerId: string, channel: 'A' | 'B', on: boolean) => void
  onGain: (peerId: string, channel: 'A' | 'B', gain: number) => void
  session: ReturnType<typeof getInPartySession>
  /** 我的实时音频电平（波形推送预览） */
  liveLevel: { left: number; right: number }
}) {
  const targets = (snapshot.room?.members || []).filter(member => member.peerId !== selfPeerId && member.online && member.device.connected)
  const [targetId, setTargetId] = useState<string>('')
  const [channel, setChannel] = useState<'A' | 'B'>('A')
  const [value, setValue] = useState(0)
  const target = targets.find(member => member.peerId === targetId)
  const cap = target?.device.caps?.[channel] ?? 60

  useEffect(() => {
    if (!targets.some(member => member.peerId === targetId)) setTargetId(targets[0]?.peerId || '')
  }, [targets, targetId])

  if (!targets.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Hand className="h-8 w-8 text-white/20" />
        <p className="text-xs text-white/40">房间里还没有连着设备的其他成员</p>
        <p className="text-[10px] text-white/25">成员在 DG-LAB 插件里连上自己的设备后，就会出现在这里</p>
      </div>
    )
  }

  return (
    <div className="space-y-3 p-4">
      {/* 观战模式：只看不电（本地标记，安全出口之一） */}
      <button
        type="button" onClick={() => session.setSpectating(!session.getSnapshot().spectating)}
        className={'w-full rounded-xl border py-2 text-[10.5px] font-medium transition-colors ' + (session.getSnapshot().spectating ? 'ring-1' : '')}
        style={{
          borderColor: session.getSnapshot().spectating ? 'rgba(80,200,255,0.5)' : BORDER,
          background: session.getSnapshot().spectating ? 'rgba(80,200,255,0.1)' : PANEL_2,
          color: session.getSnapshot().spectating ? '#7cc4ff' : 'rgba(255,255,255,0.55)',
        }}
        title="只看热闹不参与：忽略一切远端控制与玩法惩罚，随时可退出"
      >
        {session.getSnapshot().spectating ? '👁 观战中（点击恢复参与）' : '👁 进入观战（只看不电）'}
      </button>
      <div className="flex flex-wrap gap-1.5">
        {targets.map(member => {
          const granted = (snapshot.grantsByPeer[member.peerId] || 0) > Date.now()
          const controllable = member.controlPolicy === 'open' || granted
          return (
            <button
              key={member.peerId} type="button" onClick={() => setTargetId(member.peerId)}
              className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[11px] transition-all ${targetId === member.peerId ? '' : 'opacity-70 hover:opacity-100'}`}
              style={{
                background: targetId === member.peerId ? 'rgba(255,232,156,0.1)' : PANEL_2,
                borderColor: targetId === member.peerId ? `${GOLD}88` : BORDER,
              }}
            >
              <PartyAvatar profile={member} size={20} />
              <span className="text-white/85">{member.nickname}</span>
              <span className="text-[9px] text-white/30">A{member.device.caps?.A ?? '?'}/B{member.device.caps?.B ?? '?'}</span>
              {controllable
                ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="已获得控制权" />
                : <span className="h-1.5 w-1.5 rounded-full bg-white/25" title="未获得控制权（点成员卡申请）" />}
            </button>
          )
        })}
      </div>
      {target && (
        <>
          <div className="flex gap-2">
            {(['A', 'B'] as const).map(ch => (
              <button
                key={ch} type="button" onClick={() => { setChannel(ch); setValue(0) }}
                className={`flex-1 rounded-xl py-2 text-xs font-bold transition-colors ${channel === ch ? 'text-black' : 'text-white/55'}`}
                style={channel === ch ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : { background: PANEL_2 }}
              >
                {ch === 'A' ? 'A 通道' : 'B 通道'}
              </button>
            ))}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span className="text-white/50">强度（上限 {cap}，由对方设备决定）</span>
              <span style={{ color: GOLD }} className="font-bold">{value}</span>
            </div>
            <input
              type="range" min={0} max={cap} step={1} value={value}
              onChange={e => {
                const next = Number(e.target.value)
                setValue(next)
                if (targetId) onSendOp(targetId, { kind: 'strength', channel, value: next })
              }}
              className="party-slider"
              style={{ background: `linear-gradient(90deg,${GOLD} ${cap > 0 ? (value / cap) * 100 : 0}%,rgba(255,255,255,0.12) ${cap > 0 ? (value / cap) * 100 : 0}%)` }}
            />
          </div>
          <button
            type="button" onClick={() => { setValue(0); if (targetId) onSendOp(targetId, { kind: 'clear' }) }}
            className="w-full rounded-xl border py-2 text-xs text-white/60 hover:bg-white/[0.06]"
            style={{ borderColor: BORDER }}
          >
            双通道全部归零
          </button>
          {/* 快捷电击盘（一键玩法；按对方上限换算） */}
          <div className="border-t pt-2.5" style={{ borderColor: BORDER }}>
            <p className="mb-1.5 text-[10px] font-semibold text-white/45">快捷电击（Zap = 按对方上限换算）</p>
            <div className="grid grid-cols-2 gap-1.5">
              {QUICK_STRENGTH_PRESETS.map(preset => (
                <button
                  key={preset.id} type="button" onClick={() => targetId && onQuickAction(targetId, preset.id, channel)}
                  className="flex items-center justify-center gap-1 rounded-xl border py-2 text-[11px] transition-colors hover:bg-white/[0.07]"
                  style={{ background: PANEL_2, borderColor: BORDER, color: preset.percent > 0.8 ? '#ff9c8a' : 'rgba(255,255,255,0.8)' }}
                >
                  <Zap className="h-3 w-3" style={{ color: preset.percent > 0.8 ? '#ff9c8a' : GOLD }} />{preset.label}
                </button>
              ))}
            </div>
          </div>
          {/* 波形绑定：把我的实时音乐波形持续灌进对方通道（可调增益 + 我的实时电平） */}
          <div className="border-t pt-2.5" style={{ borderColor: BORDER }}>
            {(() => {
              const bind = session.getWaveBinds().find(b => b.to === targetId && b.channel === channel)
              const bound = Boolean(bind)
              const level = channel === 'A' ? liveLevel.left : liveLevel.right
              return (
                <div>
                  <button
                    type="button" onClick={() => onBindWave(targetId, channel, !bound)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2 text-[11px] font-medium border transition-colors"
                    style={bound ? { background: 'rgba(255,232,156,0.14)', borderColor: GOLD + '77', color: GOLD } : { background: PANEL_2, borderColor: BORDER, color: 'rgba(255,255,255,0.7)' }}
                  >
                    <Radio className="h-3.5 w-3.5" />{bound ? '停止波形推送（' + channel + '）' : '推送我的波形（' + channel + '）'}
                  </button>
                  {bound && (
                    <div className="mt-1.5">
                      <div className="flex items-center justify-between text-[9.5px] text-white/45">
                        <span>推送增益 ×{bind!.gain.toFixed(1)}</span>
                        <span className="flex items-center gap-1">我的电平
                          <span className="inline-flex h-2 w-14 items-center overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.1)' }}>
                            <span className="h-full rounded-full transition-all duration-100" style={{ width: Math.round(level * 100) + '%', background: 'linear-gradient(90deg,' + GOLD + ',' + GOLD_DEEP + ')' }} />
                          </span>
                        </span>
                      </div>
                      <input
                        type="range" min={0.2} max={2} step={0.1} value={bind!.gain}
                        onChange={e => onGain(targetId, channel, Number(e.target.value))}
                        className="party-slider mt-1"
                        style={{ background: `linear-gradient(90deg,${GOLD} ${((bind!.gain - 0.2) / 1.8) * 100}%,rgba(255,255,255,0.12) ${((bind!.gain - 0.2) / 1.8) * 100}%)` }}
                      />
                    </div>
                  )}
                  <p className="mt-1 text-[9.5px] leading-relaxed text-white/30">把「我正在听的歌」的实时节奏持续推给对方通道——对方跟着我的音乐起电</p>
                </div>
              )
            })()}
          </div>
        </>
      )}
    </div>
  )
}

/** 同步听横条：房主=「广播我在播的歌」；成员=「跟随房主节奏」开关 + 播放状态展示 */
function SyncListenBar({ snapshot, selfPeerId, session, onFollow, nowPlaying, onPlaySame, onRequestSong, onCompleteRequest }: {
  snapshot: InPartySessionSnapshot
  selfPeerId: string
  session: ReturnType<typeof getInPartySession>
  onFollow: (on: boolean) => void
  /** 本机正在播放（用于「已经在听同一首」识别） */
  nowPlaying?: { title: string; artists: string; playing: boolean } | null
  /** 成员点「跟播」：请求本机播放房主正在听的歌 */
  onPlaySame: (title: string) => void
  /** 成员点歌请求 */
  onRequestSong: (title: string) => void
  /** 房主处理完一条点歌 */
  onCompleteRequest: (from: string) => void
}) {
  const isHost = snapshot.role === 'host'
  const playback = snapshot.syncPlayback
  const [, forceTick] = useState(0)
  const [songPromptOpen, setSongPromptOpen] = useState(false)
  useEffect(() => {
    if (!playback?.playing) return
    const timer = window.setInterval(() => forceTick(n => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [playback?.playing])
  if (!playback && !isHost) return null
  const sameSong = Boolean(playback && nowPlaying && nowPlaying.title === playback.title)
  const expected = session.expectedPositionMs()
  const progress = expected && playback ? Math.min(100, Math.max(0, (expected.positionMs % 100000) / 1000)) : 0
  return (
    <div className="flex shrink-0 items-center gap-2.5 rounded-2xl border px-3.5 py-2" style={{ background: 'rgba(255,232,156,0.06)', borderColor: GOLD + '44' }}>
      <Music2 className="h-3.5 w-3.5 shrink-0" style={{ color: GOLD }} />
      {isHost ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto text-[11px] text-white/75">
          {snapshot.songRequests.length === 0 ? '同步听开启中——你的播放与节拍正在广播给全房间' : (
            snapshot.songRequests.map(request => (
              <span key={request.from} className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5" style={{ background: 'rgba(255,232,156,0.12)' }}>
                <span style={{ color: GOLD }}>{snapshot.room?.members.find(m => m.peerId === request.from)?.nickname || '有人'} 点了《{request.title}》</span>
                <button type="button" onClick={() => { onPlaySame(request.title); onCompleteRequest(request.from) }} className="text-white/60 hover:text-white" title="搜索并播放">跟播</button>
                <button type="button" onClick={() => onCompleteRequest(request.from)} className="text-white/40 hover:text-white/80"><X className="h-3 w-3" /></button>
              </span>
            ))
          )}
        </span>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-[11px] text-white/75">
            房主正在播放{playback ? <>《{playback.title}》{playback.artists ? ' · ' + playback.artists : ''}{playback.playing ? '' : '（暂停）'}</> : '…'}
          </span>
          {sameSong && <span className="shrink-0 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[9.5px] text-emerald-300">已在听同一首</span>}
          {playback && !sameSong && (
            <button
              type="button" onClick={() => onPlaySame(playback.title)}
              className="shrink-0 rounded-full px-2.5 py-1 text-[10px] text-white/70 hover:text-white"
              style={{ background: 'rgba(255,255,255,0.08)' }}
              title="在我的曲库/搜索里找这首歌并播放"
            >
              跟播这首
            </button>
          )}
          <button
            type="button" onClick={() => setSongPromptOpen(true)}
            className="shrink-0 rounded-full px-2.5 py-1 text-[10px] text-white/70 hover:text-white"
            style={{ background: 'rgba(255,255,255,0.08)' }}
            title="向房主点歌"
          >
            点一首
          </button>
          <button
            type="button" onClick={() => onFollow(!snapshot.followHostRhythm)}
            className={'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[10.5px] font-bold transition-colors ' + (snapshot.followHostRhythm ? 'text-black' : 'text-white/70 hover:text-white')}
            style={snapshot.followHostRhythm ? { background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' } : { background: 'rgba(255,255,255,0.08)' }}
            title="把房主的音乐节奏灌进自己的设备——全房间一起随歌起电"
          >
            <Flame className="h-3 w-3" />{snapshot.followHostRhythm ? '随房主节奏·已开启' : '跟随房主节奏'}
          </button>
        </>
      )}
      <AnimatePresence>
        {songPromptOpen && (
          <PromptModal
            title="想听什么？（房主会收到请求）"
            placeholder="歌名 · 歌手"
            confirmText="点歌"
            onConfirm={title => { if (title) onRequestSong(title) }}
            onClose={() => setSongPromptOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/** 惩罚轮盘：发起（选目标）→ 目标确认 → 掷骰开奖（consent-first） */
/** 惩罚轮盘大转盘：四格扇形 + 旋转指针动画（开奖时转 3 圈停在结果格） */
function RouletteWheel({ spinning, resultSlot }: { spinning: boolean; resultSlot: string | null }) {
  const slots = ROULETTE_SLOTS
  const totalWeight = slots.reduce((sum, slot) => sum + slot.weight, 0)
  // 每格角度按权重
  let acc = 0
  const angles = slots.map(slot => {
    const start = (acc / totalWeight) * 360
    acc += slot.weight
    return { id: slot.id, start, end: (acc / totalWeight) * 360, label: slot.label, weight: slot.weight }
  })
  const resultIndex = resultSlot ? angles.findIndex(a => a.id === resultSlot) : -1
  const targetRotation = resultIndex >= 0 ? 1080 + (360 - (angles[resultIndex].start + angles[resultIndex].end) / 2) : 0
  const [rotation, setRotation] = useState(0)
  useEffect(() => {
    if (spinning) setRotation(previous => Math.floor(previous / 360) * 360 + 1080)
    else if (resultSlot) setRotation(targetRotation)
  }, [spinning, resultSlot, targetRotation])

  return (
    <div className="relative mx-auto" style={{ width: 150, height: 150 }}>
      {/* 转盘本体 */}
      <svg
        viewBox="0 0 100 100" className="h-full w-full"
        style={{ transform: `rotate(${rotation}deg)`, transition: rotation ? 'transform 2.8s cubic-bezier(0.2, 0.8, 0.2, 1)' : undefined }}
      >
        {angles.map((angle, index) => {
          const startRad = (angle.start - 90) * Math.PI / 180
          const endRad = (angle.end - 90) * Math.PI / 180
          const x1 = 50 + 46 * Math.cos(startRad)
          const y1 = 50 + 46 * Math.sin(startRad)
          const x2 = 50 + 46 * Math.cos(endRad)
          const y2 = 50 + 46 * Math.sin(endRad)
          const colors = ['rgba(255,232,156,0.28)', 'rgba(255,140,90,0.25)', 'rgba(120,200,255,0.22)', 'rgba(255,90,90,0.28)']
          return (
            <path
              key={angle.id}
              d={`M50 50 L${x1.toFixed(2)} ${y1.toFixed(2)} A46 46 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`}
              fill={colors[index % colors.length]}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth="0.5"
            />
          )
        })}
        {/* 中心圆 */}
        <circle cx="50" cy="50" r="12" fill="#141007" stroke="#FFE89C" strokeWidth="1" />
      </svg>
      {/* 指针 */}
      <span className="absolute left-1/2 top-0 -translate-x-1/2 text-lg" style={{ filter: 'drop-shadow(0 0 4px rgba(255,232,156,0.8))' }}>▼</span>
    </div>
  )
}

function RoulettePanel({ snapshot, selfPeerId, session, onStart, onRespond, onSpin }: {
  snapshot: InPartySessionSnapshot
  selfPeerId: string
  session: ReturnType<typeof getInPartySession>
  onStart: (target: string) => void
  onRespond: (accept: boolean) => void
  onSpin: () => void
}) {
  const game = snapshot.roulette
  const targets = (snapshot.room?.members || []).filter(m => m.peerId !== selfPeerId && m.online && m.device.connected)
  const [pick, setPick] = useState('')
  useEffect(() => { if (!targets.some(t => t.peerId === pick)) setPick(targets[0]?.peerId || '') }, [targets, pick])
  const amTarget = game?.target === selfPeerId
  const amHost = game?.by === selfPeerId

  return (
    <div className="border-t p-3" style={{ borderColor: BORDER }}>
      <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-white/45"><Dices className="h-3 w-3" style={{ color: GOLD }} />惩罚轮盘（对方同意才开奖）</p>
      {!game ? (
        targets.length ? (
          <>
            <div className="mb-2"><RouletteWheel spinning={false} resultSlot={null} /></div>
            <div className="space-y-1.5">
            <FancySelect
              value={pick}
              options={targets.map(t => ({ value: t.peerId, label: t.nickname + '（上限 ' + Math.min(t.device.caps?.A ?? 60, t.device.caps?.B ?? 60) + '）' }))}
              onChange={v => setPick(v)}
            />
            <button
              type="button" disabled={!pick} onClick={() => onStart(pick)}
              className="w-full rounded-xl border py-2 text-[11px] font-medium text-white/80 hover:bg-white/[0.07] disabled:opacity-40"
              style={{ borderColor: BORDER }}
            >
              <Dices className="mr-1 inline h-3 w-3" />发起轮盘
            </button>
          </div>
          </>
        ) : (
          <>
            <div className="mb-2"><RouletteWheel spinning={false} resultSlot={null} /></div>
            <p className="text-[10px] text-white/30">没有连着设备的其他成员</p>
          </>
        )
      ) : amTarget && game.accepted === 'pending' ? (
        <div className="space-y-1.5">
          <p className="text-[11px] text-white/70">{session.getProfile()?.nickname ? '' : ''}{snapshot.room?.members.find(m => m.peerId === game.by)?.nickname || '有人'} 向你发起轮盘——中奖会按你的上限电你</p>
          <div className="flex gap-1.5">
            <button type="button" onClick={() => onRespond(true)} className="flex-1 rounded-xl py-2 text-[11px] font-bold text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>接受挑战</button>
            <button type="button" onClick={() => onRespond(false)} className="flex-1 rounded-xl border py-2 text-[11px] text-white/60" style={{ borderColor: BORDER }}>拒绝</button>
          </div>
        </div>
      ) : amHost && game.accepted === 'accepted' && !game.result ? (
        <button type="button" onClick={onSpin} className="w-full animate-pulse rounded-xl py-2.5 text-[12px] font-bold text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
          <Dices className="mr-1 inline h-3.5 w-3.5" />开奖！
        </button>
      ) : game.result ? (
        <div className="text-center">
          <RouletteWheel spinning={false} resultSlot={game.result} />
          <p className="mt-1 text-[11px]" style={{ color: GOLD }}>
            开奖：{ROULETTE_SLOTS.find(s => s.id === game.result)?.label}
            {game.accepted === 'declined' ? '（对方已拒绝）' : ''}
          </p>
        </div>
      ) : (
        <p className="text-[10px] text-white/40">
          等待 {snapshot.room?.members.find(m => m.peerId === game.target)?.nickname || '对方'} 确认…
          {game.accepted === 'declined' ? '（已拒绝）' : ''}
        </p>
      )}
    </div>
  )
}

/** 互控日志（最近 80 条：谁对我做了什么 + 我做了什么） */
/** 派对小结：本房从进房起算的互动计数（本机视角；30s 刷新一次时长显示） */
function PartySummaryCard({ stats }: { stats: { startedAt: number; controlOps: number; punishSent: number; shocked: number; games: number } }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const minutes = Math.max(0, Math.floor((now - stats.startedAt) / 60_000))
  const hours = Math.floor(minutes / 60)
  const duration = hours > 0 ? `${hours} 小时 ${minutes % 60} 分` : `${minutes} 分钟`
  const items = [
    { label: '已进行', value: duration },
    { label: '互控指令', value: String(stats.controlOps) },
    { label: '送出惩罚', value: String(stats.punishSent) },
    { label: '被电次数', value: String(stats.shocked) },
    { label: '玩法场次', value: String(stats.games) },
  ]
  return (
    <div className="p-3">
      <p className="mb-2 text-[10px] text-white/35">本房派对小结（从你进房开始算）</p>
      <div className="grid grid-cols-2 gap-1.5">
        {items.map(item => (
          <div key={item.label} className="rounded-xl px-2.5 py-2" style={{ background: PANEL_2 }}>
            <p className="truncate text-sm font-bold tabular-nums" style={{ color: GOLD }}>{item.value}</p>
            <p className="mt-0.5 text-[9px] text-white/35">{item.label}</p>
          </div>
        ))}
        {/* 已进行占两格排版里的一格即可：5 项 → 最后一行留一个空位对齐 */}
        <div className="rounded-xl px-2.5 py-2 opacity-0" aria-hidden="true" />
      </div>
    </div>
  )
}

function ControlLogList({ log }: { log: ControlLogEntry[] }) {
  if (!log.length) return <p className="p-4 text-center text-[10px] text-white/30">还没有互控记录</p>
  return (
    <div className="space-y-1 p-3">
      {log.slice(0, 40).map(entry => (
        <div key={entry.id} className="flex items-baseline gap-2 rounded-lg px-2 py-1 text-[10.5px]" style={{ background: PANEL_2 }}>
          <span className="shrink-0 text-white/30">{new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
          <span className="truncate text-white/65">{entry.detail}</span>
        </div>
      ))}
    </div>
  )
}

/** 决斗倒计时（每秒刷新；结束前 5s 变红） */
function DuelCountdown({ endsAt }: { endsAt: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [])
  const remaining = Math.max(0, Math.ceil((endsAt - now) / 1000))
  if (remaining <= 0) return <span className="text-white/30">收卷中…</span>
  return (
    <span className="tabular-nums font-bold" style={{ color: remaining <= 5 ? '#ff9c8a' : GOLD }}>
      {remaining}s
    </span>
  )
}

/** 连胜榜（决斗页签底部） */
function DuelStreaks({ snapshot, selfPeerId }: { snapshot: InPartySessionSnapshot; selfPeerId: string }) {
  const entries = Object.entries(snapshot.duelStreaks).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (!entries.length) return null
  return (
    <div className="border-t p-3" style={{ borderColor: BORDER }}>
      <p className="mb-1.5 text-[10px] font-semibold text-white/45">连胜榜</p>
      <div className="space-y-1">
        {entries.map(([peerId, streak]) => (
          <div key={peerId} className="flex items-center justify-between rounded-lg px-2.5 py-1 text-[10.5px]" style={{ background: PANEL_2 }}>
            <span className="text-white/70">{snapshot.room?.members.find(m => m.peerId === peerId)?.nickname || '有人'}{peerId === selfPeerId ? '(我)' : ''}</span>
            <span className="font-bold" style={{ color: streak >= 5 ? '#ff9c8a' : GOLD }}>{streak} 连胜</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 成就面板：统计 + 已获得/未解锁列表 */
function AchievementsPanel({ compact = false }: { compact?: boolean }) {
  const [records, setRecords] = useState(() => readUnlockedAchievements())
  const [expanded, setExpanded] = useState(!compact)
  useEffect(() => {
    const sync = () => setRecords(readUnlockedAchievements())
    window.addEventListener('waveforge:inparty-achievement', sync)
    return () => window.removeEventListener('waveforge:inparty-achievement', sync)
  }, [])
  const summary = achievementSummary()
  const unlockedIds = new Set(records.map(record => record.id))
  const sorted = [...ACHIEVEMENTS].sort((a, b) => {
    const aUnlocked = unlockedIds.has(a.id) ? 0 : 1
    const bUnlocked = unlockedIds.has(b.id) ? 0 : 1
    return aUnlocked - bUnlocked || a.tier.localeCompare(b.tier)
  })

  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-2 p-3'}>
      <div className="rounded-xl border p-3" style={{ borderColor: GOLD + '55', background: 'rgba(255,232,156,0.06)' }}>
        <div className="flex items-center justify-between text-[11px]">
          <span className="font-bold" style={{ color: GOLD }}>🏆 成就进度</span>
          <span className="text-white/60">{summary.unlocked}/{summary.total}（{summary.percent}%）</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.1)' }}>
          <div className="h-full rounded-full transition-all" style={{ width: summary.percent + '%', background: 'linear-gradient(90deg,' + GOLD + ',' + GOLD_DEEP + ')' }} />
        </div>
      </div>
      <div className="space-y-1.5">
        {(expanded ? sorted : sorted.slice(0, 5)).map(def => {
          const unlocked = unlockedIds.has(def.id)
          const shown = displayDef(def, unlocked)
          const isEpic = shown.tier === 'epic'
          return (
            <div
              key={def.id}
              className="flex items-center gap-2.5 rounded-xl border px-2.5 py-2"
              style={{
                background: unlocked ? (isEpic ? 'rgba(176,100,224,0.1)' : 'rgba(255,232,156,0.07)') : PANEL_2,
                borderColor: unlocked ? (isEpic ? 'rgba(176,100,224,0.45)' : GOLD + '55') : BORDER,
                opacity: unlocked ? 1 : 0.55,
              }}
            >
              <span className={'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base ' + (unlocked ? '' : 'grayscale')} style={{ background: unlocked ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)' }}>
                {shown.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[11px] font-bold" style={{ color: unlocked ? (isEpic ? '#e8a0ff' : GOLD) : 'rgba(255,255,255,0.45)' }}>{shown.name}</span>
                  {isEpic && unlocked && <span className="shrink-0 rounded px-1 text-[8px]" style={{ background: 'rgba(176,100,224,0.3)', color: '#e8a0ff' }}>史诗</span>}
                </span>
                <span className="block truncate text-[9.5px] text-white/40">{shown.desc}</span>
              </span>
              {unlocked && <Check className="h-3.5 w-3.5 shrink-0" style={{ color: GOLD }} />}
            </div>
          )
        })}
        {compact && sorted.length > 5 && (
          <button type="button" onClick={() => setExpanded(v => !v)} className="w-full rounded-lg py-1.5 text-[10px] text-white/45 hover:bg-white/[0.05]">
            {expanded ? '收起' : '查看全部 ' + sorted.length + ' 个成就'}
          </button>
        )}
      </div>
    </div>
  )
}

/** 团队赛 2v2：队伍名单+比分+答题面板 */
function TeamMatchPanel({ snapshot, selfPeerId, session, onStart, onAnswer }: {
  snapshot: InPartySessionSnapshot
  selfPeerId: string
  session: ReturnType<typeof getInPartySession>
  onStart: () => void
  onAnswer: (option: number) => void
}) {
  const game = snapshot.game
  const inGame = Boolean(game?.payload.note?.startsWith('team-match'))
  const teams = game?.teams
  const myTeam = teams ? (teams.gold.includes(selfPeerId) ? 'gold' : teams.blue.includes(selfPeerId) ? 'blue' : null) : null
  const myAnswered = myTeam && game ? (teams![myTeam].some(id => game.submits[id] !== undefined)) : false
  const parts = game?.payload.note?.split('|') ?? []
  const question = inGame ? { q: parts[1] || '', options: parts[2] ? parts[2].split('|') : [] } : null
  const myWord = session.getMyUndercoverWord()

  return (
    <div className="space-y-2 p-3">
      {!inGame ? (
        <>
          <p className="text-[10px] leading-relaxed text-white/40">把房间成员均分成金/蓝两队：每题两队各派一人作答，答错的<strong>全队</strong>吃小电，先输 3 题的队<strong>集体吃大电</strong>。4 人以上最好玩。</p>
          <button type="button" onClick={onStart} className="w-full rounded-xl py-2.5 text-[12px] font-bold text-black" style={{ background: 'linear-gradient(135deg,#d9a13c,#5aa9e6)' }}>
            🏳️ 开始团队赛 2v2
          </button>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between text-[11px] font-bold">
            <span style={{ color: '#d9a13c' }}>金队 {teams!.gold.length}人 · 负{teams!.loses.gold}</span>
            <span className="text-white/40">vs</span>
            <span style={{ color: '#5aa9e6' }}>蓝队 {teams!.blue.length}人 · 负{teams!.loses.blue}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {teams!.gold.map(id => <span key={id} className="rounded-full px-2 py-0.5 text-[9.5px]" style={{ background: 'rgba(217,161,60,0.15)', color: '#d9a13c' }}>{snapshot.room?.members.find(m => m.peerId === id)?.nickname || '?'}</span>)}
            {teams!.blue.map(id => <span key={id} className="rounded-full px-2 py-0.5 text-[9.5px]" style={{ background: 'rgba(90,169,230,0.15)', color: '#5aa9e6' }}>{snapshot.room?.members.find(m => m.peerId === id)?.nickname || '?'}</span>)}
          </div>
          {question && (
            <>
              <p className="text-[11px] font-semibold text-white/85">{question.q}</p>
              <div className="space-y-1.5">
                {question.options.map((option, index) => (
                  <button
                    key={index} type="button" disabled={myAnswered || !myTeam} onClick={() => onAnswer(index)}
                    className="w-full rounded-lg border py-2 text-[11px] disabled:opacity-50"
                    style={{ background: PANEL_2, borderColor: myTeam === 'gold' ? 'rgba(217,161,60,0.5)' : myTeam === 'blue' ? 'rgba(90,169,230,0.5)' : BORDER, color: 'rgba(255,255,255,0.85)' }}
                  >
                    {String.fromCharCode(65 + index)}. {option}
                  </button>
                ))}
              </div>
              <p className="text-center text-[9.5px] text-white/35">
                {!myTeam ? '你是主持人，等两队作答' : myAnswered ? '你队已作答' : '答错全队吃电，商量好再答'}
              </p>
            </>
          )}
        </>
      )}
      {/* 隐藏引用避免 TS6133 */}
      <span className="hidden">{myWord ? '' : ''}</span>
    </div>
  )
}

/** 惩罚骰子：六格 + 掷骰（可掷自己或指定成员） */
function DicePanel({ snapshot, selfPeerId, session }: {
  snapshot: InPartySessionSnapshot
  selfPeerId: string
  session: ReturnType<typeof getInPartySession>
}) {
  const game = snapshot.game
  const dice = game?.dice
  const lastSlot = dice ? DICE_SLOTS.find(slot => slot.id === dice.slot) : null
  const [targetId, setTargetId] = useState(selfPeerId)
  const targets = (snapshot.room?.members ?? []).filter(m => m.online)

  return (
    <div className="space-y-2 p-3">
      <p className="text-[10px] leading-relaxed text-white/40">六格惩罚骰子：安全格/轻撩/拍一拍/电一下/风暴/再来一次。默认掷给自己，也可以选人掷（惩罚走对方安全层）。</p>
      <div className="grid grid-cols-3 gap-1.5">
        {targets.map(member => (
          <button
            key={member.peerId} type="button" onClick={() => setTargetId(member.peerId)}
            className={'flex items-center justify-center gap-1 rounded-xl border py-1.5 text-[10px] transition-colors'}
            style={{
              background: targetId === member.peerId ? 'rgba(255,232,156,0.12)' : PANEL_2,
              borderColor: targetId === member.peerId ? GOLD + '77' : BORDER,
              color: targetId === member.peerId ? GOLD : 'rgba(255,255,255,0.6)',
            }}
          >
            {member.nickname.slice(0, 5)}{member.peerId === selfPeerId ? '(我)' : ''}
          </button>
        ))}
      </div>
      <button type="button" onClick={() => void session.rollPunishDice(targetId)} className="w-full rounded-xl py-2.5 text-[12px] font-bold text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
        🎲 为 {snapshot.room?.members.find(m => m.peerId === targetId)?.nickname || '自己'} 掷骰
      </button>
      {lastSlot && (
        <div className="rounded-xl border p-3 text-center" style={{ borderColor: GOLD + '55', background: 'rgba(255,232,156,0.06)' }}>
          <p className="text-2xl">🎲</p>
          <p className="mt-1 text-[11px] font-bold" style={{ color: lastSlot.percent > 0.5 ? '#ff9c8a' : GOLD }}>{lastSlot.label}</p>
          <p className="mt-0.5 text-[9.5px] text-white/35">目标：{snapshot.room?.members.find(m => m.peerId === dice?.target)?.nickname || ''}</p>
        </div>
      )}
    </div>
  )
}

/** 谁是卧底：我的词 + 描述阶段 + 投票 */
function UndercoverPanel({ snapshot, selfPeerId, session, onStart, onVote }: {
  snapshot: InPartySessionSnapshot
  selfPeerId: string
  session: ReturnType<typeof getInPartySession>
  onStart: () => void
  onVote: (target: string) => void
}) {
  const game = snapshot.game
  const inGame = Boolean(game?.payload.note?.startsWith('undercover'))
  const activeGame = inGame ? game : null
  const myWord = session.getMyUndercoverWord()
  const votes = game?.undercover?.votes ?? {}
  const myVote = votes[selfPeerId]
  const online = (snapshot.room?.members ?? []).filter(m => m.online && m.peerId !== selfPeerId)

  return (
    <div className="space-y-2 p-3">
      {!inGame ? (
        <>
          <p className="text-[10px] leading-relaxed text-white/40">经典谁是卧底：全员拿词（卧底的词不同），轮流描述，投票揪卧底。卧底被揪吃大电；投错平民集体吃小电。至少 4 人。</p>
          <button type="button" onClick={onStart} className="w-full rounded-xl py-2.5 text-[12px] font-bold text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
            🕵️ 开始谁是卧底
          </button>
        </>
      ) : activeGame?.phase === 'done' ? (
        <div className="rounded-xl border p-3 text-center" style={{ borderColor: GOLD + '55', background: 'rgba(255,232,156,0.06)' }}>
          <p className="text-[11px]" style={{ color: GOLD }}>
            {activeGame.result?.loser ? '⚡ ' + (snapshot.room?.members.find(m => m.peerId === activeGame.result?.loser)?.nickname || '') + ' 是卧底，吃大电！' : activeGame.result?.note}
          </p>
        </div>
      ) : activeGame ? (
        <>
          <div className="rounded-xl border p-3 text-center" style={{ borderColor: GOLD + '66', background: 'rgba(255,232,156,0.06)' }}>
            <p className="text-[10px] text-white/45">你的词</p>
            <p className="mt-1 text-lg font-bold tracking-widest" style={{ color: GOLD }}>{myWord || '…'}</p>
            <p className="mt-1 text-[9px] text-white/30">别直接说出词，用描述让队友认出你</p>
          </div>
          <p className="text-[10.5px] text-white/55">轮流描述后，投出你认为是卧底的人：</p>
          <div className="grid grid-cols-2 gap-1.5">
            {online.map(member => {
              const voted = myVote === member.peerId
              const voteCount = Object.values(votes).filter(target => target === member.peerId).length
              return (
                <button
                  key={member.peerId} type="button" disabled={Boolean(myVote)} onClick={() => onVote(member.peerId)}
                  className={'flex items-center justify-between rounded-xl border px-2.5 py-2 text-[10.5px] transition-colors disabled:opacity-60'}
                  style={{ background: voted ? 'rgba(255,120,90,0.12)' : PANEL_2, borderColor: voted ? 'rgba(255,120,90,0.5)' : BORDER, color: voted ? '#ff9c8a' : 'rgba(255,255,255,0.8)' }}
                >
                  <span className="truncate">{member.nickname}</span>
                  {voteCount > 0 && <span className="rounded-full bg-white/10 px-1.5 text-[9px]">{voteCount} 票</span>}
                </button>
              )
            })}
          </div>
          <p className="text-center text-[9.5px] text-white/35">{myVote ? '已投票，等其他人…' : `已投 ${Object.keys(votes).length}/${online.length + 1}`}</p>
        </>
      ) : null}
    </div>
  )
}

/** 派对玩法中心：五个玩法的选择/进行/结算 */
const GAME_ICONS: Record<GameKind, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  'truth-dare': HeartHandshake,
  'beat-echo': Music4,
  'red-light': TrafficCone,
  'relay-shock': ZapIcon,
  'guess-song': Music2,
}

function GameHubPanel({ snapshot, selfPeerId, session, onStart, onSubmit, onOpenRoulette }: {
  snapshot: InPartySessionSnapshot
  selfPeerId: string
  session: ReturnType<typeof getInPartySession>
  onStart: (kind: string) => void
  onSubmit: (value: string) => void
  onOpenRoulette: () => void
}) {
  const game = snapshot.game
  // 三大团队玩法的进行中视图路由
  if (game?.payload.note?.startsWith('team-match')) {
    return <TeamMatchPanel snapshot={snapshot} selfPeerId={selfPeerId} session={session} onStart={() => void session.startTeamMatch()} onAnswer={option => session.submitTeamAnswer(option)} />
  }
  if (game?.payload.note?.startsWith('dice')) {
    return <DicePanel snapshot={snapshot} selfPeerId={selfPeerId} session={session} />
  }
  if (game?.payload.note?.startsWith('undercover')) {
    return <UndercoverPanel snapshot={snapshot} selfPeerId={selfPeerId} session={session} onStart={() => void session.startUndercover()} onVote={target => session.voteUndercover(target)} />
  }
  const isHost = snapshot.role === 'host'
  const amActive = game?.active === selfPeerId
  const [beatInput, setBeatInput] = useState('')
  const [guessInput, setGuessInput] = useState('')
  const [remaining, setRemaining] = useState(0)

  // 倒计时
  useEffect(() => {
    if (!game || game.phase === 'done') { setRemaining(0); return }
    const timer = window.setInterval(() => setRemaining(Math.max(0, Math.ceil((game.endsAt - Date.now()) / 1000))), 400)
    return () => window.clearInterval(timer)
  }, [game])

  return (
    <div className="space-y-2 p-3">
      {!game ? (
        <>
          <p className="text-[10px] leading-relaxed text-white/40">派对玩法中心：发起一个玩法，全房间一起玩。所有惩罚都走对方自己的安全层（上限/跳变/倒计时照常生效）。</p>
          <div className="grid grid-cols-1 gap-1.5">
            {/* 三人以上团队玩法 */}
            <button
              type="button" onClick={() => onStart('team-match')}
              className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
              style={{ background: PANEL_2, borderColor: BORDER }}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-black" style={{ background: 'linear-gradient(135deg,#d9a13c,#5aa9e6)' }}>
                <Users className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-bold text-white/90">团队赛 2v2</span>
                <span className="block text-[9.5px] text-white/40">金蓝两队答题战，答错全队吃电，先输 3 题大电</span>
              </span>
            </button>
            <button
              type="button" onClick={() => onStart('dice')}
              className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
              style={{ background: PANEL_2, borderColor: BORDER }}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
                <Dices className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-bold text-white/90">惩罚骰子</span>
                <span className="block text-[9.5px] text-white/40">六格随机：安全/轻撩/拍一拍/电一下/风暴/重掷</span>
              </span>
            </button>
            <button
              type="button" onClick={() => onStart('undercover')}
              className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
              style={{ background: PANEL_2, borderColor: BORDER }}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
                <Eye className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-bold text-white/90">谁是卧底</span>
                <span className="block text-[9.5px] text-white/40">拿词描述+投票，揪出卧底大电；投错平民小电</span>
              </span>
            </button>
            {/* 惩罚轮盘(入口在「轮盘」页签) */}
            <button
              type="button" onClick={onOpenRoulette}
              className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
              style={{ background: PANEL_2, borderColor: BORDER }}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-black" style={{ background: 'linear-gradient(135deg,#ff8fa3,#c9184a)' }}>
                <Dices className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-bold text-white/90">惩罚轮盘</span>
                <span className="block text-[9.5px] text-white/40">四格加权转盘：无事/轻撩/电击/风暴，对方确认才开奖</span>
              </span>
            </button>
            {(Object.keys(GAME_LABEL) as GameKind[]).map(kind => {
              const Icon = GAME_ICONS[kind]
              return (
                <button
                  key={kind} type="button" onClick={() => onStart(kind)}
                  className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
                  style={{ background: PANEL_2, borderColor: BORDER }}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-bold text-white/90">{GAME_LABEL[kind]}</span>
                    <span className="block text-[9.5px] text-white/40">{GAME_HINT[kind]}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </>
      ) : game.phase === 'done' ? (
        <div className="rounded-xl border p-3 text-center" style={{ borderColor: GOLD + '55', background: 'rgba(255,232,156,0.06)' }}>
          <p className="text-[11px]" style={{ color: GOLD }}>
            {game.result?.loser
              ? '⚡ ' + (snapshot.room?.members.find(m => m.peerId === game.result?.loser)?.nickname || '有人') + ' ' + (game.result?.note || '')
              : game.result?.note || '结束'}
          </p>
          <p className="mt-1 text-[9.5px] text-white/30">{GAME_LABEL[game.kind]} · 稍后可再发起</p>
        </div>
      ) : (
        <div className="space-y-2 rounded-xl border p-3" style={{ borderColor: GOLD + '55', background: 'rgba(255,232,156,0.04)' }}>
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold" style={{ color: GOLD }}>🎮 {GAME_LABEL[game.kind]}</p>
            <span className="text-[10px] tabular-nums" style={{ color: remaining <= 5 ? '#ff9c8a' : 'rgba(255,255,255,0.5)' }}>{remaining}s</span>
          </div>

          {/* 真心话大冒险 */}
          {game.kind === 'truth-dare' && game.payload.prompt && (
            amActive ? (
              <>
                <p className="rounded-lg px-2.5 py-2 text-[11px] leading-relaxed text-white/85" style={{ background: PANEL_2 }}>
                  <span style={{ color: GOLD }}>{game.payload.prompt.type === 'truth' ? '【真心话】' : '【大冒险】'}</span>
                  {game.payload.prompt.text}
                </p>
                <button type="button" onClick={() => onSubmit('done')} className="w-full rounded-xl py-2 text-[11px] font-bold text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
                  我完成了（超时未完成会吃电）
                </button>
              </>
            ) : (
              <p className="text-[10.5px] text-white/55">
                {snapshot.room?.members.find(m => m.peerId === game.active)?.nickname || '有人'} 正在挑战——
                {game.payload.prompt.type === 'truth' ? '等着听答案' : '围观 ta 的操作'}
              </p>
            )
          )}

          {/* 节拍模仿 */}
          {game.kind === 'beat-echo' && (
            <>
              {game.by === selfPeerId ? (
                <>
                  <p className="text-[10.5px] text-white/60">谱子（1=强 0=弱）：{(game.payload.pattern ?? []).join(' ')}——用互控台照谱电自己作演示</p>
                  <p className="text-[9.5px] text-white/35">演示完等大家提交；超时后错最多的人吃电</p>
                </>
              ) : (
                <>
                  <p className="text-[10.5px] text-white/60">凭刚才被电/听到的节奏，按顺序点谱复述：</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(game.payload.pattern ?? []).map((_, index) => (
                      <button
                        key={index} type="button"
                        onClick={() => setBeatInput(prev => prev + (prev.length > index ? '' : '1'))}
                        className="h-8 w-8 rounded-lg border text-[11px] font-bold"
                        style={{ background: PANEL_2, borderColor: BORDER, color: beatInput[index] === '1' ? GOLD : 'rgba(255,255,255,0.3)' }}
                      >
                        {index + 1}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <button type="button" onClick={() => setBeatInput(prev => prev + '1')} className="flex-1 rounded-lg border py-1.5 text-[10px]" style={{ borderColor: GOLD + '55', color: GOLD }}>记强拍</button>
                    <button type="button" onClick={() => setBeatInput(prev => prev + '0')} className="flex-1 rounded-lg border py-1.5 text-[10px]" style={{ borderColor: BORDER, color: 'rgba(255,255,255,0.6)' }}>记弱拍</button>
                  </div>
                  <button type="button" disabled={!beatInput} onClick={() => { onSubmit(beatInput); }} className="w-full rounded-xl py-2 text-[11px] font-bold text-black disabled:opacity-40" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
                    提交复述（{beatInput.length}/{(game.payload.pattern ?? []).length}）
                  </button>
                </>
              )}
            </>
          )}

          {/* 红绿灯 */}
          {game.kind === 'red-light' && (
            game.payload.redLight ? (
              <>
                <p className="animate-pulse text-center text-sm font-bold" style={{ color: '#ff9c8a' }}>🚨 红灯！立刻归零！</p>
                {amActive || true}
                <button type="button" onClick={() => session.pauseMe()} className="w-full rounded-xl bg-red-500/20 py-2.5 text-[11px] font-bold text-red-200 hover:bg-red-500/30">
                  紧急叫停（我已归零）
                </button>
              </>
            ) : (
              <p className="text-center text-[11px]" style={{ color: '#6ee7b7' }}>🟢 绿灯——互相电，红灯一响立刻停！</p>
            )
          )}

          {/* 接力电 */}
          {game.kind === 'relay-shock' && (
            amActive ? (
              <>
                <p className="text-[11px] text-white/80" style={{ color: GOLD }}>⚡ 电在你身上！3 秒内传给下一位（{game.payload.note}）</p>
                <button type="button" onClick={() => onSubmit('pass')} className="w-full rounded-xl py-2 text-[11px] font-bold text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
                  传给下一位
                </button>
              </>
            ) : (
              <p className="text-[10.5px] text-white/60">当前持电：{snapshot.room?.members.find(m => m.peerId === game.active)?.nickname || '…'}（顺序：{game.payload.note}）</p>
            )
          )}

          {/* 猜歌名 */}
          {game.kind === 'guess-song' && (
            game.by === selfPeerId ? (
              <p className="text-[10.5px] text-white/60">你是主持人，答案只有你知道——《{session.getSnapshot().game ? '' : ''}》等大家猜</p>
            ) : (
              <div className="flex gap-1.5">
                <input
                  value={guessInput}
                  onChange={e => setGuessInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && guessInput.trim()) { onSubmit(guessInput.trim()); setGuessInput('') } }}
                  placeholder={game.payload.hint || '歌名是？'}
                  className="min-w-0 flex-1 rounded-lg border bg-black/40 px-2.5 py-1.5 text-[11px] text-white/90 outline-none"
                  style={{ borderColor: BORDER }}
                />
                <button type="button" disabled={!guessInput.trim()} onClick={() => { onSubmit(guessInput.trim()); setGuessInput('') }} className="rounded-lg px-3 py-1.5 text-[11px] font-bold text-black disabled:opacity-40" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
                  答!
                </button>
              </div>
            )
          )}

          <p className="text-center text-[9.5px] text-white/30">
            已参与 {Object.keys(game.submits).length} 人 · 发起人 {snapshot.room?.members.find(m => m.peerId === game.by)?.nickname || ''}
          </p>
        </div>
      )}
    </div>
  )
}

/** 节奏决斗：答题最慢/答错者吃一轮电（consent 进房即认同，房主可关总闸） */
function DuelPanel({ snapshot, selfPeerId, session, onStart, onAnswer }: {
  snapshot: InPartySessionSnapshot
  selfPeerId: string
  session: ReturnType<typeof getInPartySession>
  onStart: (bestOf: 1 | 3) => void
  onAnswer: (option: number) => void
}) {
  const [bestOf, setBestOf] = useState<1 | 3>(1)
  const duel = snapshot.duel
  const answered = duel?.answers[selfPeerId]
  const answeredCount = Object.keys(duel?.answers ?? {}).length
  const onlineCount = (snapshot.room?.members ?? []).filter(m => m.online && m.peerId !== selfPeerId).length

  return (
    <div className="space-y-2 p-3">
      <p className="text-[10px] leading-relaxed text-white/40">音乐/派对常识题，15 秒作答。答错或最慢的人会吃一轮电（强度按对方上限 50%）。发起即表示全房间同意玩法；不想玩可以在对方答题前叫停设备。</p>
      {!duel ? (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {([1, 3] as const).map(n => (
              <button
                key={n} type="button" onClick={() => setBestOf(n)}
                className={'rounded-xl border py-1.5 text-[10.5px] transition-colors ' + (bestOf === n ? 'font-bold' : 'text-white/50 hover:text-white/80')}
                style={bestOf === n ? { background: 'rgba(255,232,156,0.12)', borderColor: GOLD + '66', color: GOLD } : { background: PANEL_2, borderColor: BORDER }}
              >
                {n === 1 ? '单局速战' : '三局两胜'}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => onStart(bestOf)} className="w-full rounded-xl py-2.5 text-[12px] font-bold text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>
            <Flame className="mr-1 inline h-3.5 w-3.5" />发起节奏决斗
          </button>
        </div>
      ) : duel.result ? (
        <div className="rounded-xl border p-3 text-center" style={{ borderColor: GOLD + '55', background: 'rgba(255,232,156,0.06)' }}>
          <p className="text-[11px]" style={{ color: GOLD }}>⚡ {snapshot.room?.members.find(m => m.peerId === duel.result?.loser)?.nickname || '有人'} 吃电！</p>
          <p className="mt-1 text-[10px] text-white/50">正确答案：{duel.question.options[duel.result.correctIndex]}</p>
        </div>
      ) : (
        <div className="rounded-xl border p-3" style={{ borderColor: BORDER }}>
          {duel.bestOf > 1 && (
            <p className="mb-2 flex items-center justify-between text-[10px]" style={{ color: GOLD }}>
              <span>第 {duel.round}/{duel.bestOf} 局 · {duel.bestOf === 3 ? '三局两胜' : ''}</span>
              <span className="flex gap-2">
                {Object.entries(duel.score).filter(([, n]) => n > 0).map(([pid, n]) => (
                  <span key={pid}>{snapshot.room?.members.find(m => m.peerId === pid)?.nickname?.slice(0, 6) || '?'} 负 {n}</span>
                ))}
              </span>
            </p>
          )}
          <p className="text-[11px] font-semibold text-white/85">{duel.question.q}</p>
          <div className="mt-2 space-y-1.5">
            {duel.question.options.map((option, index) => {
              const mine = answered?.option === index
              return (
                <button
                  key={index} type="button" disabled={Boolean(answered)} onClick={() => onAnswer(index)}
                  className={'w-full rounded-lg border py-2 text-[11px] transition-colors disabled:opacity-60 ' + (mine ? 'font-bold' : 'hover:bg-white/[0.06]')}
                  style={{ background: mine ? 'rgba(255,232,156,0.14)' : PANEL_2, borderColor: mine ? GOLD + '88' : BORDER, color: mine ? GOLD : 'rgba(255,255,255,0.8)' }}
                >
                  {String.fromCharCode(65 + index)}. {option}
                </button>
              )
            })}
          </div>
          <p className="mt-2 flex items-center justify-center gap-2 text-[10px] text-white/35">
            <span>{answered ? '已作答，等其他人…' : '选出你的答案'} · 已答 {answeredCount}/{onlineCount + 1} ·</span>
            <DuelCountdown endsAt={duel.endsAt} />
          </p>
        </div>
      )}
    </div>
  )
}

/** 好友面板（本机好友列表 + 待处理申请） */
function FriendsPanel({ requests, onAccept, onDecline, onRemove, roomMembers, onSendDM, sessionLive, onOpenDM }: {
  requests: Array<{ from: string; profile: PartyProfile; at: number }>
  onAccept: (peerId: string) => void
  onDecline: (peerId: string) => void
  onRemove: (peerId: string) => void
  roomMembers: PartyMember[]
  onSendDM: (peerId: string, text: string) => void
  sessionLive: boolean
  /** 打开某个会话时清零会话未读（session.clearUnread） */
  onOpenDM: (peerId: string) => void
}) {
  const [friends, setFriends] = useState(() => readFriends())
  const [dmPeer, setDmPeer] = useState<string | null>(null)
  const [dmText, setDmText] = useState('')
  useEffect(() => {
    const sync = () => setFriends(readFriends())
    window.addEventListener(INPARTY_SETTINGS_EVENT, sync)
    window.addEventListener('waveforge:inparty-friend-added', sync)
    return () => {
      window.removeEventListener(INPARTY_SETTINGS_EVENT, sync)
      window.removeEventListener('waveforge:inparty-friend-added', sync)
    }
  }, [])
  const openDM = (peerId: string) => { setDmPeer(peerId); onOpenDM(peerId) }
  const dmFriend = friends.find(f => f.peerId === dmPeer)
  const now = Date.now()

  if (dmFriend) {
    const messages = dmFriend.messages ?? []
    const online = roomMembers.some(m => m.peerId === dmFriend.peerId && m.online)
    return (
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setDmPeer(null)} className="rounded-lg p-1 text-white/45 hover:bg-white/10">←</button>
          <PartyAvatar profile={dmFriend} size={26} ring={online ? '#34d399' : undefined} />
          <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-white/85">{dmFriend.nickname}</span>
          <span className="text-[9px]" style={{ color: online ? '#6ee7b7' : 'rgba(255,255,255,0.35)' }}>{online ? '在线' : dmFriend.lastSeenAt ? '最后在线 ' + new Date(dmFriend.lastSeenAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '离线'}</span>
        </div>
        <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-xl border p-2.5" style={{ borderColor: BORDER }}>
          {messages.length === 0 && <p className="py-4 text-center text-[10px] text-white/30">还没有聊天记录</p>}
          {messages.map(message => (
            <div key={message.id} className={'flex ' + (message.self ? 'justify-end' : 'justify-start')}>
              <div className="max-w-[80%] rounded-xl px-2.5 py-1.5 text-[10.5px] leading-relaxed"
                style={{
                  background: message.self ? 'rgba(255,232,156,0.12)' : 'rgba(255,255,255,0.06)',
                  color: 'rgba(255,255,255,0.85)',
                  opacity: message.pending ? 0.6 : 1,
                }}>
                {message.text}
                {message.pending && <span className="ml-1 text-[8px] text-white/35">待送达</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-1.5">
          <input
            value={dmText}
            onChange={e => setDmText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && dmText.trim()) { onSendDM(dmFriend.peerId, dmText); setDmText('') } }}
            placeholder={sessionLive ? '发私信…（同房实时，离线排队）' : '进入任意房间后可发送'}
            disabled={!sessionLive}
            maxLength={500}
            className="min-w-0 flex-1 rounded-xl border bg-black/35 px-3 py-2 text-[11px] text-white/90 outline-none focus:border-amber-300/40 disabled:opacity-45"
            style={{ borderColor: BORDER }}
          />
          <button
            type="button" disabled={!sessionLive || !dmText.trim()}
            onClick={() => { if (dmText.trim()) { onSendDM(dmFriend.peerId, dmText); setDmText('') } }}
            className="rounded-xl px-3 py-2 text-black disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
        <button type="button" onClick={() => setFriends(removeFriend(dmFriend.peerId))} className="w-full rounded-lg py-1 text-[9px] text-white/25 hover:text-red-400">删除该好友</button>
      </div>
    )
  }

  return (
    <div className="space-y-1.5 p-3">
      {requests.map(request => (
        <div key={request.from} className="rounded-xl border px-2.5 py-2" style={{ background: 'rgba(255,232,156,0.06)', borderColor: GOLD + '44' }}>
          <div className="flex items-center gap-2">
            <PartyAvatar profile={request.profile} size={26} />
            <span className="min-w-0 flex-1 truncate text-[11px] text-white/85">{request.profile.nickname} 请求加好友</span>
          </div>
          <div className="mt-1.5 flex gap-1.5">
            <button type="button" onClick={() => onAccept(request.from)} className="flex-1 rounded-lg py-1 text-[10px] font-bold text-black" style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}>同意</button>
            <button type="button" onClick={() => onDecline(request.from)} className="flex-1 rounded-lg border py-1 text-[10px] text-white/55" style={{ borderColor: BORDER }}>忽略</button>
          </div>
        </div>
      ))}
      {friends.length === 0 && requests.length === 0 && <p className="py-6 text-center text-[10px] text-white/30">还没有好友——在成员卡里点「加好友」</p>}
      {friends.map(friend => {
        const online = roomMembers.some(m => m.peerId === friend.peerId && m.online) ||
          (friend.lastSeenAt && now - friend.lastSeenAt < 60_000)
        // 只有「不在这个会话里」的未读才算徽标：正在看的会话清零后不再重复显示
        const unread = dmPeer === friend.peerId ? 0 : (friend.messages ?? []).filter(m => !m.self).length
        return (
          <button
            key={friend.peerId} type="button" onClick={() => openDM(friend.peerId)}
            className="group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.05]"
            style={{ background: PANEL_2 }}
          >
            <span className="relative">
              <PartyAvatar profile={friend} size={28} ring={online ? '#34d399' : undefined} />
              {online && <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-[#0b0b0e]" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-medium text-white/85">{friend.nickname}</span>
              <span className="block text-[9px] text-white/35">{online ? '在线' : friend.lastRoom ? '最近：' + friend.lastRoom : '离线'}</span>
            </span>
            {unread > 0 && <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold text-black" style={{ background: GOLD }}>{unread}</span>}
            <Trash2
              className="h-3 w-3 shrink-0 text-white/30 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
              onClick={e => { e.stopPropagation(); setFriends(removeFriend(friend.peerId)) }}
            />
          </button>
        )
      })}
    </div>
  )
}

/** 邀请弹窗：完整邀请串 + 房间名/密码状态 + 一键复制 */
function InviteModal({ snapshot, onClose }: { snapshot: InPartySessionSnapshot; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const room = snapshot.room
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[96] flex items-center justify-center p-6"
      style={{ backgroundColor: 'rgba(2,2,4,0.72)', backdropFilter: 'blur(10px)' }} onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.94, y: 14, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.94, y: 14, opacity: 0 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-lg rounded-3xl border p-6"
        style={{ background: 'linear-gradient(160deg,#12100a,#0b0b0e)', borderColor: BORDER }}
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-bold text-white"><Link2 className="h-4.5 w-4.5" style={{ color: GOLD }} />邀请加入 {snapshot.roomName || room?.roomId}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-4 flex items-start gap-4">
          <div className="min-w-0 shrink-0">
            <div className="rounded-2xl bg-white p-2">
              <QRCodeSVG value={snapshot.invite || 'wf-resonance://'} size={112} level="M" />
            </div>
            {/* 房间码大字展示（口头告知用）+ 指纹（当面核对，防中间人） */}
            <p className="mt-2 text-center font-mono text-lg font-bold tracking-[0.18em]" style={{ color: GOLD }}>#{room?.roomId || '————'}</p>
            {snapshot.fingerprint && <p className="mt-0.5 text-center text-[10px] text-white/40" title="房间指纹（当面核对，防中间人）">{snapshot.fingerprint}</p>}
          </div>
          <textarea
            readOnly value={snapshot.invite} rows={4} onFocus={e => e.currentTarget.select()}
            className="min-w-0 flex-1 resize-none rounded-xl bg-black/45 border p-3 font-mono text-[11px] leading-relaxed text-white/75 outline-none"
            style={{ borderColor: BORDER }}
          />
        </div>
        <ul className="mt-3 space-y-1 text-[11px] text-white/45">
          <li>· 邀请串 = 房间地址 + 房间密钥，等同门钥匙：只发给信任的人</li>
          {room?.visibility === 'private' && <li className="text-orange-300/80">· 这是私有房：把 6 位密码单独告诉对方（密码不包含在邀请串里）</li>}
          <li>· 对方在 In Party → 加入房间 粘贴邀请串即可</li>
        </ul>
        <button
          type="button" onClick={() => { void navigator.clipboard.writeText(snapshot.invite); setCopied(true); window.setTimeout(() => setCopied(false), 1600) }}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-sm font-bold text-black"
          style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? '已复制到剪贴板' : '复制邀请串'}
        </button>
      </motion.div>
    </motion.div>
  )
}

/** 视频墙：摄像头广播的观看网格 + 我的开播控制条 */
function CameraWall({ snapshot, selfPeerId, camera, settings, session, panicKeys }: {
  snapshot: InPartySessionSnapshot
  selfPeerId: string
  camera: ReturnType<typeof useCameraBroadcast>
  settings: InPartySettings
  session: ReturnType<typeof getInPartySession>
  panicKeys: string[]
}) {
  const others = snapshot.broadcasters.filter(b => b.peerId !== selfPeerId)
  const [autoStop, setAutoStop] = useState<number>(settings.cameraAutoStop)
  // 一键全黑快捷键：仅在 In Party 模式下监听（离开模式不抢系统快捷键）；
  // 键位用户可自定义（最多 3 个，HotkeyCapture 录制），默认 Ctrl+Shift+Z。
  useEffect(() => {
    if (!settings.cameraPanicHotkey || !panicKeys.length) return
    const onKey = (e: KeyboardEvent) => {
      const match = panicKeys.every(key => {
        const k = key.toLowerCase()
        if (k === 'ctrl') return e.ctrlKey
        if (k === 'shift') return e.shiftKey
        if (k === 'alt') return e.altKey
        if (k === 'meta' || k === 'cmd') return e.metaKey
        return e.key.toLowerCase() === k
      })
      if (!match) return
      e.preventDefault()
      e.stopPropagation()
      if (camera.cameraState.broadcasting) camera.toggleBlank()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [camera, settings.cameraPanicHotkey, panicKeys])

  return (
    <div className="flex min-h-0 flex-col gap-2 rounded-2xl border p-3" style={{ background: PANEL, borderColor: BORDER }}>
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-bold text-white/80">
          {camera.cameraState.broadcasting ? <Video className="mr-1.5 inline h-3.5 w-3.5" style={{ color: GOLD }} /> : <VideoOff className="mr-1.5 inline h-3.5 w-3.5 text-white/30" />}摄像头
        </h3>
        {camera.cameraState.broadcasting && (
          <span className="ml-auto flex items-center gap-2 text-[10px]" style={{ color: GOLD }}>
            <MonitorUp className="h-3 w-3" />直播中{camera.cameraState.autoStopRemaining > 0 ? ` · ${camera.cameraState.autoStopRemaining}s` : ''}
          </span>
        )}
      </div>
      {camera.cameraState.error && <p className="text-[10px] text-red-300/80">{camera.cameraState.error}</p>}
      {/* 我的开播控制 */}
      <div className="flex items-center gap-2">
        {camera.cameraState.broadcasting ? (
          <>
            <button
              type="button" onClick={camera.toggleBlank}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-[11px] font-medium border"
              style={{ borderColor: camera.cameraState.blanked ? 'rgba(255,120,90,0.5)' : BORDER, background: camera.cameraState.blanked ? 'rgba(255,90,60,0.14)' : PANEL_2, color: camera.cameraState.blanked ? '#ff9c8a' : 'rgba(255,255,255,0.7)' }}
              title="立刻黑屏（流保持），再按恢复"
            >
              <EyeOff className="h-3.5 w-3.5" />{camera.cameraState.blanked ? '恢复画面' : '一键全黑'}
            </button>
            <button
              type="button" onClick={() => camera.stopBroadcast(true)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-500/15 py-2 text-[11px] text-red-300 hover:bg-red-500/25"
            >
              <VideoOff className="h-3.5 w-3.5" />停止直播
            </button>
          </>
        ) : settings.videoAllowed ? (
          <>
            <FancySelect
              value={autoStop}
              options={[
                { value: 0, label: '不自动停' },
                { value: 60, label: '1 分钟' },
                { value: 180, label: '3 分钟' },
                { value: 600, label: '10 分钟' },
              ]}
              onChange={v => setAutoStop(v)}
              width={96}
            />
            {camera.cameraState.countdownRemaining > 0 ? (
              <button
                type="button" onClick={camera.cancelCountdown}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl py-2 text-[13px] font-bold"
                style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})`, color: '#1a1408' }}
                title="点击取消"
              >
                <span className="animate-pulse tabular-nums">{camera.cameraState.countdownRemaining}</span> 秒后开播 · 点此取消
              </button>
            ) : (
              <button
                type="button" onClick={() => void camera.startBroadcast(autoStop)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-[11px] font-bold text-black"
                style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}
              >
                <Video className="h-3.5 w-3.5" />开摄像头
              </button>
            )}
          </>
        ) : (
          <p className="text-[10px] text-white/35">摄像头已在设置中关闭</p>
        )}
      </div>
      {/* 观看网格（开播的自己 + 其他广播者） */}
      {(camera.cameraState.broadcasting || others.length > 0) && (
        <div className={`grid gap-2 ${others.length > 0 || camera.cameraState.broadcasting ? 'grid-cols-2' : ''}`}>
          {camera.cameraState.broadcasting && camera.cameraState.stream && (
            <div className="relative overflow-hidden rounded-xl bg-black" style={{ aspectRatio: '4/3' }}>
              <video
                autoPlay playsInline muted
                ref={el => { if (el && el.srcObject !== camera.cameraState.stream) el.srcObject = camera.cameraState.stream! }}
                className="h-full w-full object-cover"
                style={{ filter: camera.cameraState.blanked ? 'brightness(0)' : undefined }}
              />
              <span className="absolute left-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] text-white/85">我 · 直播中</span>
            </div>
          )}
          {others.map(broadcaster => {
            const stream = camera.cameraState.watching.get(broadcaster.peerId)
            const watching = Boolean(stream)
            return (
              <div key={broadcaster.peerId} className="relative overflow-hidden rounded-xl bg-black" style={{ aspectRatio: '4/3' }}>
                {watching && stream ? (
                  <video
                    autoPlay playsInline
                    ref={el => { if (el && el.srcObject !== stream) el.srcObject = stream }}
                    className="h-full w-full object-cover"
                    style={{ filter: broadcaster.blanked ? 'brightness(0)' : undefined }}
                  />
                ) : (
                  <button type="button" onClick={() => void camera.watch(broadcaster.peerId)} className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-white/45 hover:bg-white/[0.05]">
                    <PartyAvatar profile={{ ...broadcaster, avatarGradient: ['#FFE89C', '#d9a13c'] }} size={30} />
                    <span className="flex items-center gap-1 text-[10px]"><Eye className="h-3 w-3" />看 {broadcaster.nickname || '画面'}</span>
                  </button>
                )}
                <span className="absolute left-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] text-white/85">
                  {broadcaster.nickname}{broadcaster.blanked ? ' · 已遮蔽' : ''}
                </span>
                {watching && (
                  <button type="button" onClick={() => camera.unwatch(broadcaster.peerId)} className="absolute right-1.5 top-1.5 rounded-md bg-black/55 p-1 text-white/70 hover:text-white">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
      {!camera.cameraState.broadcasting && others.length === 0 && (
        <p className="text-[10px] leading-relaxed text-white/35">「开摄像头」直接向全房间直播；其他人点画面观看。安全倒计时到点自动关闭；一键全黑键位可在设置里自定义（仅 In Party 内生效）。</p>
      )}
      {/* 离开房间时自动停播 */}
      <SessionCleanup onLeave={() => { if (camera.cameraState.broadcasting) camera.stopBroadcast(false) }} session={session} />
    </div>
  )
}

/** 房间卸载兜底（离开/解散时停摄像头） */
function SessionCleanup({ onLeave, session }: { onLeave: () => void; session: ReturnType<typeof getInPartySession> }) {
  const wasLive = useRef(false)
  useEffect(() => {
    const unsubscribe = session.subscribe(() => {
      const live = session.getSnapshot().live
      if (wasLive.current && !live) onLeave()
      wasLive.current = live
    })
    return unsubscribe
  }, [onLeave, session])
  return null
}

/** 房间视图：公告 + 成员栏（含正在听）+ 聊天（@/撤回）+ 侧栏（互控/轮盘/摄像头/日志/好友 五页签） */
function Room({ snapshot, selfPeerId, settings, onLeave, onDissolve, onKick, onSetInterControl, onSendOp, onRequestControl, onOpenInvite, onQuickAction, onBindWave, onStartRoulette, onRespondRoulette, onSpinRoulette, onSetAnnouncement, onRecall, onAddFriend, onAcceptFriend, onDeclineFriend, camera, voice, session, sideTab, setSideTab, nowPlaying, onGain, liveLevel, panicKeys, onOpenFriends, onOpenAchievements }: {
  snapshot: InPartySessionSnapshot
  selfPeerId: string
  settings: InPartySettings
  onLeave: () => void
  onDissolve: () => void
  onKick: (peerId: string) => void
  onSetInterControl: (enabled: boolean) => void
  onSendOp: (peerId: string, op: { kind: 'strength'; channel: 'A' | 'B'; value: number } | { kind: 'clear' }) => void
  onRequestControl: (peerId: string) => void
  onOpenInvite: () => void
  onQuickAction: (peerId: string, actionId: QuickActionId, channel: QuickChannel) => void
  onBindWave: (peerId: string, channel: 'A' | 'B', on: boolean) => void
  onStartRoulette: (target: string) => void
  onRespondRoulette: (accept: boolean) => void
  onSpinRoulette: () => void
  onSetAnnouncement: (text: string) => void
  onRecall: (messageId: string) => void
  onAddFriend: (member: PartyMember) => void
  onAcceptFriend: (peerId: string) => void
  onDeclineFriend: (peerId: string) => void
  camera: ReturnType<typeof useCameraBroadcast>
  voice: ReturnType<typeof useVoiceRoom>
  session: ReturnType<typeof getInPartySession>
  sideTab: string
  setSideTab: (tab: string) => void
  nowPlaying?: { title: string; artists: string; playing: boolean } | null
  onGain: (peerId: string, channel: 'A' | 'B', gain: number) => void
  liveLevel: { left: number; right: number }
  panicKeys: string[]
  onOpenFriends: () => void
  onOpenAchievements: () => void
}) {
  const room = snapshot.room
  const [memberCard, setMemberCard] = useState<PartyMember | null>(null)
  const [coyoteFor, setCoyoteFor] = useState<{ peerId: string; name: string } | null>(null)
  const [text, setText] = useState('')
  const [privateTo, setPrivateTo] = useState<string | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recordingRef = useRef<{ recorder: MediaRecorder; chunks: Blob[]; startedAt: number } | null>(null)
  const [recordingSecs, setRecordingSecs] = useState(0)
  const [announcing, setAnnouncing] = useState(false)
  const [announcementDraft, setAnnouncementDraft] = useState('')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const isHost = snapshot.role === 'host'
  const room2 = snapshot.room

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [snapshot.chat.length])

  if (!room) return null

  const sendText = () => {
    const value = text.trim()
    if (!value) return
    const { clean, mentions } = session.parseMentions(value)
    if (session.sendChat({ kind: 'text', text: clean.slice(0, INPARTY_CHAT_LIMIT), to: privateTo || undefined })) setText('')
    void mentions
  }

  const pickImage = async (file: File) => {
    try {
      const { dataUrl } = await compressImage(file, INPARTY_IMAGE_MAX_EDGE)
      session.sendChat({ kind: 'image', dataUrl, to: privateTo || undefined })
    } catch {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '图片读取失败', type: 'error' } }))
    }
  }

  const toggleRecord = async () => {
    if (recordingRef.current) {
      recordingRef.current.recorder.stop()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      const chunks: Blob[] = []
      const startedAt = Date.now()
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop())
        const durationSec = Math.round((Date.now() - startedAt) / 1000)
        recordingRef.current = null
        setRecordingSecs(0)
        if (durationSec < 1) return
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        if (durationSec > INPARTY_AUDIO_MAX_SEC) {
          window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `语音最长 ${INPARTY_AUDIO_MAX_SEC} 秒`, type: 'error' } }))
          return
        }
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
        session.sendChat({ kind: 'audio', dataUrl, durationSec, to: privateTo || undefined })
      }
      recordingRef.current = { recorder, chunks, startedAt }
      recorder.start()
      setRecordingSecs(0)
      const tick = window.setInterval(() => {
        if (!recordingRef.current) { window.clearInterval(tick); return }
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        setRecordingSecs(elapsed)
        if (elapsed >= INPARTY_AUDIO_MAX_SEC) recordingRef.current.recorder.stop()
      }, 1000)
    } catch {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '麦克风不可用', type: 'error' } }))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {/* 顶栏：房间信息 */}
      <div className="flex items-center gap-3 rounded-2xl border px-4 py-2.5" style={{ background: PANEL, borderColor: BORDER }}>
        <Users className="h-4 w-4" style={{ color: GOLD }} />
        <span className="text-sm font-bold text-white/90">{snapshot.roomName || room.roomId}</span>
        <span className="text-[10px] text-white/30">#{room.roomId}</span>
        <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: room.visibility === 'private' ? 'rgba(255,150,90,0.15)' : 'rgba(255,232,156,0.12)', color: room.visibility === 'private' ? '#ffb27a' : GOLD }}>
          {room.visibility === 'private' ? '私有 · 密码房' : '公开'}
        </span>
        <span className="text-[11px] text-white/40">{snapshot.summary?.online ?? 0}/{room.maxMembers} 在线</span>
        <span className="flex-1" />
        {/* 好友/成就：与大厅右上角同一对入口（房间内也要可达） */}
        <button
          type="button" onClick={onOpenFriends}
          className="relative rounded-lg p-1.5 text-white/45 hover:bg-white/10" title="好友"
        >
          <UserPlus className="h-3.5 w-3.5" />
          {snapshot.friendRequests.length > 0 && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-red-400" />}
        </button>
        <button type="button" onClick={onOpenAchievements} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10" title="成就">
          <Trophy className="h-3.5 w-3.5" />
        </button>
        {/* 公告：显示在同步听条位置，编辑入口收进这里（点击即编辑） */}
        {(room.announcement || isHost) && (
          <span className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-0.5" style={{ background: 'rgba(255,232,156,0.07)', maxWidth: '28%' }}>
            <Bell className="h-3 w-3 shrink-0" style={{ color: GOLD }} />
            {announcing ? (
              <input
                autoFocus value={announcementDraft} maxLength={120}
                onChange={e => setAnnouncementDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { onSetAnnouncement(announcementDraft); setAnnouncing(false) } if (e.key === 'Escape') setAnnouncing(false) }}
                onBlur={() => { onSetAnnouncement(announcementDraft); setAnnouncing(false) }}
                placeholder="房间公告…"
                className="w-full bg-transparent text-[10px] text-white/85 outline-none"
              />
            ) : (
              <button type="button" onClick={() => { if (isHost) { setAnnouncing(true); setAnnouncementDraft(room.announcement || '') } }} className="min-w-0 truncate text-[10px] text-white/60" title={room.announcement || '设置公告'}>
                {room.announcement || '设个公告'}
              </button>
            )}
          </span>
        )}
        <button
          type="button" onClick={onOpenInvite}
          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium"
          style={{ background: 'rgba(255,232,156,0.12)', color: GOLD }}
          title="邀请成员"
        >
          <Copy className="h-3 w-3" />邀请
        </button>
        {isHost ? (
          <button type="button" onClick={onDissolve} className="rounded-lg px-2.5 py-1 text-[11px] text-red-300/80 hover:bg-red-400/10">解散</button>
        ) : (
          <button type="button" onClick={onLeave} className="rounded-lg px-2.5 py-1 text-[11px] text-red-300/80 hover:bg-red-400/10">退出</button>
        )}
      </div>

      {/* 同步听横条（房主广播/成员跟随） */}
      {(
        <SyncListenBar
          snapshot={snapshot}
          selfPeerId={selfPeerId}
          session={session}
          onFollow={on => session.setFollowHostRhythm(on)}
          nowPlaying={nowPlaying}
          onPlaySame={title => {
            // 跟播：派发全局搜索播放事件（App 的搜索层会接住并自动播放第一结果）
            window.dispatchEvent(new CustomEvent('waveforge:inparty-play-same', { detail: { title } }))
            window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `正在为你找《${title}》并跟播…`, type: 'info' } }))
          }}
          onRequestSong={title => void session.requestSong(title)}
          onCompleteRequest={from => session.completeSongRequest(from)}
        />
      )}

      {/* 主体三栏：成员 | 聊天 | 互控+摄像头 */}
      <div className="mt-3 grid min-h-0 flex-1 gap-3 lg:grid-cols-[230px_1fr_330px]">
        {/* 成员栏 */}
        <div className="flex min-h-0 flex-col gap-2">
        {/* 互控总闸（房主）：紧贴成员列表,语义清晰 */}
        {isHost && (
          <button
            type="button" onClick={() => onSetInterControl(!room.interControlAllowed)}
            className="flex shrink-0 items-center justify-center gap-1.5 rounded-xl border py-2 text-[10.5px] font-medium transition-colors"
            style={{ borderColor: room.interControlAllowed ? `${GOLD}66` : BORDER, background: room.interControlAllowed ? 'rgba(255,232,156,0.08)' : PANEL_2, color: room.interControlAllowed ? GOLD : 'rgba(255,255,255,0.45)' }}
            title="总闸：允许成员之间互相控制"
          >
            <Hand className="h-3 w-3" />互控{room.interControlAllowed ? '已开放' : '已关闭'}
          </button>
        )}
        {/* 迷你紧急叫停（常驻成员栏顶部，红脉冲） */}
        <button
          type="button" onClick={() => session.pauseMe()}
          className="flex shrink-0 items-center justify-center gap-1.5 rounded-xl border-2 py-2 text-[11px] font-bold transition-all hover:brightness-125"
          style={{ borderColor: 'rgba(255,120,90,0.55)', background: 'rgba(255,90,60,0.12)', color: '#ff9c8a', animation: 'pulse 2s ease-in-out infinite' }}
          title="我的设备立刻归零 + 退出进行中的玩法"
        >
          <Volume2 className="h-3.5 w-3.5" />紧急叫停
        </button>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto rounded-2xl border p-2.5" style={{ background: PANEL, borderColor: BORDER }}>
          {room.members.map(member => {
            const granted = (snapshot.grantsByPeer[member.peerId] || 0) > Date.now()
            return (
              <button
                key={member.peerId} type="button"
                onClick={() => { if (member.peerId !== selfPeerId) setMemberCard(member) }}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors ${member.peerId !== selfPeerId ? 'hover:bg-white/[0.07]' : 'opacity-90'}`}
              >
                <span className="relative">
                  <PartyAvatar profile={member} size={34} ring={member.online ? undefined : 'rgba(255,255,255,0.15)'} />
                  {snapshot.broadcasters.some(b => b.peerId === member.peerId) && (
                    <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-[#0b0b0e]" title="正在直播摄像头" />
                  )}
                  {snapshot.voiceUsers[member.peerId] && (
                    <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-[#0b0b0e]" style={{ background: snapshot.voiceUsers[member.peerId].muted ? 'rgba(255,255,255,0.3)' : '#34d399' }} title={snapshot.voiceUsers[member.peerId].muted ? '语音中(静音)' : '语音中'}>
                      {snapshot.voiceUsers[member.peerId].muted ? <MicOff className="h-2 w-2 text-black/70" /> : <Mic className="h-2 w-2 text-black/80" />}
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-semibold text-white/90">{member.nickname}</span>
                    {member.peerId === room.hostId && <Crown className="h-3 w-3 shrink-0" style={{ color: GOLD }} />}
                    {member.peerId === selfPeerId && <span className="shrink-0 text-[9px] text-white/35">(我)</span>}
                    {(snapshot.unreadByPeer[member.peerId] ?? 0) > 0 && (
                      <span className="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold text-black" style={{ background: GOLD }}>
                        {snapshot.unreadByPeer[member.peerId]}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-[9.5px] text-white/35">
                    {member.device.connected
                      ? <><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />设备在线 · {member.device.version === 'v4' ? '4.0' : '3.0'}</>
                      : <><span className="h-1.5 w-1.5 rounded-full bg-white/20" />设备未连接</>}
                    {granted && <span className="ml-auto" style={{ color: GOLD }}>已授权</span>}
                    {session.getSnapshot().spectating && member.peerId === selfPeerId && <span className="ml-auto text-[9px]" style={{ color: '#7cc4ff' }}>观战中</span>}
                  </span>
                  {member.nowPlaying && (
                    <span className="mt-0.5 flex items-center gap-1 text-[9px]" style={{ color: 'rgba(255,232,156,0.55)' }}>
                      <Music2 className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate">{member.nowPlaying.playing ? '♪ ' : '⏸ '}{member.nowPlaying.title}{member.nowPlaying.artists ? ' - ' + member.nowPlaying.artists : ''}</span>
                    </span>
                  )}
                </span>
                {member.peerId !== selfPeerId && isHost && (
                  <X
                    className="h-3.5 w-3.5 text-white/25 hover:text-red-400"
                    onClick={e => { e.stopPropagation(); onKick(member.peerId) }}
                  />
                )}
              </button>
            )
          })}
        </div>
        </div>

        {/* 聊天区 */}
        <div className="flex min-h-0 flex-col rounded-2xl border" style={{ background: PANEL, borderColor: BORDER }}>
          {privateTo && (
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px]" style={{ borderColor: BORDER, color: GOLD }}>
              <span>私聊 · {room.members.find(m => m.peerId === privateTo)?.nickname || ''}</span>
              <button type="button" onClick={() => setPrivateTo(null)} className="ml-auto text-white/40 hover:text-white/80"><X className="h-3 w-3" /></button>
            </div>
          )}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {snapshot.chat.map(message => {
              if (message.kind === 'system') {
                return <p key={message.id} className="text-center text-[10px] text-white/30">{message.text}</p>
              }
              const mine = message.from === selfPeerId
              const sender = room.members.find(m => m.peerId === message.from)
              return (
                <div key={message.id} className={`flex gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
                  {sender ? <PartyAvatar profile={sender} size={26} /> : <span className="h-[26px] w-[26px]" />}
                  <div className={`max-w-[75%] ${mine ? 'items-end' : ''}`}>
                    <p className={`text-[9.5px] ${mine ? 'text-right' : ''} text-white/30`}>
                      {message.nickname}{message.to ? ' · 私聊' : ''} · {new Date(message.at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <div className="mt-0.5 rounded-2xl px-3 py-2 text-xs leading-relaxed"
                      style={{ background: mine ? 'rgba(255,232,156,0.14)' : 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.88)' }}>
                      {message.kind === 'text' && (message.recalled
                        ? <p className="italic text-white/30">撤回了一条消息</p>
                        : <p className="whitespace-pre-wrap break-words">{renderTextWithMentions(message.text || '', room.members)}</p>)}
                      {(message.kind === 'text' || message.kind === 'image') && !message.recalled && (
                        <ReactionBar snapshot={snapshot} messageId={message.id} onToggle={(id, emoji) => session.toggleReaction(id, emoji)} />
                      )}
                      {message.kind === 'text' && !message.recalled && mine && (
                        <button
                          type="button" onClick={() => onRecall(message.id)}
                          className="mt-0.5 block text-[9px] text-white/25 hover:text-red-300"
                          title="撤回（2 分钟内）"
                        >
                          撤回
                        </button>
                      )}
                      {message.kind === 'image' && (
                        <img
                          src={message.dataUrl} alt="图片消息"
                          className="max-h-56 cursor-zoom-in rounded-lg transition-transform hover:scale-[1.01]"
                          onClick={() => setLightbox(message.dataUrl || '')}
                        />
                      )}
                      {message.kind === 'audio' && <VoiceBubble src={message.dataUrl || ''} durationSec={message.durationSec || 0} mine={Boolean(mine)} />}
                    </div>
                  </div>
                </div>
              )
            })}
            <div ref={chatEndRef} />
          </div>
          {/* 输入中提示（QQ 式「xx 正在输入…」） */}
          <div className="h-5 px-3">
            {(() => {
              const typing = Object.entries(snapshot.typingPeers).filter(([peerId]) => !privateTo || privateTo === peerId)
              if (!typing.length) return null
              const names = typing.map(([peerId]) => room2?.members.find(m => m.peerId === peerId)?.nickname || '有人')
              return <p className="truncate text-[10px]" style={{ color: GOLD + '99' }}>{names.join('、')} 正在输入…</p>
            })()}
          </div>
          {/* 输入行 */}
          <div className="flex items-center gap-1.5 border-t p-2.5" style={{ borderColor: BORDER }}>
            <button type="button" onClick={() => fileRef.current?.click()} className="rounded-lg p-2 text-white/45 hover:bg-white/10" title="发图片（自动压缩）">
              <ImageIcon className="h-4 w-4" />
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const file = e.target.files?.[0]; if (file) void pickImage(file); e.target.value = '' }} />
            <button
              type="button" onClick={() => void toggleRecord()}
              className={`rounded-lg p-2 transition-colors ${recordingRef.current ? 'bg-red-500/20 text-red-300' : 'text-white/45 hover:bg-white/10'}`}
              title={recordingRef.current ? `停止并发送（${recordingSecs}s / ${INPARTY_AUDIO_MAX_SEC}s）` : '录制语音（再点停止）'}
            >
              {recordingRef.current ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
            {recordingRef.current && <span className="text-[10px] tabular-nums text-red-300">{recordingSecs}s</span>}
            <input
              value={text}
              onChange={e => { setText(e.target.value); if (e.target.value.trim()) session.notifyTyping(privateTo || 'room') }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) sendText() }}
              placeholder={privateTo ? '私聊消息…' : '和大家聊聊…'}
              maxLength={INPARTY_CHAT_LIMIT}
              className="min-w-0 flex-1 rounded-xl bg-black/35 border px-3 py-2 text-xs text-white/90 outline-none focus:border-amber-300/40"
              style={{ borderColor: BORDER }}
            />
            <button type="button" onClick={sendText} className="rounded-xl px-3 py-2 text-black" style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}>
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* 侧栏：页签（互控台｜轮盘｜日志｜好友）+ 摄像头 + 叫停 */}
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border" style={{ background: PANEL, borderColor: BORDER }}>
            <div className="flex shrink-0 gap-1 border-b px-2 pt-2" style={{ borderColor: BORDER }}>
              {([['deck', '互控台', Hand], ['games', '玩法', Gamepad2], ['roulette', '轮盘', Dices], ['duel', '决斗', Flame], ['log', '日志', ScrollText]] as const).map(([key, label, Icon]) => (
                <button
                  key={key} type="button" onClick={() => setSideTab(key)}
                  className={'relative flex flex-1 items-center justify-center gap-1 rounded-t-lg px-1 pb-2 pt-1.5 text-[10.5px] transition-colors ' + (sideTab === key ? 'font-bold' : 'text-white/40 hover:text-white/70')}
                  style={sideTab === key ? { color: GOLD } : undefined}
                >
                  <Icon className="h-3 w-3" />{label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sideTab === 'deck' && (
                <ControlDeck snapshot={snapshot} selfPeerId={selfPeerId} onSendOp={onSendOp} onQuickAction={onQuickAction} onBindWave={onBindWave} onGain={onGain} session={session} liveLevel={liveLevel} />
              )}
              {sideTab === 'games' && (
                <GameHubPanel
                  snapshot={snapshot}
                  selfPeerId={selfPeerId}
                  session={session}
                  onOpenRoulette={() => setSideTab('roulette')}
                  onStart={kind => {
                    if (kind === 'duel') { setSideTab('duel'); return }
                    if (kind === 'team-match') { void session.startTeamMatch(); return }
                    if (kind === 'dice') { void session.rollPunishDice(); return }
                    if (kind === 'undercover') { void session.startUndercover(); return }
                    void session.startGame(kind as GameKind)
                  }}
                  onSubmit={value => session.submitGame(value)}
                />
              )}
              {sideTab === 'roulette' && (
                <RoulettePanel snapshot={snapshot} selfPeerId={selfPeerId} session={session} onStart={onStartRoulette} onRespond={onRespondRoulette} onSpin={onSpinRoulette} />
              )}
              {sideTab === 'log' && (
                <>
                  <PartySummaryCard stats={snapshot.partyStats} />
                  <ControlLogList log={snapshot.controlLog} />
                </>
              )}
              {sideTab === 'duel' && (
                <DuelPanel
                  snapshot={snapshot}
                  selfPeerId={selfPeerId}
                  session={session}
                  onStart={bestOf => void session.startDuel(bestOf)}
                  onAnswer={option => session.answerDuel(option)}
                />
              )}
            </div>
          </div>
          <CameraWall snapshot={snapshot} selfPeerId={selfPeerId} camera={camera} settings={settings} session={session} panicKeys={panicKeys} />
          {/* 语音房（连麦） */}
          <div className="rounded-2xl border p-3" style={{ background: PANEL, borderColor: BORDER }}>
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-bold text-white/80">
                {voice.voiceState.inVoice ? <Mic className="mr-1.5 inline h-3.5 w-3.5" style={{ color: GOLD }} /> : <MicOff className="mr-1.5 inline h-3.5 w-3.5 text-white/30" />}语音房
              </h3>
              <span className="ml-auto text-[10px] text-white/40">{Object.keys(snapshot.voiceUsers).length} 人连麦</span>
            </div>
            {voice.voiceState.error && <p className="mt-1 text-[10px] text-red-300/80">{voice.voiceState.error}</p>}
            <div className="mt-2 flex items-center gap-2">
              {voice.voiceState.inVoice ? (
                <>
                  {/* 说话指示（我的电平） */}
                  <span className="flex h-8 w-16 items-center justify-center gap-[2px] rounded-lg" style={{ background: PANEL_2 }}>
                    {Array.from({ length: 7 }).map((_, index) => {
                      const level = voice.voiceState.muted ? 0 : voice.voiceState.speakingLevel
                      const active = level * 7 > index
                      return <span key={index} className="w-[3px] rounded-full transition-all duration-100" style={{ height: 4 + index * 2, background: active ? GOLD : 'rgba(255,255,255,0.15)' }} />
                    })}
                  </span>
                  <button
                    type="button" onClick={voice.toggleMute}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-[11px] font-medium border"
                    style={voice.voiceState.muted ? { background: 'rgba(255,90,60,0.12)', borderColor: 'rgba(255,120,90,0.4)', color: '#ff9c8a' } : { background: PANEL_2, borderColor: BORDER, color: 'rgba(255,255,255,0.8)' }}
                  >
                    {voice.voiceState.muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}{voice.voiceState.muted ? '已静音' : '静音'}
                  </button>
                  <button type="button" onClick={() => voice.leaveVoice(true)} className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-500/15 py-2 text-[11px] text-red-300 hover:bg-red-500/25">
                    <LogOut className="h-3.5 w-3.5" />离开
                  </button>
                </>
              ) : (
                <button
                  type="button" onClick={() => void voice.joinVoice()}
                  className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2 text-[11px] font-bold text-black"
                  style={{ background: 'linear-gradient(135deg,' + GOLD + ',' + GOLD_DEEP + ')' }}
                >
                  <Mic className="h-3.5 w-3.5" />上麦（全房间连麦）
                </button>
              )}
            </div>
            {/* 连麦成员列表 */}
            {Object.keys(snapshot.voiceUsers).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(snapshot.voiceUsers).map(([peerId, info]) => {
                  const member = room.members.find(m => m.peerId === peerId)
                  const amListening = voice.voiceState.listening.has(peerId)
                  const isMe = peerId === selfPeerId
                  const speaking = (voice.voiceState.speakingPeers[peerId] ?? (isMe && !voice.voiceState.muted ? voice.voiceState.speakingLevel : 0)) > 0.06
                  return (
                    <button
                      key={peerId} type="button" disabled={isMe} onClick={() => void voice.listenTo(peerId)}
                      className={'flex items-center gap-1 rounded-full px-2 py-1 text-[10px] transition-all ' + (speaking ? 'ring-1' : '')}
                      style={{
                        background: info.muted ? PANEL_2 : speaking ? 'rgba(52,211,153,0.22)' : 'rgba(52,211,153,0.1)',
                        color: info.muted ? 'rgba(255,255,255,0.45)' : '#6ee7b7',
                        ...(speaking ? { boxShadow: '0 0 8px rgba(52,211,153,0.5)', borderColor: 'rgba(52,211,153,0.6)' } : {}),
                      }}
                      title={isMe ? '我' : amListening ? '正在收听' : '点击收听'}
                    >
                      {info.muted ? <MicOff className="h-2.5 w-2.5" /> : <Mic className="h-2.5 w-2.5" />}
                      {member?.nickname || info.nickname}{isMe ? '(我)' : ''}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 控制申请弹条 */}
      <AnimatePresence>
        {snapshot.controlRequests.length > 0 && (
          <motion.div
            initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
            className="absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-2xl border px-4 py-3 shadow-2xl"
            style={{ background: 'linear-gradient(160deg,#171207,#0b0b0e)', borderColor: `${GOLD}55` }}
          >
            <p className="text-xs text-white/85">
              <Hand className="mr-1 inline h-3.5 w-3.5" style={{ color: GOLD }} />
              {room.members.find(m => m.peerId === snapshot.controlRequests[0])?.nickname || '有人'} 想控制你的设备
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button" onClick={() => session.respondControlRequest(snapshot.controlRequests[0], true)}
                className="rounded-lg px-4 py-1.5 text-xs font-bold text-black"
                style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}
              >
                允许（5 分钟）
              </button>
              <button
                type="button" onClick={() => session.respondControlRequest(snapshot.controlRequests[0], false)}
                className="rounded-lg px-4 py-1.5 text-xs text-white/60 hover:bg-white/10"
              >
                拒绝
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 图片灯箱 */}
      <AnimatePresence>
        {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
      </AnimatePresence>

      {/* 郊狼设备设置 */}
      <AnimatePresence>
        {coyoteFor && (
          <CoyoteSettingsModal memberPeerId={coyoteFor.peerId} memberName={coyoteFor.name} onClose={() => setCoyoteFor(null)} />
        )}
      </AnimatePresence>

      {/* 成员详情卡 */}
      <AnimatePresence>
        {memberCard && (
          <MemberCard
            member={memberCard}
            onClose={() => setMemberCard(null)}
            canControl={(() => {
              const granted = (snapshot.grantsByPeer[memberCard.peerId] || 0) > Date.now()
              return memberCard.controlPolicy === 'open' || granted
            })()}
            onRequestControl={() => onRequestControl(memberCard.peerId)}
            watching={camera.cameraState.watching.has(memberCard.peerId)}
            onWatch={() => camera.cameraState.watching.has(memberCard.peerId) ? camera.unwatch(memberCard.peerId) : void camera.watch(memberCard.peerId)}
            onChat={() => setPrivateTo(memberCard.peerId)}
            onAddFriend={() => onAddFriend(memberCard)}
            isFriend={readFriends().some(f => f.peerId === memberCard.peerId)}
            onOpenCoyote={() => setCoyoteFor({ peerId: memberCard.peerId, name: memberCard.nickname })}
            isHostView={isHost}
            muted={session.isMuted(memberCard.peerId)}
            onMute={minutes => session.hostMute(memberCard.peerId, minutes)}
            remark={readFriends().find(f => f.peerId === memberCard.peerId)?.bio}
            onRemark={name => { const friends = readFriends(); const target = friends.find(f => f.peerId === memberCard.peerId); if (target) upsertFriend({ ...target, bio: name || undefined }) }}
            onPromote={peerId => session.isAdmin(peerId) && peerId !== snapshot.room?.hostId ? session.hostDemote(peerId) : session.hostPromote(peerId)}
            isAdminTarget={session.isAdmin(memberCard.peerId) && memberCard.peerId !== snapshot.room?.hostId}
            roomHostId={snapshot.room?.hostId}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/** 通知接受闸门 */
function PartyNotice({ onAccept }: { onAccept: (remember: boolean) => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-lg rounded-3xl border p-7"
        style={{ background: 'linear-gradient(165deg,#131007,#0a0a0d)', borderColor: BORDER }}
      >
        <h2 className="text-lg font-bold text-white">In Party · 安全须知</h2>
        <ul className="mt-4 space-y-2.5 text-xs leading-relaxed text-white/60">
          <li>1. 本模式涉及成人向设备（DG-LAB），未满 18 周岁禁止使用；请确认在场所有人都知情同意。</li>
          <li>2. 严禁将电极贴片用于上半身（耻骨区之上）任何位置；请先在 DG-LAB App 内设置好强度上限。</li>
          <li>3. 你的设备永远由你自己的上限保护：远端成员只能在你的上限内控制，无法抬高；「紧急叫停」随时一键归零。</li>
          <li>4. 摄像头画面只在本房间成员间点对点传输；支持安全倒计时与一键全黑（键位可在设置自定义），请尊重每一位参与者。</li>
          <li>5. 房间内容端到端加密、成员直连，不经任何服务器；但房主生成房间密钥，技术上可以解密房间内容。</li>
          <li>6. 请勿把房间用于骚扰他人或公开传播；被 移出/解散 后可重新加入其它房间。</li>
        </ul>
        <div className="mt-6 flex gap-2">
          <button
            type="button" onClick={() => onAccept(true)}
            className="flex-1 rounded-2xl py-3 text-sm font-bold text-black"
            style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}
          >
            我已阅读并理解（记住）
          </button>
          <button
            type="button" onClick={() => onAccept(false)}
            className="rounded-2xl px-5 py-3 text-sm text-white/55 hover:bg-white/10"
          >
            本次同意
          </button>
        </div>
      </motion.div>
    </div>
  )
}

export const INPARTY_NOTICE_KEY = 'waveforge:inparty-notice-ack'
function readNoticeAck(): boolean {
  try { return localStorage.getItem(INPARTY_NOTICE_KEY) === 'true' } catch { return false }
}

export default function InPartyView(props: {
  playerTheme?: 'dark' | 'light'
  /** 本机正在播放（广播给房间成员看「正在听」） */
  nowPlaying?: { title: string; artists: string; playing: boolean } | null
  onSelectMode: (mode: 'explore' | 'minimal' | 'traditional' | 'desktop' | 'resonance' | 'singalong' | 'inparty') => void
}) {
  const { onSelectMode } = props
  const session = getInPartySession()
  const snapshot = useSessionSnapshot()
  const [settings, setSettings] = useState<InPartySettings>(() => readInPartySettings())
  const [noticeAccepted, setNoticeAccepted] = useState(() => readNoticeAck())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [modePanelOpen, setModePanelOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [friendsOpen, setFriendsOpen] = useState(false)
  const [achievementsOpen, setAchievementsOpen] = useState(false)
  const [sideTab, setSideTab] = useState('deck')
  const entryMode = useMemo(() => readEntryMode(), [snapshot.room])
  const camera = useCameraBroadcast(session, settings.videoAllowed, settings.cameraAutoStop)
  const voice = useVoiceRoom(session, settings.videoAllowed)
  const [liveLevel, setLiveLevel] = useState({ left: 0, right: 0 })
  const [panicKeys, setPanicKeys] = useState<string[]>(() => readPanicKeys())
  const parked = useModeParked()
  const parkedRef = useRef(parked)
  parkedRef.current = parked

  /* 正在听：房间内且状态变化时广播（props.nowPlaying 驱动） */
  const lastBroadcastNp = useRef('')
  useEffect(() => {
    if (!snapshot.live) return
    const key = props.nowPlaying ? props.nowPlaying.title + '|' + props.nowPlaying.playing : ''
    if (key === lastBroadcastNp.current) return
    lastBroadcastNp.current = key
    session.broadcastNowPlaying(props.nowPlaying ? { ...props.nowPlaying, at: Date.now() } : null)
  }, [props.nowPlaying, session, snapshot.live])

  /* 波形互控采样：订阅全局音频分析器（与 DG-LAB 插件同一条 store），10Hz 推给绑定的目标；
     房主同时把节拍广播给房间（成员「跟随房主节奏」的源） */
  useEffect(() => {
    if (!snapshot.live) return
    let unsub: (() => void) | null = null
    let lastUiLevelAt = 0
    void import('../../plugins/clients/DGLabClient').then(({ getGlobalAudioAnalyzerStore }) => {
      const store = getGlobalAudioAnalyzerStore()
      if (!store) return
      let lastPush = 0
      unsub = store.subscribe(() => {
        const data = store.getSnapshot()
        if (!data) return
        const now = Date.now()
        if (now - lastPush < 100) return
        lastPush = now
        const frame = { overall: data.overall, left: data.left?.overall ?? 0, right: data.right?.overall ?? 0 }
        session.pushWaveData(frame, data.beat > 0.5)
        if (snapshot.role === 'host') session.broadcastHostBeat({ overall: data.overall, beat: data.beat })
        // UI 电平（500ms 节流；页面隐藏时跳过。注意：波形推送/节拍广播不受挂起影响——
        // 房主切去别的模式听歌时成员还在跟节奏，这是功能语义）
        if (!document.hidden && !parkedRef.current && Date.now() - lastUiLevelAt > 500) {
          lastUiLevelAt = Date.now()
          setLiveLevel({ left: frame.left, right: frame.right })
        }
      })
    }).catch(() => undefined)
    return () => { unsub?.() }
  }, [session, snapshot.live, snapshot.role])

  /* 房主：本机播放状态变化 → 广播同步听（切歌/暂停即时，进度 5s 一次） */
  useEffect(() => {
    if (!snapshot.live || snapshot.role !== 'host') return
    session.broadcastSyncPlayback(props.nowPlaying ? { ...props.nowPlaying, positionMs: 0 } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.live, snapshot.role, props.nowPlaying?.title, props.nowPlaying?.playing])

  /* 好友添加事件 → 本机存储 */
  useEffect(() => {
    const onFriend = (e: Event) => {
      const detail = (e as CustomEvent).detail as { peerId: string; nickname: string; avatarEmoji: string; avatarGradient: [string, string]; bio?: string }
      if (detail?.peerId) upsertFriend(detail, snapshot.roomName || snapshot.room?.roomId)
    }
    window.addEventListener('waveforge:inparty-friend-added', onFriend)
    return () => window.removeEventListener('waveforge:inparty-friend-added', onFriend)
  }, [snapshot.roomName, snapshot.room?.roomId])

  useEffect(() => {
    const sync = () => {
    setSettings(readInPartySettings())
    setPanicKeys(readPanicKeys())
  }
    window.addEventListener(INPARTY_SETTINGS_EVENT, sync)
    return () => window.removeEventListener(INPARTY_SETTINGS_EVENT, sync)
  }, [])

  const saveLocalPanicKeys = (keys: string[]) => { setPanicKeys(keys); savePanicKeys(keys) }

  const create = useCallback(async (options: { name: string; visibility: 'public' | 'private'; password: string }) => {
    setBusy(true)
    setError('')
    try {
      const profile = ensureLocalProfile()
      rememberPassword(options.password)
      await session.create({
        profile,
        name: options.name,
        policy: settings.controlPolicy,
        visibility: options.visibility,
        password: options.password,
        maxMembers: settings.maxMembers,
        port: settings.port,
        discoverable: settings.lanDiscovery,
      })
      rememberRecentRoom({ invite: session.getSnapshot().invite, name: options.name, visibility: options.visibility })
    } catch (createError) {
      const stack = createError instanceof Error && createError.stack ? createError.stack : String(createError)
      console.error('[In Party] 创建房间失败堆栈:', stack.slice(0, 600))
      setError(createError instanceof Error ? createError.message : '创建房间失败')
    } finally {
      setBusy(false)
    }
  }, [session, settings.controlPolicy, settings.lanDiscovery, settings.maxMembers, settings.port])

  const join = useCallback(async (invite: string, password: string, name?: string) => {
    setBusy(true)
    setError('')
    try {
      const profile = ensureLocalProfile()
      await session.join({ invite, password, profile, policy: settings.controlPolicy })
      rememberRecentRoom({ invite, name: name || '', visibility: password ? 'private' : 'public' })
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : '加入房间失败')
    } finally {
      setBusy(false)
    }
  }, [session, settings.controlPolicy])

  if (!noticeAccepted) {
    return (
      <Shell>
        <PartyNotice
          onAccept={remember => {
            if (remember) { try { localStorage.setItem(INPARTY_NOTICE_KEY, 'true') } catch { /* ignore */ } }
            setNoticeAccepted(true)
          }}
        />
      </Shell>
    )
  }

  const selfPeerId = session.getProfile()?.peerId || ''

  return (
    <Shell>
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        {/* 顶部居中的模式下拉（与其它模式一致） */}
        <div className="group absolute left-1/2 top-0 z-[95] h-10 w-40 -translate-x-1/2">
          <button
            type="button"
            aria-label="打开模式选择"
            onClick={() => setModePanelOpen(true)}
            className="flex h-8 w-[200px] translate-x-1/4 items-center justify-center rounded-b-2xl border border-t-0 border-white/10 bg-white/5 text-white/50 opacity-0 backdrop-blur-md transition-all hover:bg-white/15 group-hover:opacity-100"
            style={{ marginLeft: '12.5%' }}
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
            </svg>
          </button>
        </div>

        {(snapshot.status === 'joining' || snapshot.status === 'hosting') && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60">
            <div className="flex items-center gap-3 text-sm" style={{ color: GOLD }}>
              <Loader2 className="h-5 w-5 animate-spin" />
              {snapshot.status === 'hosting' ? '正在创建房间…' : '正在加入房间…'}
            </div>
          </div>
        )}

        {/* 头部（大厅才显示；房间有自己的顶栏） */}
        {!snapshot.room && (
          <header className="flex shrink-0 items-center gap-3 px-6 pb-1 pt-4">
            <img src="https://www.dungeon-lab.cn/img/logo-new.png" alt="" className="h-11 w-11 rounded-2xl bg-white/90 p-1" />
            <div>
              <h1 className="text-xl font-bold text-white">In Party</h1>
              <p className="text-xs" style={{ color: `${GOLD}99` }}>多人互控派对 · P2P 端到端加密 · 无服务器</p>
            </div>
            <span className="flex-1" />
            <button
              type="button" onClick={() => setFriendsOpen(true)}
              className="relative rounded-xl p-2 text-white/55 hover:bg-white/10" title="好友"
            >
              <UserPlus className="h-4.5 w-4.5" />
              {snapshot.friendRequests.length > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-400" />}
            </button>
            <button type="button" onClick={() => setAchievementsOpen(true)} className="rounded-xl p-2 text-white/55 hover:bg-white/10" title="成就">
              <Trophy className="h-4.5 w-4.5" />
            </button>
            <button type="button" onClick={() => setSettingsOpen(true)} className="rounded-xl p-2 text-white/55 hover:bg-white/10" title="设置">
              <Settings2 className="h-4.5 w-4.5" />
            </button>
          </header>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          <AnimatePresence mode="wait">
            {snapshot.room ? (
              <motion.div key="party-room" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex min-h-0 flex-1 flex-col">
                <Room
                  snapshot={snapshot}
                  selfPeerId={selfPeerId}
                  settings={settings}
                  onLeave={() => session.leave()}
                  onDissolve={() => session.dissolve()}
                  onKick={peerId => session.hostKick(peerId)}
                  onSetInterControl={enabled => session.setInterControl(enabled)}
                  onSendOp={(peerId, op) => {
                    if (op.kind === 'clear') session.sendControlOp(peerId, { kind: 'clear' })
                    else void session.sendControlOp(peerId, op)
                  }}
                  onRequestControl={peerId => session.requestControl(peerId)}
                  onOpenInvite={() => setInviteOpen(true)}
                  onQuickAction={(peerId, actionId, channel) => void session.quickAction(peerId, actionId, channel)}
                  onBindWave={(peerId, channel, on) => { if (on) void session.bindWave(peerId, channel); else session.unbindWave(peerId, channel) }}
                  onStartRoulette={target => void session.startRoulette(target)}
                  onRespondRoulette={accept => session.respondRoulette(accept)}
                  onSpinRoulette={() => void session.spinRoulette()}
                  onSetAnnouncement={text => session.setAnnouncement(text)}
                  onRecall={id => void session.recallMessage(id)}
                  onAddFriend={member => void session.sendFriendRequest(member.peerId)}
                  onAcceptFriend={peerId => session.respondFriendRequest(peerId, true)}
                  onDeclineFriend={peerId => session.respondFriendRequest(peerId, false)}
                  camera={camera}
                  voice={voice}
                  session={session}
                  sideTab={sideTab}
                  setSideTab={setSideTab}
                  nowPlaying={props.nowPlaying}
                  onGain={(peerId, channel, gain) => session.setWaveGain(peerId, channel, gain)}
                  liveLevel={liveLevel}
                  panicKeys={panicKeys}
                  onOpenFriends={() => setFriendsOpen(true)}
                  onOpenAchievements={() => setAchievementsOpen(true)}
                />
              </motion.div>
            ) : (
              <motion.div key="party-lobby" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex min-h-0 flex-1 flex-col">
                <Lobby
                  settings={settings}
                  busy={busy}
                  error={error || snapshot.error}
                  onCreate={options => void create(options)}
                  onJoin={(invite, password, name) => void join(invite, password, name)}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* 左下角：仅「返回上一模式」——顶部下拉与全局悬浮条已覆盖模式切换/回房，不再重复堆按钮 */}

      <AnimatePresence>
        {modePanelOpen && (
          <ModeSelectionPanel
            currentMode="inparty"
            onClose={() => setModePanelOpen(false)}
            onSelect={mode => { setModePanelOpen(false); if (mode !== 'inparty') onSelectMode(mode) }}
          />
        )}
        {settingsOpen && (
          <SettingsModal settings={settings} onClose={() => setSettingsOpen(false)} panicKeys={panicKeys} onSavePanicKeys={saveLocalPanicKeys} />
        )}
        {friendsOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[96] flex items-center justify-center p-6"
            style={{ backgroundColor: 'rgba(2,2,4,0.72)', backdropFilter: 'blur(10px)' }} onClick={() => setFriendsOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.94, y: 14, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.94, y: 14, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-3xl border p-5"
              style={{ background: 'linear-gradient(160deg,#12100a,#0b0b0e)', borderColor: BORDER }}
            >
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-base font-bold text-white"><UserPlus className="h-4.5 w-4.5" style={{ color: GOLD }} />好友</h2>
                <button type="button" onClick={() => setFriendsOpen(false)} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10"><X className="h-4 w-4" /></button>
              </div>
              <p className="mt-1 text-[10px] text-white/35">好友存在本机，跨房间累积；在线状态来自最近一次同房/心跳</p>
              <div className="mt-3">
                <FriendsPanel
                  requests={snapshot.friendRequests}
                  onAccept={peerId => session.respondFriendRequest(peerId, true)}
                  onDecline={peerId => session.respondFriendRequest(peerId, false)}
                  onRemove={() => undefined}
                  roomMembers={snapshot.room?.members ?? []}
                  onSendDM={(peerId, text) => session.sendFriendDM(peerId, text)}
                  sessionLive={snapshot.live}
                  onOpenDM={peerId => session.clearUnread(peerId)}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
        {achievementsOpen && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[96] flex items-center justify-center p-6"
            style={{ backgroundColor: 'rgba(2,2,4,0.72)', backdropFilter: 'blur(10px)' }} onClick={() => setAchievementsOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.94, y: 14, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.94, y: 14, opacity: 0 }}
              onClick={e => e.stopPropagation()}
              className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-3xl border p-5"
              style={{ background: 'linear-gradient(160deg,#12100a,#0b0b0e)', borderColor: BORDER }}
            >
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-base font-bold text-white"><Trophy className="h-4.5 w-4.5" style={{ color: GOLD }} />成就</h2>
                <button type="button" onClick={() => setAchievementsOpen(false)} className="rounded-lg p-1.5 text-white/45 hover:bg-white/10"><X className="h-4 w-4" /></button>
              </div>
              <div className="mt-3">
                <AchievementsPanel />
              </div>
            </motion.div>
          </motion.div>
        )}
        {inviteOpen && (
          <InviteModal snapshot={snapshot} onClose={() => setInviteOpen(false)} />
        )}
      </AnimatePresence>
    </Shell>
  )
}
