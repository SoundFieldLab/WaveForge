/**
 * 共振房间主体（重做版）：品牌头图 · 成员 · 当前曲目 · 队列 · 聊天 · 投票。
 *
 * 按用户反馈重做：
 * - 邀请不再常驻左栏，改成「邀请好友」按钮 → 弹窗（房间码 + 邀请串 + 二维码 + 指纹 + 复制）。
 * - 成员显示平台头像与平台昵称；「允许所有成员控制播放」用统一的分段/开关控件，不再是裸复选框。
 * - 背景可自定义（跟随封面 / 极光 / 浅色 / 自定义图片），见 ResonanceBackground。
 * - 提示一律非阻塞：顶部提示条 + 底部 toast；空状态给出下一步动作。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import {
  Check, Copy, Crown, Hourglass, Loader2, Lock, MessageSquare, Play, Radio, Send, SkipForward,
  Trash2, TriangleAlert, Users, Vote, VolumeX, WifiOff, X,
} from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import { platformLabel } from '../../services/platforms'
import { RESONANCE_MODE_LABEL, type ResonanceRoomState, type ResonanceTrack } from './model'
import type { ResonanceSessionSnapshot } from './session'
import type { ResonanceSettings } from './settings'

const ROW_HEIGHT = 64
const VISIBLE_ROWS = 8

export interface ResonanceRoomProps {
  playerTheme?: 'dark' | 'light'
  accent: string
  settings: ResonanceSettings
  snapshot: ResonanceSessionSnapshot
  selfPeerId: string
  /** 我还能加几首（Infinity = 不限） */
  remainingQuota: number
  onSendChat: (text: string) => void
  onVoteSkip: (target: string | null) => void
  onForceSkip: () => void
  onNext: () => void
  onRemoveTrack: (trackKey: string) => void
  onMoveToNext: (trackKey: string) => void
  onGrantControl: (peerId: string) => void
  onRevokeControl: () => void
  onRequestControl: () => void
  /** 房主：忽略某人的控制申请 */
  onDismissControlRequest: (peerId: string) => void
  onKick: (peerId: string) => void
  /** 切换「显示成员头像与平台昵称」（开关直接生效，不是打开设置） */
  onToggleAvatars: (enabled: boolean) => void
  /** 房主：把预排直接放进队列 */
  onPromotePending: (trackKey: string) => void
  /** 房主：丢掉一条预排 */
  onDismissPending: (trackKey: string) => void
  onToggleMemberControl: (enabled: boolean) => void
  onLoadMoreQueue: () => void
  onOpenAdd: () => void
  onLeave: () => void
  onDissolve: () => void
  playingLocal: boolean
  unplayableText: string | null
  arrivingHint: string | null
  nowPlaying: { title: string; artists: string; coverUrl: string; durationMs: number; positionMs: number } | null
}

const EMOJI = ['🎧', '🔥', '❤️', '😂', '👏', '🥲', '🌙', '🙌']

/** 预排队里「为什么还不能进队列」的说法 */
const PENDING_REASON_TEXT: Record<string, string> = {
  quota: '额度用完，等下一轮/房主放开',
  turn: '还没轮到他推荐',
  mode: '这个模式下成员不能直接推歌，等房主放行',
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default function ResonanceRoom(props: ResonanceRoomProps) {
  const {
    playerTheme = 'dark', accent, settings, snapshot, selfPeerId, remainingQuota, onSendChat, onVoteSkip,
    onForceSkip, onNext, onRemoveTrack, onMoveToNext, onGrantControl, onRevokeControl, onRequestControl, onDismissControlRequest,
    onKick, onToggleAvatars, onPromotePending, onDismissPending, onToggleMemberControl, onLoadMoreQueue, onOpenAdd, onLeave, onDissolve,
    playingLocal, unplayableText, arrivingHint, nowPlaying,
  } = props
  const dark = playerTheme === 'dark'
  const room = snapshot.room
  const [chatInput, setChatInput] = useState('')
  const [queueScroll, setQueueScroll] = useState(0)
  /** 队列滚动容器的高度：窗口高度决定渲染多少行（写死行数会让高窗口的尾部永远滚不到） */
  const [queueViewportHeight, setQueueViewportHeight] = useState(VISIBLE_ROWS * ROW_HEIGHT)
  const queueScrollRef = useRef<HTMLDivElement>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [copied, setCopied] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)

  const border = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const panel = dark ? 'rgba(18,21,29,0.62)' : 'rgba(255,255,255,0.72)'
  const sub = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
  const chip = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)'
  const isHost = room?.hostId === selfPeerId
  const selfMember = room?.members.find(member => member.peerId === selfPeerId) || null

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'end' }) }, [snapshot.chat.length])

  // 观察队列可视区高度：窗口化必须按「实际能显示多少行」渲染，
  // 固定 12 行时，可视区高于 12 行的窗口底部永远是一片空白（最后几行在任何滚动位置都取不到）。
  useEffect(() => {
    const element = queueScrollRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const apply = () => {
      const height = element.clientHeight
      if (height > 0) setQueueViewportHeight(height)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    return () => observer.disconnect()
  }, [room])

  const members = useMemo(() => [...(room?.members || [])].sort((left, right) => left.seat - right.seat), [room?.members])
  const queue = snapshot.queue.items
  // 成员侧队列是「从房主当前曲目起的窗口」，全局起点是 queue.offset（房主可能已经播到第 N 首）；
  // 已载入条数要按全局算，否则滚动加载会在窗口偏移非 0 的房间里重复拉同一段。
  const loadedCount = Math.max(0, (snapshot.queue.offset || 0) + queue.length)
  const voteTarget = room?.vote?.target ?? null
  const voteCount = room?.vote?.by.length ?? 0
  const threshold = Math.max(1, Math.ceil((snapshot.summary?.online || 1) * 0.8))
  /**
   * 投票按钮的目标：已经有投票在进行时**加入它**，而不是另起一个。
   * `castSkipVote` 在 target 不同时会丢弃已有的票重新计数，所以通用按钮若恒传 null，
   * 别人发起的定向投票会被第二个人一点就清零。
   */
  const joinOrStartVote = useCallback(() => onVoteSkip(voteTarget), [onVoteSkip, voteTarget])

  const onQueueScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setQueueScroll(element.scrollTop)
    const nearEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - ROW_HEIGHT * 2
    if (nearEnd && loadedCount < (snapshot.queue.total || 0)) onLoadMoreQueue()
  }, [onLoadMoreQueue, loadedCount, snapshot.queue.total])

  const copy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard?.writeText(text)
      setCopied(label)
      window.setTimeout(() => setCopied(''), 1600)
    } catch {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '复制失败，请手动选中复制', type: 'error' } }))
    }
  }, [])

  // 窗口化：按可视区实际高度算出要渲染多少行，上下各多留 OVERSCAN 行做缓冲。
  // 固定行数（原来是写死的 12 行）在 1440p 等大窗口下会让列表尾部永远滚不到。
  const OVERSCAN_ROWS = 2
  const visibleRowCount = Math.max(VISIBLE_ROWS, Math.ceil(queueViewportHeight / ROW_HEIGHT) + OVERSCAN_ROWS * 2)
  const firstRow = Math.max(0, Math.floor(queueScroll / ROW_HEIGHT) - OVERSCAN_ROWS)
  const visibleTracks = queue.slice(firstRow, firstRow + visibleRowCount)

  if (!room) return null
  const roomCode = snapshot.invite.match(/#(\d{6})\./)?.[1] || '——'

  return (
    <div className="grid h-full min-h-0 gap-4 overflow-hidden px-5 pb-16 pt-4 lg:grid-cols-[300px_minmax(0,1fr)_380px]">
      {/* ── 成员 ── */}
      <section className="flex min-h-0 flex-col rounded-[20px] border p-4" style={{ borderColor: border, background: panel, backdropFilter: 'blur(18px)' }} data-tv-scope>
        <header className="mb-3 flex items-center gap-2">
          <Users className="h-4 w-4" style={{ color: accent }} />
          <h2 className="text-sm font-semibold">一起听的人</h2>
          <span className="ml-auto text-xs" style={{ color: sub }}>{snapshot.summary?.online ?? members.length}/{members.length} 在线</span>
        </header>
        <div className="wf-no-scrollbar min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {members.map(member => {
            const isSelf = member.peerId === selfPeerId
            const isHostMember = member.peerId === room.hostId
            const controlling = room.controllerId === member.peerId && room.controllerUntil > Date.now()
            return (
              <div key={member.peerId} className="group flex items-center gap-2.5 rounded-2xl px-2 py-2 transition" style={{ background: isSelf ? `${accent}1a` : 'transparent' }} data-member-peer={member.peerId}>
                <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full" style={{ background: chip }}>
                  {settings.showAvatars && member.avatarUrl
                    ? <CachedImage src={member.avatarUrl} alt="" className="h-full w-full object-cover" role="compact" />
                    : <span className="flex h-full w-full items-center justify-center text-xs" style={{ color: sub }}>{member.nickname.slice(0, 1)}</span>}
                  {!member.online && <span className="absolute inset-0 flex items-center justify-center bg-black/55"><WifiOff className="h-3.5 w-3.5 text-white/70" /></span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[15px] font-medium">{member.nickname}{isSelf ? '（我）' : ''}</span>
                    {isHostMember && <Crown className="h-3.5 w-3.5 shrink-0" style={{ color: '#ffc85a' }} aria-label="房主" />}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px]">
                    <span className="rounded-full px-1.5 py-0.5" style={{ background: chip, color: sub }}>席位 {member.seat}</span>
                    {settings.showAvatars && member.nicknameFrom && <span className="rounded-full px-1.5 py-0.5" style={{ background: chip, color: sub }}>{platformLabel(member.nicknameFrom)}</span>}
                    {controlling && <span className="rounded-full px-1.5 py-0.5" style={{ background: 'rgba(255,200,90,0.2)', color: '#ffd98a' }}>控制中</span>}
                    {member.nicknameConflict && <span className="rounded-full px-1.5 py-0.5" style={{ background: 'rgba(255,150,80,0.22)', color: '#ffcf9a' }} title="和房间里另一个成员重名">重名</span>}
                    {member.unableToPlay && <span className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5" style={{ background: 'rgba(255,150,80,0.2)', color: '#ffcf9a' }}><TriangleAlert className="h-2.5 w-2.5" />这首播不了</span>}
                  </span>
                </span>
                {isHost && !isSelf && (
                  // 用「透明 + hover/focus 显示」而不是 hidden：display:none 会让按钮不可聚焦，
                  // 键盘与 TV 遥控器就永远点不到「授权 / 移出」。[@media(hover:none)] 让无鼠标设备直接常显。
                  <span className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                    <button type="button" onClick={() => onGrantControl(member.peerId)} className="rounded-lg px-1.5 py-1 text-xs" style={{ background: chip }} title="允许他控制播放 5 分钟">授权</button>
                    <button type="button" onClick={() => onKick(member.peerId)} className="rounded-lg px-1.5 py-1 text-xs" style={{ background: 'rgba(255,150,80,0.2)' }} title="移出房间">移出</button>
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-3 space-y-2 border-t pt-3 text-xs" style={{ borderColor: border, color: sub }}>
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="flex w-full items-center justify-center gap-2 rounded-2xl py-2.5 text-xs font-medium text-white"
            style={{ background: accent }}
          >
            <Radio className="h-3.5 w-3.5" />邀请好友
          </button>
          <div className="flex items-center justify-between">
            <span>成员头像与平台昵称</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.showAvatars}
              aria-label="显示成员头像与平台昵称"
              onClick={() => onToggleAvatars(!settings.showAvatars)}
              className="relative h-5 w-9 rounded-full transition"
              style={{ background: settings.showAvatars ? accent : chip }}
            >
              <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all" style={{ left: settings.showAvatars ? 18 : 2 }} />
            </button>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={room.memberControl}
            aria-label="允许所有成员控制播放"
            disabled={!isHost}
            onClick={() => onToggleMemberControl(!room.memberControl)}
            className="flex w-full items-center justify-between rounded-xl px-2 py-1.5 disabled:opacity-60"
            style={{ background: chip }}
          >
            <span>允许所有成员控制播放</span>
            <span className="relative h-5 w-9 shrink-0 rounded-full transition" style={{ background: room.memberControl ? accent : (dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)') }}>
              <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all" style={{ left: room.memberControl ? 18 : 2 }} />
            </span>
          </button>
          {room.controllerId && (
            <div className="flex items-center justify-between px-2">
              <span>已授权控制</span>
              <span className="flex items-center gap-2">
                {room.members.find(item => item.peerId === room.controllerId)?.nickname || '成员'}
                {isHost && <button type="button" onClick={onRevokeControl} className="underline">收回</button>}
              </span>
            </div>
          )}
          {/* 房主：有人申请控制播放 → 一键允许（此前申请只进状态、界面上没有任何出口） */}
          {isHost && snapshot.controlRequests.length > 0 && (
            <div className="space-y-1.5 rounded-xl px-2 py-2" style={{ background: 'rgba(255,200,90,0.14)' }}>
              <div className="text-[11px] font-medium" style={{ color: '#ffd98a' }}>有人申请控制播放</div>
              {snapshot.controlRequests.map(requestPeerId => (
                <div key={requestPeerId} className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs">{room.members.find(item => item.peerId === requestPeerId)?.nickname || '成员'}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button type="button" onClick={() => onGrantControl(requestPeerId)} className="rounded-lg px-1.5 py-1 text-xs text-white" style={{ background: accent }} title="允许他控制播放 5 分钟">允许 5 分钟</button>
                    <button type="button" onClick={() => onDismissControlRequest(requestPeerId)} className="rounded-lg px-1.5 py-1 text-xs" style={{ background: chip }} title="忽略这条申请">忽略</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── 当前曲目 + 队列 ── */}
      <section className="flex min-h-0 flex-col gap-4">
        <div className="rounded-[20px] border p-4" style={{ borderColor: border, background: panel, backdropFilter: 'blur(18px)' }}>
          <header className="mb-3 flex flex-wrap items-center gap-2">
            <span className="rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ background: `${accent}22`, color: accent }}>{RESONANCE_MODE_LABEL[room.mode]}</span>
            <span className="text-xs" style={{ color: sub }}>
              {room.mode === 'round-robin'
                ? snapshot.myTurn ? `轮到你推荐（还可加 ${Math.max(0, Math.floor(remainingQuota))} 首）` : '等待其他人推荐'
                : room.mode === 'shared-playlist' ? '房主的歌单' : `任何人可加（你还能加 ${Math.max(0, Math.floor(remainingQuota))} 首）`}
            </span>
            <span className="ml-auto text-xs" style={{ color: sub }}>在线 {snapshot.summary?.online ?? members.length} · 队列 {snapshot.queue.total} 首</span>
          </header>

          <div className="flex gap-4">
            <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl shadow-lg" style={{ background: chip }}>
              {nowPlaying?.coverUrl
                ? <CachedImage src={nowPlaying.coverUrl} alt="" platform="netease" retainPrevious className="h-full w-full object-cover" role="card" priority="visible" />
                : <span className="flex h-full w-full items-center justify-center" style={{ color: sub }}><Radio className="h-7 w-7" /></span>}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-xl font-semibold">{nowPlaying?.title || '等待房主开始播放'}</h3>
              <p className="mt-0.5 truncate text-xs" style={{ color: sub }}>{nowPlaying?.artists || '——'}</p>

              {arrivingHint && <p className="mt-2 flex items-center gap-1.5 text-xs" style={{ color: '#a9d8ff' }}><Loader2 className="h-3.5 w-3.5 animate-spin" />{arrivingHint}</p>}
              {/* 房主把共振挂起了（切去别的模式听自己的歌）：成员不用干等 */}
              {room.suspended && (
                <p className="mt-2 flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs" style={{ background: 'rgba(255,200,90,0.14)', color: '#ffd98a' }}>
                  <Hourglass className="h-3.5 w-3.5" />房主暂时挂起了共振（房间还在，随时可以推歌回来）
                </p>
              )}
              {/* 自定义用户名撞车：后进来的人自己会看到，别人也能一眼认出 */}
              {selfMember?.nicknameConflict && (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs" style={{ background: 'rgba(255,150,80,0.16)', color: '#ffcf9a' }}>
                  <TriangleAlert className="h-3.5 w-3.5" />你的名字和房间里已有的人重名，建议在共振设置里改一个
                </p>
              )}
              {!playingLocal && nowPlaying && (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs" style={{ background: 'rgba(255,150,80,0.16)', color: '#ffcf9a' }}>
                  <VolumeX className="h-3.5 w-3.5" />已静音跟随{unplayableText ? ` · ${unplayableText}` : ''}
                  <button type="button" onClick={joinOrStartVote} className="underline">发起跳过投票</button>
                </p>
              )}

              {nowPlaying && (
                <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: sub }}>
                  <span>{formatClock(nowPlaying.positionMs)}</span>
                  <span className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: chip }}>
                    <span className="block h-full rounded-full" style={{ width: `${nowPlaying.durationMs ? Math.min(100, (nowPlaying.positionMs / nowPlaying.durationMs) * 100) : 0}%`, background: accent }} />
                  </span>
                  <span>{formatClock(nowPlaying.durationMs)}</span>
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" onClick={joinOrStartVote} className="flex h-9 items-center gap-1.5 rounded-full px-3 text-xs" style={{ background: chip }} title="跳过此曲（当前在线人数 8 成同意）" aria-label="跳过此曲">
                  <Vote className="h-3.5 w-3.5" />投票跳过
                </button>
                {snapshot.canControl ? (
                  <>
                    <button type="button" onClick={onNext} className="flex h-9 items-center gap-1.5 rounded-full px-3 text-xs" style={{ background: chip }} aria-label="下一首"><SkipForward className="h-3.5 w-3.5" />下一首</button>
                    {isHost && <button type="button" onClick={onForceSkip} className="h-9 rounded-full px-3 text-xs" style={{ background: 'rgba(255,200,90,0.2)', color: '#ffd98a' }}>强制跳过</button>}
                  </>
                ) : (
                  <button type="button" onClick={onRequestControl} className="flex h-9 items-center gap-1.5 rounded-full px-3 text-xs" style={{ background: chip }} title="请求房主把控制权交给你 5 分钟">
                    <Lock className="h-3.5 w-3.5" />申请控制
                  </button>
                )}
              </div>
            </div>
          </div>

          {voteCount > 0 && (
            <div className="mt-3 flex items-center gap-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'rgba(255,200,90,0.16)' }} aria-live="polite">
              <Vote className="h-3.5 w-3.5" />
              跳过投票 {voteCount}/{threshold}（在线人数的 8 成）
              <button type="button" onClick={() => onVoteSkip(voteTarget)} className="ml-auto underline">我也同意</button>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col rounded-[20px] border p-5" style={{ borderColor: border, background: panel, backdropFilter: 'blur(18px)' }}>
          <header className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-semibold">播放队列</h3>
            <span className="text-xs" style={{ color: sub }}>{snapshot.queue.total} 首{loadedCount < snapshot.queue.total ? `（已载入 ${loadedCount}）` : ''}</span>
            {(isHost || room.mode !== 'shared-playlist') && (
              <button
                type="button"
                onClick={onOpenAdd}
                disabled={room.mode === 'round-robin' && !snapshot.myTurn}
                className="ml-auto flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium text-white disabled:opacity-45"
                style={{ background: accent }}
                title={room.mode === 'round-robin' && !snapshot.myTurn ? '还没轮到你推荐' : '挑歌加入'}
              >
                ＋ 加歌
              </button>
            )}
          </header>
          {Number.isFinite(remainingQuota) && room.mode !== 'shared-playlist' && (
            <p className="mb-2 text-xs" style={{ color: sub }}>你的加歌额度：还能加 {Math.max(0, Math.floor(remainingQuota))} 首（房主设定）</p>
          )}
          {/* 预排队：房间保留但还没资格进队列的曲目（右键「推送至共振」时常见） */}
          {room.pending.length > 0 && (
            <div className="mb-2 rounded-2xl p-2.5" style={{ background: 'rgba(255,200,90,0.10)' }}>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs" style={{ color: '#ffd98a' }}>
                <Hourglass className="h-3 w-3" />预排队 {room.pending.length} 首
                <span style={{ color: sub }}>· 还没进播放顺序，等资格放开或房主放行</span>
              </div>
              <div className="space-y-1">
                {room.pending.map(track => {
                  const requester = room.members.find(member => member.peerId === track.requestedBy)
                  return (
                    <div key={track.key} className="flex items-center gap-2 rounded-xl px-2 py-1.5" style={{ background: 'rgba(0,0,0,0.18)' }} data-pending-key={track.key}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs">{track.title}</span>
                        <span className="block truncate text-[11px]" style={{ color: sub }}>
                          {(track.artists || []).join(' / ')} · {requester?.nickname || '成员'} · {PENDING_REASON_TEXT[track.pendingReason]}
                        </span>
                      </span>
                      {isHost && (
                        <span className="flex shrink-0 items-center gap-1">
                          <button type="button" onClick={() => onPromotePending(track.key)} className="rounded-lg px-1.5 py-1 text-xs" style={{ background: chip, color: accent }} title="不等资格了，直接放进队列">加入队列</button>
                          <button type="button" onClick={() => onDismissPending(track.key)} className="rounded-lg px-1.5 py-1 text-xs" style={{ background: 'rgba(255,150,80,0.2)' }} title="丢掉这条预排">忽略</button>
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          <div ref={queueScrollRef} className="wf-no-scrollbar min-h-0 flex-1 overflow-y-auto pr-1" onScroll={onQueueScroll} data-queue-scroll>
            {queue.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
                <Radio className="h-8 w-8" style={{ color: sub }} />
                <p className="text-xs" style={{ color: sub }}>队列还是空的{isHost ? '，点右上角「＋ 加歌」开始' : '，等房主或成员加歌'}</p>
              </div>
            ) : (
              <div style={{ height: queue.length * ROW_HEIGHT, position: 'relative' }}>
                <div style={{ transform: `translateY(${firstRow * ROW_HEIGHT}px)` }}>
                  {visibleTracks.map((item, index) => {
                    const absoluteIndex = firstRow + index
                    // 行号按**全局队列位置**显示（窗口起点是房主当前曲目，不是队列头部）
                    const globalIndex = (snapshot.queue.offset || 0) + absoluteIndex
                    const isCurrent = room.playback?.trackKey === item.key
                    const requester = room.members.find(member => member.peerId === item.requestedBy)
                    const canRemove = isHost || item.requestedBy === selfPeerId
                    return (
                      <QueueRow
                        key={`${item.key}-${absoluteIndex}`}
                        index={globalIndex + 1}
                        track={item}
                        current={isCurrent}
                        requesterName={requester?.nickname || ''}
                        canRemove={canRemove}
                        accent={accent}
                        border={border}
                        sub={sub}
                        chip={chip}
                        onRemove={() => onRemoveTrack(item.key)}
                        onMoveNext={() => onMoveToNext(item.key)}
                      />
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── 聊天 ── */}
      <section className="flex min-h-0 flex-col rounded-[20px] border p-4" style={{ borderColor: border, background: panel, backdropFilter: 'blur(18px)' }} data-tv-scope>
        <header className="mb-3 flex items-center gap-2">
          <MessageSquare className="h-4 w-4" style={{ color: '#7cc4ff' }} />
          <h2 className="text-sm font-semibold">房间聊天</h2>
          <span className="ml-auto text-xs" style={{ color: sub }}>端到端加密</span>
        </header>
        <div className="wf-no-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1" aria-live="polite">
          {snapshot.chat.length === 0 && <p className="py-8 text-center text-xs" style={{ color: sub }}>还没有人说话</p>}
          {snapshot.chat.map(message => (
            <div key={message.id} className="flex items-start gap-2 text-xs">
              <span className="mt-0.5 h-6 w-6 shrink-0 overflow-hidden rounded-full" style={{ background: chip }}>
                <span className="flex h-full w-full items-center justify-center text-[11px]" style={{ color: sub }}>{message.nickname.slice(0, 1)}</span>
              </span>
              <span className="min-w-0">
                <span className="font-medium" style={{ color: message.self ? accent : (dark ? 'rgba(255,255,255,0.78)' : 'rgba(0,0,0,0.72)') }}>{message.nickname}</span>
                <span className="ml-2 break-words" style={{ color: dark ? 'rgba(255,255,255,0.64)' : 'rgba(0,0,0,0.62)' }}>{message.text}</span>
              </span>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {EMOJI.map(emoji => (
            <button key={emoji} type="button" onClick={() => onSendChat(emoji)} className="rounded-lg px-1.5 py-1 text-sm transition hover:scale-105" style={{ background: chip }} aria-label={`发送表情 ${emoji}`}>{emoji}</button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={chatInput}
            onChange={event => setChatInput(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              const text = chatInput.trim()
              if (!text) return
              onSendChat(text)
              setChatInput('')
            }}
            placeholder="说点什么…（Enter 发送）"
            maxLength={200}
            className="h-9 min-w-0 flex-1 rounded-2xl border bg-transparent px-3 text-xs outline-none"
            style={{ borderColor: border }}
            aria-label="聊天输入"
          />
          <button
            type="button"
            onClick={() => { const text = chatInput.trim(); if (!text) return; onSendChat(text); setChatInput('') }}
            className="flex h-9 w-9 items-center justify-center rounded-2xl text-white"
            style={{ background: accent }}
            aria-label="发送"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </section>

      <AnimatePresence>
        {inviteOpen && (
          <InviteModal
            dark={dark}
            accent={accent}
            invite={snapshot.invite}
            roomCode={roomCode}
            fingerprint={snapshot.fingerprint}
            memberCount={room.members.length}
            maxMembers={room.maxMembers}
            copied={copied}
            onCopy={copy}
            onClose={() => setInviteOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function InviteModal(props: {
  dark: boolean
  accent: string
  invite: string
  roomCode: string
  fingerprint: string
  memberCount: number
  maxMembers: number
  copied: string
  onCopy: (text: string, label: string) => void
  onClose: () => void
}) {
  const { dark, accent, invite, roomCode, fingerprint, memberCount, maxMembers, copied, onCopy, onClose } = props
  const border = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const sub = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
  const chip = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 z-[75] flex items-center justify-center p-6"
      style={{ background: 'rgba(3,5,9,0.72)', backdropFilter: 'blur(14px)' }}
      onClick={onClose}
      data-tv-scope
      role="dialog"
      aria-modal="true"
      aria-label="邀请好友"
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        className="w-full max-w-md overflow-hidden rounded-[22px] border p-5"
        style={{ borderColor: border, background: dark ? 'linear-gradient(155deg, rgba(20,24,34,0.99), rgba(9,12,18,0.99))' : '#fff', color: dark ? '#fff' : '#101318' }}
        onClick={event => event.stopPropagation()}
      >
        <header className="mb-4 flex items-center gap-2">
          <img src="/resonance-logo.svg" alt="" className="h-8 w-8 rounded-xl" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold">邀请好友一起听</h2>
            <p className="text-xs" style={{ color: sub }}>{memberCount}/{maxMembers} 人 · 把邀请串发给朋友即可</p>
          </div>
          <button type="button" onClick={onClose} className="ml-auto rounded-lg p-1.5" style={{ background: chip }} aria-label="关闭"><X className="h-4 w-4" /></button>
        </header>

        <div className="mb-4 flex items-center gap-3">
          <div className="rounded-2xl bg-white p-2">
            <QRCodeSVG value={invite || 'wf-resonance://'} size={112} bgColor="#ffffff" fgColor="#0b0d12" level="M" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-xs" style={{ color: sub }}>房间码</div>
            <div className="mb-2 font-mono text-2xl font-semibold tracking-[0.2em]" style={{ color: accent }}>{roomCode}</div>
            <div className="text-xs" style={{ color: sub }}>朋友扫码，或把下面的邀请串发给他</div>
          </div>
        </div>

        <textarea
          readOnly
          value={invite}
          onFocus={event => event.currentTarget.select()}
          rows={3}
          className="w-full resize-none rounded-2xl border bg-transparent px-3 py-2 font-mono text-[11px] leading-relaxed outline-none"
          style={{ borderColor: border }}
          aria-label="房间邀请串"
        />
        <button
          type="button"
          onClick={() => onCopy(invite, '邀请串')}
          className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-full text-sm font-medium text-white"
          style={{ background: accent }}
        >
          {copied === '邀请串' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied === '邀请串' ? '已复制' : '复制邀请串'}
        </button>

        <div className="mt-3 flex items-center justify-between rounded-xl px-3 py-2 text-xs" style={{ background: chip, color: sub }}>
          <span>房间指纹（当面核对，防中间人）</span>
          <span className="font-medium" style={{ color: dark ? '#fff' : '#101318' }}>{fingerprint || '——'}</span>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: sub }}>
          邀请串里含房间密钥种子：端到端加密，中转只看到密文。请只发给要一起听的朋友。
        </p>
      </motion.div>
    </motion.div>
  )
}

function QueueRow(props: {
  index: number
  track: ResonanceTrack
  current: boolean
  requesterName: string
  canRemove: boolean
  accent: string
  border: string
  sub: string
  chip: string
  onRemove: () => void
  onMoveNext: () => void
}) {
  const { index, track, current, requesterName, canRemove, accent, border, sub, chip, onRemove, onMoveNext } = props
  return (
    <div
      className="group flex items-center gap-3 border-b px-1"
      style={{ height: ROW_HEIGHT, borderColor: border, background: current ? `${accent}1a` : 'transparent' }}
      data-track-key={track.key}
    >
      <span className="w-7 shrink-0 text-center text-sm" style={{ color: sub }}>{current ? <Play className="mx-auto h-3.5 w-3.5" style={{ color: accent }} /> : index}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]">{track.title}</span>
        <span className="block truncate text-[13px]" style={{ color: sub }}>
          {(track.artists || []).join(' / ')}{requesterName ? ` · 来自 ${requesterName}` : ''}
        </span>
      </span>
      {/* 透明而非 hidden：display:none 不可聚焦，键盘/TV 就点不到行操作（见上方成员行的同款处理） */}
      <span className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <button type="button" onClick={onMoveNext} className="rounded-lg px-1.5 py-1" style={{ background: chip }} title="下一首播放" aria-label="下一首播放"><SkipForward className="h-3.5 w-3.5 rotate-[-90deg]" /></button>
        {canRemove && <button type="button" onClick={onRemove} className="rounded-lg px-1.5 py-1" style={{ background: 'rgba(255,150,80,0.18)' }} title="从队列移除" aria-label="从队列移除"><Trash2 className="h-3.5 w-3.5" /></button>}
      </span>
    </div>
  )
}
