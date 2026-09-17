/**
 * 共振大厅：创建房间 / 加入房间。
 *
 * 按用户反馈重做：
 * - 房间模式改成自定义分段卡片；选「我推荐」后**在下方自动展开**每人加歌数选择（1–3），不再用原生下拉。
 * - 局域网：进入时自动找 30 秒，找不到再留「扫描局域网」按钮给用户手动重试。
 *   全程一次性扫描，不做后台轮询。
 * - 界面语言与整软件一致：玻璃卡片 + 品牌色渐变，不是一堆默认控件。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { DoorOpen, Loader2, Plus, Radio, RefreshCw, ShieldCheck, UserRound, Users, Wifi } from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import { platformLabel, type MusicPlatform } from '../../services/platforms'
import {
  RESONANCE_MAX_MEMBERS,
  RESONANCE_MODE_LABEL,
  RESONANCE_QUOTA_RANGE,
  clampQuota,
  type ResonanceMode,
  type ResonancePlatformBadge,
} from './model'

export interface ResonanceIdentityOption {
  key: string
  label: string
  nickname: string
  avatarUrl: string
  platform?: string
}

export interface ResonanceLobbyProps {
  playerTheme?: 'dark' | 'light'
  accent: string
  nickname: string
  /** 可选昵称来源：各平台昵称 + 自定义 */
  identityOptions: ResonanceIdentityOption[]
  /** 各平台账号名（用于「当前可用平台」里显示金色用户名） */
  platformNames: Partial<Record<MusicPlatform, string>>
  activeIdentityKey: string
  onIdentityChange: (key: string) => void
  onNicknameChange: (value: string) => void
  platforms: ResonancePlatformBadge[]
  defaultMode: ResonanceMode
  defaultQuota: number
  defaultPartyQuota: number
  maxMembers: number
  onMaxMembersChange: (value: number) => void
  allowLanDiscovery: boolean
  busy: boolean
  error: string
  onCreate: (options: { mode: ResonanceMode; quota: number; partyQuota: number }) => void
  onJoin: (invite: string) => void
  onScanLan: () => Promise<Array<{ address: string; name: string; memberCount: number; open: boolean }>>
  onOpenSettings: () => void
}

const MODES: ResonanceMode[] = ['shared-playlist', 'party', 'round-robin']

/** 进入共振时自动找房间的时长（秒）：找不到就把「扫描局域网」按钮留给用户 */
const LAN_SCAN_SECONDS = 30

export default function ResonanceLobby(props: ResonanceLobbyProps) {
  const {
    playerTheme = 'dark', accent, nickname, identityOptions, activeIdentityKey, onIdentityChange,
    onNicknameChange, platforms, platformNames, defaultMode, defaultQuota, defaultPartyQuota, maxMembers,
    onMaxMembersChange, allowLanDiscovery, busy, error, onCreate, onJoin, onScanLan, onOpenSettings,
  } = props
  const dark = playerTheme === 'dark'
  const [mode, setMode] = useState<ResonanceMode>(defaultMode)
  const [quota, setQuota] = useState(clampQuota(defaultQuota))
  const [partyQuota, setPartyQuota] = useState(Math.max(1, Math.min(10, defaultPartyQuota)))
  const [invite, setInvite] = useState('')
  const [lanRooms, setLanRooms] = useState<Array<{ address: string; name: string; memberCount: number; open: boolean }>>([])
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  /** 进入共振时自动找房间的倒计时（秒），只用于给用户反馈 */
  const [scanSecondsLeft, setScanSecondsLeft] = useState(LAN_SCAN_SECONDS)
  const scanSeq = useRef(0)
  const autoScannedRef = useRef(false)
  const [countdownTimer, setCountdownTimer] = useState<number | null>(null)

  const border = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'
  const panel = dark ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.7)'
  const sub = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
  const chip = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'

  const loggedIn = useMemo(() => platforms.filter(item => item.loggedIn), [platforms])
  const parsedInvite = useMemo(() => invite.trim().startsWith('wf-resonance://'), [invite])
  const activeIdentity = identityOptions.find(option => option.key === activeIdentityKey) || identityOptions[0]
  /** 身份没准备好（选了自定义却没填名字）时不能创建也不能加入 */
  const identityReady = Boolean(activeIdentity?.nickname?.trim())

  // 只在用户点「扫描」时找房间（不后台轮询）
  const scan = useCallback(async () => {
    const seq = ++scanSeq.current
    setScanning(true)
    setScanSecondsLeft(LAN_SCAN_SECONDS)
    // 倒计时只是给用户一个「还要找多久」的反馈；扫描本身是一次性的
    setCountdownTimer(window.setInterval(() => {
      setScanSecondsLeft(prev => (prev > 1 ? prev - 1 : 1))
    }, 1000))
    try {
      const result = await onScanLan()
      if (seq === scanSeq.current) { setLanRooms(result); setScanned(true) }
    } finally {
      if (seq === scanSeq.current) setScanning(false)
      setCountdownTimer(prev => { if (prev) window.clearInterval(prev); return null })
    }
  }, [onScanLan])

  // 进入共振页自动找一次（最长 30 秒），找不到就留「扫描局域网」按钮让用户手动再来
  useEffect(() => {
    if (!allowLanDiscovery || autoScannedRef.current) return
    autoScannedRef.current = true
    void scan()
  }, [allowLanDiscovery, scan])

  useEffect(() => () => { if (countdownTimer) window.clearInterval(countdownTimer) }, [countdownTimer])

  useEffect(() => {
    // 关闭「允许局域网发现」时清空结果，避免残留
    if (!allowLanDiscovery) { setLanRooms([]); setScanned(false) }
  }, [allowLanDiscovery])

  const segment = (options: Array<{ value: number; label: string }>, value: number, onChange: (next: number) => void, ariaLabel: string) => (
    <div className="flex items-center gap-0.5 rounded-xl p-0.5" style={{ background: chip }} role="group" aria-label={ariaLabel}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className="rounded-[10px] px-3.5 py-1.5 text-[13px] transition"
          style={{ background: value === option.value ? accent : 'transparent', color: value === option.value ? '#fff' : sub }}
          aria-pressed={value === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  )

  return (
    /*
      自适应布局：外层不滚动（页面滚动条在游戏化界面里很突兀），两栏各自在需要时内部滚动。
      注意不要用 `items-center` 居中 + 外层 overflow —— 内容比容器高时会把顶部裁掉且滚不到，
      所以用 `lg:my-auto` 让卡片自己在剩余空间里居中。
    */
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[1080px] flex-col gap-5 px-6 pb-16 pt-4 lg:flex-row lg:justify-center">
      {/* ── 创建房间 ── */}
      <motion.section
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex min-h-0 w-full flex-col rounded-[22px] border p-6 lg:my-auto lg:max-h-full lg:w-[500px]"
        style={{ borderColor: border, background: panel, backdropFilter: 'blur(20px)' }}
        data-tv-scope
      >
        {/* 内容区独立滚动，主按钮留在滚动区外：1366×768 及更矮窗口下「创建房间并开始」不再被顶出可视区 */}
        <div className="wf-no-scrollbar min-h-0 flex-1 overflow-y-auto">
          <header className="mb-4 flex items-center gap-2.5">
            <img src="/resonance-logo.svg" alt="" className="h-9 w-9 rounded-xl" />
            <div className="min-w-0">
              <h2 className="text-base font-semibold">创建房间</h2>
              <p className="text-xs" style={{ color: sub }}>你是房主 · 播放由你掌舵</p>
            </div>
            <button type="button" onClick={onOpenSettings} className="ml-auto rounded-full px-3 py-1.5 text-xs" style={{ background: chip, color: sub }}>共振设置</button>
          </header>

          {/* 身份：用哪个平台的昵称（默认平台昵称，而不是让你现编一个） */}
          <div className="mb-3">
            <div className="mb-2 flex items-center gap-2 text-sm" style={{ color: sub }}>
              <UserRound className="h-4 w-4" />房间里显示为
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {identityOptions.map(option => {
                const active = activeIdentityKey === option.key
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => onIdentityChange(option.key)}
                    className="flex items-center gap-2 rounded-full border py-1 pl-1 pr-3.5 text-sm transition"
                    style={{ borderColor: active ? `${accent}77` : border, background: active ? `${accent}1f` : 'transparent' }}
                    aria-pressed={active}
                  >
                    <span className="h-7 w-7 shrink-0 overflow-hidden rounded-full" style={{ background: chip }}>
                      {option.avatarUrl
                        ? <CachedImage src={option.avatarUrl} alt="" className="h-full w-full object-cover" role="compact" />
                        : option.key === 'custom'
                          // 自定义没有头像：给个图标，别拿昵称首字冒充头像（看着像另一个用户名）
                          ? <span className="flex h-full w-full items-center justify-center" style={{ color: sub }}><UserRound className="h-3.5 w-3.5" /></span>
                          : <span className="flex h-full w-full items-center justify-center text-[11px]" style={{ color: sub }}>{option.nickname.slice(0, 1)}</span>}
                    </span>
                    {/* 自定义档永远显示「自定义」：具体名字在下面的输入框里，chip 上再挂一遍名字反而像另一个账号 */}
                    <span className="truncate">{option.key === 'custom' ? '自定义' : option.nickname}</span>
                    {option.platform && <span style={{ color: sub }}>{platformLabel(option.platform)}</span>}
                  </button>
                )
              })}
            </div>
            {activeIdentityKey === 'custom' && (
              <div className="mt-2">
                <input
                  value={nickname}
                  onChange={event => onNicknameChange(event.target.value.slice(0, 16))}
                  placeholder="自定义用户名（必填）"
                  maxLength={16}
                  autoFocus
                  className="h-9 w-full rounded-xl border bg-transparent px-3 text-sm outline-none"
                  style={{ borderColor: nickname.trim() ? border : '#ff8b9a88' }}
                  aria-label="自定义房间用户名"
                  aria-invalid={!nickname.trim()}
                />
                <p className="mt-1 text-xs" style={{ color: nickname.trim() ? sub : '#ff8b9a' }}>
                  {nickname.trim() ? '房间里的人会看到这个名字' : '选自定义就必须填一个名字，否则不能创建或加入房间'}
                </p>
              </div>
            )}
          </div>

          {/* 房间模式 */}
          <div className="mb-1.5 text-xs" style={{ color: sub }}>房间模式</div>
          <div className="space-y-1.5">
            {MODES.map(item => (
              <div key={item}>
                <button
                  type="button"
                  onClick={() => setMode(item)}
                  className="w-full rounded-2xl border px-4 py-2.5 text-left transition"
                  style={{ borderColor: mode === item ? `${accent}88` : border, background: mode === item ? `${accent}1a` : 'transparent' }}
                  aria-pressed={mode === item}
                >
                  <span className="flex items-center gap-2 text-base font-semibold">
                    {RESONANCE_MODE_LABEL[item]}
                    {mode === item && <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />}
                  </span>
                </button>
                {/* 选中后自动展开该模式的配额设置 */}
                {mode === item && item === 'round-robin' && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden">
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5" style={{ background: chip }}>
                      <span className="text-xs" style={{ color: sub }}>每人每轮可推荐</span>
                      {segment(
                        Array.from({ length: RESONANCE_QUOTA_RANGE[1] - RESONANCE_QUOTA_RANGE[0] + 1 }, (_, index) => ({ value: RESONANCE_QUOTA_RANGE[0] + index, label: `${RESONANCE_QUOTA_RANGE[0] + index} 首` })),
                        quota,
                        setQuota,
                        '每人每轮可推荐曲目数',
                      )}
                    </div>
                  </motion.div>
                )}
                {mode === item && item === 'party' && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden">
                    <div className="mt-2 flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: chip }}>
                      <span className="whitespace-nowrap text-xs" style={{ color: sub }}>每人可加</span>
                      {segment(
                        [1, 2, 3, 5].map(value => ({ value, label: `${value} 首` })),
                        partyQuota,
                        setPartyQuota,
                        '每人可加歌曲数',
                      )}
                      <span className="whitespace-nowrap text-[11px]" style={{ color: sub }}>（整场累计）</span>
                    </div>
                  </motion.div>
                )}
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <Users className="h-4 w-4" style={{ color: sub }} />
            <span className="text-sm" style={{ color: sub }}>人数上限</span>
            <input
              type="range"
              min={2}
              max={RESONANCE_MAX_MEMBERS}
              step={1}
              value={maxMembers}
              onChange={event => onMaxMembersChange(Number(event.target.value))}
              className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
              style={{ background: `linear-gradient(90deg, ${accent} ${((maxMembers - 2) / (RESONANCE_MAX_MEMBERS - 2)) * 100}%, ${chip} ${((maxMembers - 2) / (RESONANCE_MAX_MEMBERS - 2)) * 100}%)` }}
              aria-label="房间人数上限"
            />
            <span className="w-14 text-right text-sm tabular-nums" style={{ color: sub }}>{maxMembers} 人</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5 rounded-xl px-3 py-2" style={{ background: chip }}>
            <span className="text-sm" style={{ color: sub }}>当前可用平台</span>
            {loggedIn.length === 0
              ? <span className="text-xs" style={{ color: '#ffb45a' }}>还没登录任何平台，进房后会静音跟随（只同步歌曲与进度）</span>
              : loggedIn.map(item => (
                <span key={item.platform} className="rounded-full px-2.5 py-1 text-xs" style={{ background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }}>
                  {platformLabel(item.platform)}
                  {platformNames[item.platform]
                    ? <span className="ml-1 font-medium" style={{ color: '#f5c451' }}>{platformNames[item.platform]}</span>
                    : null}
                </span>
              ))}
          </div>

          {error && <p className="mt-3 text-xs" style={{ color: '#ff8b9a' }} role="status">{error}</p>}
        </div>

        <button
          type="button"
          disabled={busy || !activeIdentity?.nickname?.trim()}
          onClick={() => onCreate({ mode, quota, partyQuota })}
          className="mt-4 flex h-12 shrink-0 items-center justify-center gap-2 rounded-full text-base font-medium text-white transition disabled:opacity-55"
          style={{ background: accent, boxShadow: `0 8px 24px ${accent}44` }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          创建房间并开始
        </button>
      </motion.section>

      {/* ── 加入房间 ── */}
      <motion.section
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="wf-no-scrollbar flex w-full flex-col overflow-y-auto rounded-[22px] border p-6 lg:my-auto lg:max-h-full lg:w-[500px]"
        style={{ borderColor: border, background: panel, backdropFilter: 'blur(20px)' }}
        data-tv-scope
      >
        <header className="mb-4 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `${accent}22`, color: accent }}>
            <DoorOpen className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold">加入房间</h2>
            <p className="text-xs" style={{ color: sub }}>粘贴房主给你的邀请串</p>
          </div>
        </header>

        <textarea
          value={invite}
          onChange={event => setInvite(event.target.value.trim())}
          rows={3}
          placeholder="wf-resonance://192.168.1.9:25570/xxxxxxxx#123456.xxxxxxxx"
          className="w-full resize-none rounded-2xl border bg-transparent px-3 py-2.5 font-mono text-xs leading-relaxed outline-none"
          style={{ borderColor: parsedInvite ? `${accent}66` : border }}
          aria-label="房间邀请串"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={busy || !parsedInvite || !identityReady}
            onClick={() => onJoin(invite)}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-full text-base font-medium transition disabled:opacity-50"
            style={{ background: parsedInvite ? accent : chip, color: parsedInvite ? '#fff' : sub }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <DoorOpen className="h-4 w-4" />}
            加入
          </button>
        </div>
        {invite && !parsedInvite && <p className="mt-2 text-xs" style={{ color: '#ffb45a' }}>邀请串格式不对，请让房主重新复制完整的一串</p>}

        <div className="mt-4 flex items-center gap-2.5">
          <Wifi className="h-4 w-4" style={{ color: sub }} />
          <span className="text-sm">同一局域网？</span>
          <button
            type="button"
            disabled={!allowLanDiscovery || scanning}
            onClick={() => void scan()}
            className="ml-auto flex items-center gap-2 rounded-full px-4 py-2 text-xs disabled:opacity-50"
            style={{ background: chip, color: sub }}
            title={allowLanDiscovery ? '扫描同网段正在开着的房间' : '已在设置里关闭「允许局域网发现」'}
          >
            {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {scanning ? `扫描中 ${scanSecondsLeft}s` : '扫描局域网'}
          </button>
        </div>
        <div className="mt-2 min-h-[48px] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed" style={{ background: chip, color: sub }}>
          {!allowLanDiscovery
            ? '你已关闭「允许局域网发现」：别人扫不到你，你也只能靠邀请串加入。'
            : scanning
              ? `正在查找同网段的房间…（还剩 ${scanSecondsLeft} 秒）`
              : lanRooms.length > 0
                ? (
                  <div className="space-y-2">
                    {lanRooms.map(room => (
                      <div key={room.address} className="flex items-center gap-2">
                        <Radio className="h-4 w-4 shrink-0" style={{ color: accent }} />
                        <span className="truncate font-medium">{room.name || 'WaveForge'}</span>
                        <span className="truncate">{room.address}</span>
                        <span className="ml-auto shrink-0">{room.memberCount} 人在听 · 需要邀请串</span>
                      </div>
                    ))}
                  </div>
                )
                : scanned
                  ? '附近没有发现开着的房间。'
                  : `进入共振会自动找 ${LAN_SCAN_SECONDS} 秒同网段的房间。`}
        </div>

        <div className="mt-4 flex items-start gap-3 rounded-2xl px-3.5 py-3 text-xs leading-relaxed" style={{ background: chip, color: sub }}>
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" style={{ color: accent }} />
          <p>
            房间内容端到端加密（XChaCha20-Poly1305），密钥由邀请串携带、不经网络传输，中转只转发密文。<br />
            各自播放 · 不共享会员 · 无任何统计上报。房间上限 {RESONANCE_MAX_MEMBERS} 人。
          </p>
        </div>
      </motion.section>
    </div>
  )
}
