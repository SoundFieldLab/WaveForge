/**
 * 共振模式根：免责声明闸门 → 大厅 / 房间（含自定义背景）。
 * 数据与权威都在 session（单例）里；本组件负责装配、身份（平台昵称/头像）与交互编排。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Loader2, Settings2, ArrowLeft } from 'lucide-react'
import type { MusicPlatform } from '../../services/platforms'
import type { Song } from '../../services/musicApi'
import ModeSelectionPanel from '../../components/ModeSelectionPanel'
import { remainingAddQuota, type ResonancePlatformBadge, type ResonanceTrack } from './model'
import { getResonanceSession, type ResonancePlaybackAdapter, type ResonanceSessionSnapshot } from './session'
import { unplayableText, type ResonanceLocalTrack } from './matcher'
import { readResonanceSettings, RESONANCE_SETTINGS_EVENT, setResonanceSetting, type ResonanceSettings } from './settings'
import ResonanceNotice, { acknowledgeNoticeForever, hasAcknowledgedNotice } from './ResonanceNotice'
import ResonanceBackground from './ResonanceBackground'
import ResonanceLobby, { type ResonanceIdentityOption } from './ResonanceLobby'
import ResonanceRoom from './ResonanceRoom'
import ResonanceAddPanel from './ResonanceAddPanel'
import ResonanceSettingsModal from './ResonanceSettingsModal'

export interface ResonanceViewProps {
  playerTheme?: 'dark' | 'light'
  /** 本机平台徽章（已登录 + 会员档） */
  platforms: ResonancePlatformBadge[]
  /** 各平台的昵称与头像：房间身份默认取平台昵称，而不是让用户现编 */
  identityCandidates: Array<{ platform: MusicPlatform; nickname: string; avatarUrl: string }>
  userIds: Partial<Record<MusicPlatform, string>>
  usernames: Partial<Record<MusicPlatform, string>>
  createAdapter: (hooks: { onUnplayable: (track: ResonanceTrack, result: ResonanceLocalTrack) => void }) => ResonancePlaybackAdapter
  resolveTrack: (track: ResonanceTrack) => Promise<ResonanceLocalTrack>
  nowPlaying: { song: Song | null; positionMs: number; playing: boolean } | null
  /** 切成别的模式（交给 App 的拦截器：房间在时会先问「挂起 / 退出」） */
  onSelectMode: (mode: 'explore' | 'minimal' | 'traditional' | 'desktop' | 'resonance') => void
}

/** 各模式的显示名（「返回 X」按钮用） */
const MODE_LABEL: Record<string, string> = {
  explore: '探索',
  minimal: '简约',
  traditional: '传统',
  desktop: '桌面',
}

function modeLabel(mode: string): string {
  return MODE_LABEL[mode] || '探索'
}

/** 进入共振前的模式：左下的「返回 X」按钮回到它（没记过就回探索） */
function readEntryMode(): string {
  try {
    const value = localStorage.getItem('waveforge:resonance-entry-mode') || ''
    return MODE_LABEL[value] ? value : 'explore'
  } catch {
    return 'explore'
  }
}

function useSessionSnapshot(): ResonanceSessionSnapshot {
  const session = getResonanceSession()
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
}

export default function ResonanceView(props: ResonanceViewProps) {
  const {
    playerTheme = 'dark', platforms, identityCandidates, userIds, usernames,
    createAdapter, resolveTrack, nowPlaying, onSelectMode,
  } = props
  const session = getResonanceSession()
  const snapshot = useSessionSnapshot()
  const [settings, setSettings] = useState<ResonanceSettings>(() => readResonanceSettings())
  const [noticeAccepted, setNoticeAccepted] = useState(() => hasAcknowledgedNotice())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modePanelOpen, setModePanelOpen] = useState(false)
  const [modeTriggerHovered, setModeTriggerHovered] = useState(false)
  // 进入共振前的模式（左下「返回 X」用它，不是写死的「返回探索」）
  const entryMode = useMemo(() => readEntryMode(), [modePanelOpen])
  const [unplayableByKey, setUnplayableByKey] = useState<Record<string, string>>({})
  const [arrivingHint, setArrivingHint] = useState<string | null>(null)
  const adapterRef = useRef<ResonancePlaybackAdapter | null>(null)
  const peerIdRef = useRef(globalThis.crypto.randomUUID())
  const joinedAtRef = useRef(Date.now())

  useEffect(() => {
    const sync = () => setSettings(readResonanceSettings())
    window.addEventListener(RESONANCE_SETTINGS_EVENT, sync)
    return () => window.removeEventListener(RESONANCE_SETTINGS_EVENT, sync)
  }, [])

  useEffect(() => {
    const adapter = createAdapter({
      onUnplayable: (track, result) => {
        setUnplayableByKey(previous => ({ ...previous, [track.key]: unplayableText(result) }))
        if (result.reason === 'no-platform') session.notifyUnplayable(track.key, 'no-platform', unplayableText(result))
      },
    })
    adapterRef.current = adapter
    session.setAdapter(adapter)
    return () => {
      session.setAdapter(null)
      adapterRef.current = null
    }
  }, [createAdapter, session])

  useEffect(() => {
    if (snapshot.role !== 'member' || !snapshot.live || !snapshot.room?.playback?.playing) {
      setArrivingHint(null)
      return
    }
    const trackKey = snapshot.room.playback.trackKey
    const track = snapshot.queue.items.find(item => item.key === trackKey)
    if (!track) return
    setArrivingHint(`正在续接《${track.title}》`)
    const timer = window.setTimeout(() => setArrivingHint(null), 2500)
    return () => window.clearTimeout(timer)
  }, [snapshot.live, snapshot.queue.items, snapshot.role, snapshot.room?.playback?.playing, snapshot.room?.playback?.trackKey])

  /** 身份候选：平台昵称（已登录才有）+ 自定义；默认取平台昵称 */
  const identityOptions = useMemo<ResonanceIdentityOption[]>(() => {
    const options: ResonanceIdentityOption[] = identityCandidates
      .filter(candidate => candidate.nickname)
      .map(candidate => ({
        key: candidate.platform,
        label: candidate.platform,
        nickname: candidate.nickname,
        avatarUrl: candidate.avatarUrl,
        platform: candidate.platform,
      }))
    // 自定义昵称未填时不回落成「听众」：留空才会让创建/加入按钮拦住，逼用户填一个
    options.push({ key: 'custom', label: '自定义', nickname: settings.nickname.trim(), avatarUrl: '' })
    return options
  }, [identityCandidates, settings.nickname])

  const activeIdentity = (() => {
    const bySource = identityOptions.find(option => option.key === settings.nicknameSource)
    if (bySource) return bySource
    // 选中的平台当前不可用（没登录/没昵称）时退回自定义，而不是悄悄换成别的平台：
    // 换成列表里第一个平台会让用户以为「点了它自己跳回网易云」。
    return identityOptions.find(option => option.key === 'custom')
      || identityOptions.find(option => option.key !== 'custom')
      || identityOptions[identityOptions.length - 1]
  })()

  /** 身份可用性：平台身份要有昵称；自定义身份必须自己填 */
  const identityReady = Boolean(
    activeIdentity && (activeIdentity.key === 'custom' ? activeIdentity.nickname.trim() : activeIdentity.nickname.trim()),
  )

  const identity = useMemo(() => ({
    peerId: session.getIdentity()?.peerId || peerIdRef.current,
    // 名字为空时不要伪造一个「听众」混进房间：这里保留空串，由 identityReady 拦住创建/加入
    nickname: (activeIdentity?.nickname || '').slice(0, 16),
    avatarUrl: settings.showAvatars ? activeIdentity?.avatarUrl || '' : '',
    nicknameFrom: activeIdentity?.platform,
    // 平台徽章：关掉后就上报空数组；同时只上报用户在「可用于房间身份」里打开的平台
    platforms: settings.showBadges ? platforms : [],
    // 入房时间取一次并固定：每次渲染都取 Date.now() 会让 identity 永远「变了」，把改名广播变成刷屏
    joinedAt: joinedAtRef.current,
  }), [activeIdentity, session, settings.showAvatars, settings.showBadges, platforms])

  // 房间里换昵称/头像/平台徽章：同步给其他人（席位不变，不是重新入房）
  useEffect(() => { session.setIdentity(identity) }, [identity, session])

  const create = useCallback(async (options: { mode: ResonanceSettings['defaultMode']; quota: number; partyQuota: number }) => {
    if (!identityReady) { setError('房间里显示为「自定义」时必须先填一个用户名'); return }
    setBusy(true)
    setError('')
    try {
      const roomId = globalThis.crypto.randomUUID().slice(0, 8)
      await session.create({
        roomId,
        nickname: identity.nickname,
        platforms: settings.showBadges ? platforms : [],
        mode: options.mode,
        quota: options.quota,
        partyQuota: options.partyQuota,
        maxMembers: settings.maxMembers,
        port: settings.port,
        peerId: identity.peerId,
        avatarUrl: identity.avatarUrl,
        nicknameFrom: identity.nicknameFrom,
      })
      if (settings.allowMemberControl) session.setMemberControlEnabled(true)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建房间失败')
    } finally {
      setBusy(false)
    }
  }, [identity, session, settings.allowMemberControl, settings.maxMembers, settings.port, settings.showBadges, platforms, identityReady])

  const join = useCallback(async (invite: string) => {
    if (!identityReady) { setError('房间里显示为「自定义」时必须先填一个用户名'); return }
    setBusy(true)
    setError('')
    try {
      await session.join(invite, {
        nickname: identity.nickname,
        platforms: settings.showBadges ? platforms : [],
        peerId: identity.peerId,
        avatarUrl: identity.avatarUrl,
        nicknameFrom: identity.nicknameFrom,
      })
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : '加入房间失败')
    } finally {
      setBusy(false)
    }
  }, [identity, session, settings.showBadges, platforms, identityReady])

  const scanLan = useCallback(async () => {
    if (!settings.lanDiscovery) return []
    try {
      return await (window.electron?.resonance?.scanLan() ?? Promise.resolve([]))
    } catch {
      return []
    }
  }, [settings.lanDiscovery])

  const addTracks = useCallback((tracks: Array<Omit<ResonanceTrack, 'key' | 'seq' | 'requestedBy'>>, label: string) => {
    if (snapshot.role === 'host') {
      const result = session.hostAddTracks(tracks, true)
      if (!result.ok) return { ok: false as const, reason: result.reason }
      const added = (result.truncated ? tracks.length - result.truncated : tracks.length)
      return { ok: true as const, added, truncated: result.truncated }
    }
    session.requestAddTracks(tracks)
    void label
    return { ok: true as const, added: tracks.length }
  }, [session, snapshot.role])

  const room = snapshot.room
  const remainingQuota = useMemo(() => {
    if (!room || !snapshot.role) return Number.POSITIVE_INFINITY
    const peerId = session.getIdentity()?.peerId || peerIdRef.current
    return remainingAddQuota(room, peerId)
  }, [room, session, snapshot.role])
  const allowBulkPush = Boolean(room && room.mode === 'shared-playlist' && room.hostId === (session.getIdentity()?.peerId || peerIdRef.current))

  const nowPlayingView = nowPlaying?.song
    ? {
      title: nowPlaying.song.name,
      artists: (nowPlaying.song.artists || []).map(artist => artist.name).join(' / '),
      coverUrl: nowPlaying.song.album?.picUrl || '',
      durationMs: nowPlaying.song.duration || 0,
      positionMs: nowPlaying.positionMs,
    }
    : null
  const currentTrackKey = room?.playback?.trackKey || ''
  const unplayable = unplayableByKey[currentTrackKey] || null

  if (!noticeAccepted) {
    return (
      <ResonanceNotice
        playerTheme={playerTheme}
        onAccept={remember => {
          if (remember) acknowledgeNoticeForever()
          setNoticeAccepted(true)
        }}
      />
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden" style={{ color: playerTheme === 'dark' ? '#fff' : '#101318' }}>
      <ResonanceBackground
        settings={settings}
        coverUrl={nowPlayingView?.coverUrl || ''}
        isPlaying={Boolean(nowPlaying?.playing)}
      />

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        {/* 顶部居中的模式下拉：与其它四个模式一致（悬停/点击展开模式卡片）。
            左上角保留品牌头图，设置/返回挪到左下角（见文件末尾的底部左侧操作区）。 */}
        {/* 顶部居中的模式下拉：与其它四个模式**同一套行为**——平时藏起来，
            鼠标移到顶边（或 TV 遥控器模式）才浮出。之前这里常驻显示，玩家反馈「箭头一直挂在那」。
            左上角保留品牌头图，设置/返回在左下角（见文件末尾的底部左侧操作区）。 */}
        <div
          className="absolute left-1/2 top-0 z-[95] h-10 w-40 -translate-x-1/2"
          onMouseEnter={() => setModeTriggerHovered(true)}
          onMouseLeave={() => setModeTriggerHovered(false)}
        >
          {modeTriggerHovered && !modePanelOpen && (
            <button
              type="button"
              aria-label="打开模式选择"
              data-tv-focus
              onClick={() => { setModeTriggerHovered(false); setModePanelOpen(true) }}
              className="flex h-8 w-[200px] -translate-x-1/2 items-center justify-center rounded-b-2xl border border-t-0 border-white/20 bg-white/10 text-white backdrop-blur-md transition hover:bg-white/20"
              style={{ marginLeft: '50%' }}
            >
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
              </svg>
            </button>
          )}
        </div>

        <header className="flex shrink-0 flex-wrap items-center gap-3 px-5 pb-2 pt-4">
          <img src="/resonance-logo.svg" alt="" className="h-10 w-10 rounded-2xl shadow-lg" />
          <div className="min-w-0">
            <h1 className="text-base font-semibold">共振 · 一起听</h1>
          </div>
          {(snapshot.status === 'joining' || snapshot.status === 'hosting') && (
            <span className="flex items-center gap-2 text-xs" style={{ color: playerTheme === 'dark' ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)' }}>
              <Loader2 className="h-4 w-4 animate-spin" />连接中…
            </span>
          )}
          <span className="flex-1" />
          {room && (
            <span className="text-[11px]" style={{ color: playerTheme === 'dark' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)' }}>
              {room.members.length}/{room.maxMembers} 人 · 端到端加密
            </span>
          )}
        </header>

        {snapshot.error && (
          <div className="mx-5 mb-2 rounded-xl px-3 py-2 text-xs" style={{ background: 'rgba(255,120,90,0.18)', color: '#ffb9a8' }} role="status">
            {snapshot.error}
          </div>
        )}

        <div className="min-h-0 flex-1">
          <AnimatePresence mode="wait">
            {room ? (
              <motion.div key="room" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
                <ResonanceRoom
                  playerTheme={playerTheme}
                  accent={settings.accent}
                  settings={settings}
                  snapshot={snapshot}
                  selfPeerId={session.getIdentity()?.peerId || peerIdRef.current}
                  remainingQuota={remainingQuota}
                  onSendChat={text => session.sendChat(text)}
                  onVoteSkip={target => session.voteSkip(target)}
                  onForceSkip={() => session.hostForceSkip()}
                  onNext={() => session.hostNext()}
                  onRemoveTrack={key => {
                    const result = session.removeFromQueue(key)
                    if (!result.ok && result.reason === 'not-allowed') {
                      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '只能移除自己点的歌（房主可以移除任意）', type: 'error' } }))
                    }
                  }}
                  onMoveToNext={key => session.moveToNext(key)}
                  onGrantControl={peerId => session.grantControl(peerId)}
                  onRevokeControl={() => session.revokeControl()}
                  onRequestControl={() => session.requestControl()}
                  onKick={peerId => session.hostKick(peerId)}
                  onToggleAvatars={enabled => setResonanceSetting('showAvatars', enabled)}
                  onPromotePending={trackKey => session.hostPromotePending(trackKey)}
                  onDismissPending={trackKey => session.hostDismissPending(trackKey)}
                  onToggleMemberControl={enabled => session.setMemberControlEnabled(enabled)}
                  onLoadMoreQueue={() => session.loadQueuePage(snapshot.queue.items.length)}
                  onOpenAdd={() => setAddOpen(true)}
                  onLeave={() => session.leave()}
                  onDissolve={() => session.dissolve()}
                  playingLocal={!unplayable}
                  unplayableText={unplayable}
                  arrivingHint={arrivingHint}
                  nowPlaying={nowPlayingView}
                />
              </motion.div>
            ) : (
              <motion.div key="lobby" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
                <ResonanceLobby
                  playerTheme={playerTheme}
                  accent={settings.accent}
                  nickname={settings.nickname}
                  identityOptions={identityOptions}
                  activeIdentityKey={activeIdentity?.key || 'custom'}
                  onIdentityChange={key => setResonanceSetting('nicknameSource', key)}
                  onNicknameChange={value => setResonanceSetting('nickname', value)}
                  platforms={platforms}
                  platformNames={usernames}
                  defaultMode={settings.defaultMode}
                  defaultQuota={settings.quota}
                  defaultPartyQuota={settings.partyQuota}
                  maxMembers={settings.maxMembers}
                  onMaxMembersChange={value => setResonanceSetting('maxMembers', value)}
                  allowLanDiscovery={settings.lanDiscovery}
                  busy={busy}
                  error={error}
                  onCreate={options => void create(options)}
                  onJoin={invite => void join(invite)}
                  onScanLan={scanLan}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {addOpen && room && (
          <ResonanceAddPanel
            playerTheme={playerTheme}
            platforms={platforms}
            userIds={userIds}
            usernames={usernames}
            pushLimit={settings.pushLimit}
            remainingQuota={remainingQuota}
            allowBulkPush={allowBulkPush}
            accent={settings.accent}
            busy={busy}
            onClose={() => setAddOpen(false)}
            onAdd={(tracks, label) => addTracks(tracks, label)}
          />
        )}
        {settingsOpen && (
          <ResonanceSettingsModal
            playerTheme={playerTheme}
            inRoom={Boolean(room)}
            identityOptions={identityOptions}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* 左下角操作区：设置 + 离开房间 + 返回探索（右上角留给房间信息，不再堆按钮） */}
      <div className="pointer-events-none absolute bottom-4 left-4 z-20 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="pointer-events-auto flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs backdrop-blur-md transition"
          style={{
            borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)',
            background: playerTheme === 'dark' ? 'rgba(12,14,22,0.55)' : 'rgba(255,255,255,0.72)',
          }}
        >
          <Settings2 className="h-3.5 w-3.5" />设置
        </button>
        {room && (
          <button
            type="button"
            onClick={() => { if (snapshot.role === 'host') session.dissolve(); else session.leave() }}
            className="pointer-events-auto flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs backdrop-blur-md transition"
            style={{
              borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)',
              background: playerTheme === 'dark' ? 'rgba(12,14,22,0.55)' : 'rgba(255,255,255,0.72)',
            }}
          >
            {snapshot.role === 'host' ? '解散房间' : '退出房间'}
          </button>
        )}
        <button
          type="button"
          onClick={() => onSelectMode(entryMode as 'explore' | 'minimal' | 'traditional' | 'desktop')}
          className="pointer-events-auto flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs backdrop-blur-md transition"
          style={{
            borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)',
            background: playerTheme === 'dark' ? 'rgba(12,14,22,0.55)' : 'rgba(255,255,255,0.72)',
          }}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回{modeLabel(entryMode)}
        </button>
      </div>

      <AnimatePresence>
        {modePanelOpen && (
          <ModeSelectionPanel
            currentMode="resonance"
            onClose={() => setModePanelOpen(false)}
            onSelect={mode => { setModePanelOpen(false); if (mode !== 'resonance') onSelectMode(mode) }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
