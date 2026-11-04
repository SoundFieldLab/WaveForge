/**
 * 移动端「设置」页：只保留移动端有意义的能力——
 * 平台账号（登录/登出，复用 LoginView 面板）、播放偏好、检查更新、关于。
 *
 * ⚠️ 移动端明确不出现的 PC 独占功能（与桌面 SettingsPanel 不共用）：
 * 桌面歌词 / 壁纸与桌面模式 / 桌面小组件 / GPU 与硬件加速 / HSE 调音室与头追 /
 * DG-LAB / AutoMix（Python 服务在移动端不存在）/ 快捷键 / 系统音量捕获。
 */
import { memo, lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { getVisiblePlatforms, platformLabel, type MusicPlatform } from '../../services/platforms'
import { getTabletLayoutStyle, setTabletLayoutStyle, getPcTouchWidth, setPcTouchWidth, PC_TOUCH_WIDTH_OPTIONS, type TabletLayoutStyle } from '../../platform'
import { getQualityOptions, loadAudioQualitySettings, saveAudioQualitySettings, AUDIO_QUALITY_SETTINGS_EVENT, type QualityOptionValue } from '../../services/audioQualitySettings'
import { useMobileNav } from '../nav'
import { useAccounts, mobileLogout, mobileQQLogin, mobileNeteaseLogin, mobileKugouLogin, mobileSodaLogin } from '../mobileLogin'
import { isMobilePlayablePlatform, useMobilePlayer } from '../mobilePlayer'
import { getDebugBridgeToken } from '../../tv/debugRemote'
import { getMobileEffectsScene, setMobileEffectsScene, subscribeMobileEffects } from '../mobileEffects'
import { getKeepScreenOn, setKeepScreenOn } from '../../services/keepScreenOn'
import {
  getModeTransitionStyle, setModeTransitionStyle, isModeTransitionSoundEnabled, setModeTransitionSoundEnabled,
  MODE_TRANSITION_STYLE_EVENT, MODE_TRANSITION_SOUND_EVENT, type ModeTransitionStyle,
} from '../../services/modeTransitionSettings'
import { useEffect as useReactEffect } from 'react'
import {
  IconChevronRight, IconClose, IconHeartFilled, IconRefresh, IconUser, IconVolume,
  PLATFORM_ACCENT, mobileToast,
} from '../ui'

const LoginView = lazy(() => import('../../components/LoginView'))
const CacheClearModal = lazy(() => import('../../components/CacheClearModal'))

type LoginTarget = MusicPlatform | null
type SettingsSection = 'account' | 'playback' | 'appearance' | 'advanced' | 'about'

function readDeveloperMode(): boolean {
  try {
    const saved = localStorage.getItem('developerMode')
    return saved !== null ? saved === 'true' : false
  } catch {
    return false
  }
}

export default memo(function MobileSettings() {
  const nav = useMobileNav()
  const { accounts, refresh } = useAccounts()
  const player = useMobilePlayer()
  const [loginTarget, setLoginTarget] = useState<LoginTarget>(null)
  const [confirmLogout, setConfirmLogout] = useState<MusicPlatform | null>(null)
  const [section, setSection] = useState<SettingsSection>('account')
  const [form, setForm] = useState<string>(() => document.documentElement.dataset.form || 'phone')
  const [layoutStyle, setLayoutStyle] = useState<TabletLayoutStyle>(() => getTabletLayoutStyle())
  const [pcTouchWidth, setPcTouchWidthState] = useState<number>(() => getPcTouchWidth())
  const [developerMode, setDeveloperMode] = useState<boolean>(readDeveloperMode)
  const [debugToken, setDebugToken] = useState('')
  const [effectsScene, setEffectsScene] = useState<string>(getMobileEffectsScene)
  // App 内不熄屏（默认开；原生桥 setKeepScreenOn 实际生效）
  const [keepScreenOn, setKeepScreenOnState] = useState<boolean>(getKeepScreenOn)
  const setKeepScreenOn = (v: boolean) => setKeepScreenOnState(v)
  const [effectsScenes, setEffectsScenes] = useState<Array<{ id: string; name: string; description?: string }>>([])
  // 外观主题（与 PC 同一 localStorage 键 + html[data-wf-theme]，App.tsx 同款语义）
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('playerTheme') === 'light' ? 'light' : 'dark'))
  // ── 高级页签状态（键与 PC SettingsPanel 同源，改动即广播同款事件，多端语义一致）──
  // 转场动画：complex（Steam 风格描边）/ simple（轻量徽章）
  const [transitionStyle, setTransitionStyleState] = useState<ModeTransitionStyle>(getModeTransitionStyle)
  const [transitionSound, setTransitionSoundState] = useState<boolean>(isModeTransitionSoundEnabled)
  // 即将播放提示：歌曲结束前显示下一首信息
  const [upNextEnabled, setUpNextEnabledState] = useState<boolean>(() => localStorage.getItem('upNextEnabled') !== 'false')
  const [upNextSeconds, setUpNextSecondsState] = useState<number>(() => {
    const saved = Number(localStorage.getItem('upNextTime'))
    return Number.isFinite(saved) && saved >= 5 ? Math.min(30, saved) : 15
  })
  // 首要歌词库（第三方歌词源）：与 PC 同键 + 同步事件
  const [primaryLyricsSource, setPrimaryLyricsSourceState] = useState<string>(() => localStorage.getItem('primaryLyricsSource') || 'AMLL')
  const [showCacheClear, setShowCacheClear] = useState(false)
  const pickTheme = useCallback((t: 'dark' | 'light') => {
    setTheme(t)
    try { localStorage.setItem('playerTheme', t) } catch { /* ignore */ }
    document.documentElement.dataset.wfTheme = t
    mobileToast(t === 'light' ? '已切换浅色主题' : '已切换深色主题')
  }, [])

  // 音效场景列表在音频图就绪后（引擎创建）才有：订阅变化刷新
  useReactEffect(() => {
    const refresh = () => {
      setEffectsScene(getMobileEffectsScene())
      // 场景列表需要引擎实例；播放一次后可获取。通过动态 import 避免加载顺序问题
      void import('../mobileEffects').then(m => setEffectsScenes(m.getMobileScenes()))
    }
    refresh()
    return subscribeMobileEffects(refresh)
  }, [])

  // 高级设置与 PC 双向同步：桌面树（pc-touch）改了这里要跟上
  useReactEffect(() => {
    const onStyle = () => setTransitionStyleState(getModeTransitionStyle())
    const onSound = () => setTransitionSoundState(isModeTransitionSoundEnabled())
    window.addEventListener(MODE_TRANSITION_STYLE_EVENT, onStyle)
    window.addEventListener(MODE_TRANSITION_SOUND_EVENT, onSound)
    return () => {
      window.removeEventListener(MODE_TRANSITION_STYLE_EVENT, onStyle)
      window.removeEventListener(MODE_TRANSITION_SOUND_EVENT, onSound)
    }
  }, [])

  const pickTransitionStyle = useCallback((style: ModeTransitionStyle) => {
    setModeTransitionStyle(style)
    setTransitionStyleState(style)
    mobileToast(style === 'complex' ? '转场动画：复杂' : '转场动画：简易')
  }, [])
  const toggleTransitionSound = useCallback((enabled: boolean) => {
    setModeTransitionSoundEnabled(enabled)
    setTransitionSoundState(enabled)
  }, [])
  const toggleUpNext = useCallback((enabled: boolean) => {
    setUpNextEnabledState(enabled)
    try { localStorage.setItem('upNextEnabled', JSON.stringify(enabled)) } catch { /* ignore */ }
    window.dispatchEvent(new Event('upNextEnabledChanged'))
  }, [])
  const changeUpNextSeconds = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds)) return
    const clamped = Math.max(5, Math.min(30, Math.round(seconds)))
    setUpNextSecondsState(clamped)
    try { localStorage.setItem('upNextTime', String(clamped)) } catch { /* ignore */ }
    window.dispatchEvent(new Event('upNextTimeChanged'))
  }, [])
  const pickPrimaryLyricsSource = useCallback((key: string) => {
    setPrimaryLyricsSourceState(key)
    try { localStorage.setItem('primaryLyricsSource', key) } catch { /* ignore */ }
    window.dispatchEvent(new Event('waveforge:lyrics-policy-changed'))
  }, [])

  // ── 播放音质（全局档位；与 PC 同键 audioQualitySettings，事件同步双端）──
  const platform = nav.platform
  const qualityOptions = getQualityOptions(platform)
  const [qualityMap, setQualityMap] = useState(() => loadAudioQualitySettings())
  const currentQuality = qualityMap[platform as keyof typeof qualityMap]
  const [crossPlatformFallback, setCrossPlatformFallback] = useState<boolean>(
    () => localStorage.getItem('crossPlatformFallbackEnabled') === 'true')
  useReactEffect(() => {
    const sync = () => setQualityMap(loadAudioQualitySettings())
    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, sync)
    return () => window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, sync)
  }, [])
  const pickQuality = useCallback((value: QualityOptionValue) => {
    saveAudioQualitySettings({ [platform]: value } as never)
    setQualityMap(loadAudioQualitySettings())
    mobileToast('播放音质已更新')
  }, [platform])

  // 开发者模式开启后轮询取配对令牌（debugRemote 异步从后端拿）
  useEffect(() => {
    if (!developerMode) { setDebugToken(''); return }
    let alive = true
    const read = () => { if (alive) setDebugToken(getDebugBridgeToken()) }
    read()
    const timer = window.setInterval(read, 1500)
    return () => { alive = false; window.clearInterval(timer) }
  }, [developerMode])

  const toggleDeveloperMode = useCallback((enabled: boolean) => {
    setDeveloperMode(enabled)
    try {
      localStorage.setItem('developerMode', JSON.stringify(enabled))
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('developerModeChanged', { detail: enabled }))
    mobileToast(enabled ? '开发者模式已开启（:3008 调试服务启动中）' : '开发者模式已关闭')
  }, [])

  // Fold 开合同步形态（切换入口只在 tablet 形态出现）
  useEffect(() => {
    const onChanged = () => setForm(document.documentElement.dataset.form || 'phone')
    window.addEventListener('waveforge-platform-changed', onChanged)
    return () => window.removeEventListener('waveforge-platform-changed', onChanged)
  }, [])

  const pickLayoutStyle = useCallback((style: TabletLayoutStyle) => {
    setLayoutStyle(style)
    setTabletLayoutStyle(style)
    if (style === 'mobile') mobileToast('已切回移动布局')
    // 选 PC 版时整树立即切到桌面 App（本组件随移动树卸载），
    // 桌面端「设置 → 移动端」里可切回移动布局
  }, [])

  const platforms = getVisiblePlatforms()

  const handleLoginSuccess = useCallback(async (platform: MusicPlatform, cookie: string, username?: string) => {
    if (platform === 'qq') await mobileQQLogin(cookie)
    else if (platform === 'netease') await mobileNeteaseLogin(cookie)
    else if (platform === 'kugou') mobileKugouLogin(cookie, username)
    else if (platform === 'soda') mobileSodaLogin(cookie, username)
    else mobileToast('该平台登录暂未适配移动端')
    refresh()
  }, [refresh])

  const checkUpdate = useCallback(() => {
    const native = (window as any).WaveForgeNative
    if (native?.checkForUpdates) {
      native.checkForUpdates()
      mobileToast('正在检查更新…')
    } else {
      mobileToast('当前环境不支持应用内更新', 'error')
    }
  }, [])

  return (
    <div className="wf-m-page">
      <header className="wf-m-header"><div className="wf-m-header-title">设置</div></header>

      <div className="wf-m-tabs">
        {(['account', 'playback', 'appearance', 'advanced', 'about'] as const).map(s => (
          <button key={s} type="button" className={`wf-m-tab ${section === s ? 'is-on' : ''}`} onClick={() => setSection(s)}>
            {s === 'account' ? '平台与账号' : s === 'playback' ? '播放' : s === 'appearance' ? '外观' : s === 'advanced' ? '高级' : '关于'}
          </button>
        ))}
      </div>

      {section === 'account' && (
        <div className="wf-m-cards">
          {platforms.map(p => {
            const acc = accounts[p]
            const playable = isMobilePlayablePlatform(p)
            return (
              <div key={p} className="wf-m-card">
                <div className="wf-m-card-row">
                  <span className="wf-m-platform-dot" style={{ background: PLATFORM_ACCENT[p] }} />
                  <span className="wf-m-card-main">
                    <span className="wf-m-card-title">{platformLabel(p)}{!playable && <em className="wf-m-card-note">仅浏览</em>}</span>
                    <span className="wf-m-card-sub">
                      {acc?.loggedIn ? (acc.username || '已登录') : '未登录'}
                    </span>
                  </span>
                  {acc?.loggedIn ? (
                    <button type="button" className="wf-m-btn wf-m-btn-ghost" onClick={() => setConfirmLogout(p)}>退出</button>
                  ) : playable ? (
                    <button
                      type="button"
                      className="wf-m-btn"
                      onClick={() => setLoginTarget(p)}
                    >
                      <IconUser size={14} /> 登录
                    </button>
                  ) : (
                    <span className="wf-m-card-note">移动端仅浏览</span>
                  )}
                </div>
                {nav.platform === p && (
                  <div className="wf-m-card-foot">当前音源平台 <IconChevronRight size={12} /></div>
                )}
                {nav.platform !== p && (
                  <div className="wf-m-card-foot">
                    <button type="button" className="wf-m-linklike" onClick={() => { nav.setPlatform(p); mobileToast(`已切换到${platformLabel(p)}`) }}>
                      设为当前平台
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {section === 'playback' && (
        <div className="wf-m-cards">
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">App 内不熄屏</span>
                <span className="wf-m-card-sub">
                  浏览/听歌时屏幕保持常亮（锁屏键和切后台不受影响）。默认开启。
                </span>
              </span>
              <button
                type="button"
                className={`wf-m-btn ${keepScreenOn ? 'wf-m-btn-primary' : ''}`}
                onClick={() => { const next = !keepScreenOn; setKeepScreenOn(next); setKeepScreenOnState(next); }}
              >
                {keepScreenOn ? '已开启' : '已关闭'}
              </button>
            </div>
          </div>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">音效场景</span>
                <span className="wf-m-card-sub">
                  {effectsScene === 'off'
                    ? '关闭（原声直出）'
                    : `当前：${effectsScenes.find(s => s.id === effectsScene)?.name || effectsScene}（下一首起生效）`}
                </span>
              </span>
            </div>
            <div className="wf-m-scene-picker">
              <button
                type="button"
                className={`wf-m-btn ${effectsScene === 'off' ? 'wf-m-btn-primary' : ''}`}
                onClick={() => setMobileEffectsScene('off')}
              >
                关闭
              </button>
              {effectsScenes.map(s => (
                <button
                  key={s.id}
                  type="button"
                  className={`wf-m-btn ${effectsScene === s.id ? 'wf-m-btn-primary' : ''}`}
                  onClick={() => setMobileEffectsScene(s.id)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">切歌衔接</span>
                <span className="wf-m-card-sub">
                  直切模式（移动端固定单流：双流预载在 Android 上会产生爆音/杂音与卡顿）
                </span>
              </span>
            </div>
          </div>
          {/* 播放音质（全局档位，与 PC audioQualitySettings 同键；当前平台卡片） */}
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">播放音质（{platformLabel(platform)}）</span>
                <span className="wf-m-card-sub">
                  {qualityOptions.find(o => o.value === currentQuality)?.label || currentQuality}
                  （更高音质更耗流量）
                </span>
              </span>
            </div>
            <div className="wf-m-scene-picker">
              {qualityOptions.map(o => (
                <button
                  key={o.value}
                  type="button"
                  className={`wf-m-btn ${currentQuality === o.value ? 'wf-m-btn-primary' : ''}`}
                  onClick={() => pickQuality(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {/* 平台可用性增强（跨平台补源）：源平台播不了时同名匹配其他平台 */}
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">平台可用性增强</span>
                <span className="wf-m-card-sub">
                  VIP/版权歌曲在原平台无法播放时，自动尝试同名匹配其它已登录平台播放
                </span>
              </span>
              <button
                type="button"
                className={`wf-m-btn ${crossPlatformFallback ? 'wf-m-btn-primary' : ''}`}
                onClick={() => {
                  const next = !crossPlatformFallback
                  setCrossPlatformFallback(next)
                  try { localStorage.setItem('crossPlatformFallbackEnabled', String(next)) } catch { /* ignore */ }
                  mobileToast(next ? '平台可用性增强已开启' : '平台可用性增强已关闭')
                }}
              >
                {crossPlatformFallback ? '已开启' : '已关闭'}
              </button>
            </div>
          </div>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">播放模式</span>
                <span className="wf-m-card-sub">
                  {player.playMode === 'list' ? '顺序播放（列表播完即停）' : player.playMode === 'random' ? '随机播放' : '单曲循环'}
                </span>
              </span>
              <button type="button" className="wf-m-btn" onClick={player.cyclePlayMode}>切换</button>
            </div>
          </div>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <IconVolume size={18} />
              <span className="wf-m-card-main"><span className="wf-m-card-title">音量</span></span>
              <input
                className="wf-m-slider"
                type="range" min={0} max={100} step={1}
                value={Math.round(player.volume * 100)}
                onChange={e => player.changeVolume(Number(e.target.value) / 100)}
              />
            </div>
          </div>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">红心歌曲</span>
                <span className="wf-m-card-sub">在播放页点 ♥ 收藏到「我喜欢的音乐」</span>
              </span>
              <IconHeartFilled size={16} className="wf-m-text-accent" />
            </div>
          </div>
        </div>
      )}

      {section === 'advanced' && (
        <div className="wf-m-cards">
          {/* 转场动画（与 PC 同键同事件） */}
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">转场动画</span>
                <span className="wf-m-card-sub">切换模式时的过渡效果（与桌面端同键同步）</span>
              </span>
            </div>
            <div className="wf-m-scene-picker">
              {([['complex', '复杂（描边动画）'], ['simple', '简易（徽章）']] as Array<[ModeTransitionStyle, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`wf-m-btn ${transitionStyle === value ? 'wf-m-btn-primary' : ''}`}
                  onClick={() => pickTransitionStyle(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="wf-m-card-row" style={{ marginTop: 8 }}>
              <span className="wf-m-card-main">
                <span className="wf-m-card-sub">切换模式时播放过渡音效</span>
              </span>
              <button
                type="button"
                className={`wf-m-btn ${transitionSound ? 'wf-m-btn-primary' : ''}`}
                onClick={() => toggleTransitionSound(!transitionSound)}
              >
                {transitionSound ? '已开启' : '已关闭'}
              </button>
            </div>
          </div>

          {/* 即将播放提示（与 PC 同键） */}
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">即将播放提示</span>
                <span className="wf-m-card-sub">歌曲结束前显示下一首歌曲信息</span>
              </span>
              <button
                type="button"
                className={`wf-m-btn ${upNextEnabled ? 'wf-m-btn-primary' : ''}`}
                onClick={() => toggleUpNext(!upNextEnabled)}
              >
                {upNextEnabled ? '已开启' : '已关闭'}
              </button>
            </div>
            {upNextEnabled && (
              <div className="wf-m-card-row" style={{ marginTop: 8 }}>
                <span className="wf-m-card-main">
                  <span className="wf-m-card-sub">提前 {upNextSeconds} 秒显示</span>
                </span>
                <input
                  className="wf-m-slider"
                  type="range" min={5} max={30} step={1}
                  value={upNextSeconds}
                  onChange={e => changeUpNextSeconds(Number(e.target.value))}
                />
              </div>
            )}
          </div>

          {/* 首要歌词库（第三方歌词源，与 PC 同键） */}
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">首要歌词库</span>
                <span className="wf-m-card-sub">优先使用有逐字的歌词来源</span>
              </span>
            </div>
            <div className="wf-m-scene-picker">
              {([
                ['AMLL', 'AMLL 逐字库'],
                ['Apple Music', 'Apple Music'],
                ['NetEase', '网易云'],
                ['QQMusic', 'QQ音乐'],
                ['Platform', '当前平台'],
              ] as Array<[string, string]>).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`wf-m-btn ${primaryLyricsSource === key ? 'wf-m-btn-primary' : ''}`}
                  onClick={() => pickPrimaryLyricsSource(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 缓存清理（复用 PC 的 CacheClearModal） */}
          <div className="wf-m-card">
            <div className="wf-m-card-row" onClick={() => setShowCacheClear(true)} style={{ cursor: 'pointer' }}>
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">缓存清理</span>
                <span className="wf-m-card-sub">管理封面、歌单列表和错误日志缓存</span>
              </span>
              <IconChevronRight size={16} />
            </div>
          </div>
        </div>
      )}

      {section === 'appearance' && (
        <div className="wf-m-cards">
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">外观主题</span>
                <span className="wf-m-card-sub">跟随系统时间手动切换；PC 端共用同一偏好</span>
              </span>
            </div>
            <div className="wf-m-layout-picker">
              <button
                type="button"
                className={`wf-m-btn ${theme === 'dark' ? 'wf-m-btn-primary' : ''}`}
                onClick={() => pickTheme('dark')}
              >
                🌙 深色
              </button>
              <button
                type="button"
                className={`wf-m-btn ${theme === 'light' ? 'wf-m-btn-primary' : ''}`}
                onClick={() => pickTheme('light')}
              >
                ☀️ 浅色
              </button>
            </div>
          </div>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">布局风格</span>
                <span className="wf-m-card-sub">
                  PC 版 = 完整桌面客户端界面等比缩放进屏幕（可随时在桌面端设置里切回移动版）
                </span>
              </span>
            </div>
            <div className="wf-m-layout-picker">
              <button
                type="button"
                className={`wf-m-btn ${layoutStyle === 'mobile' ? 'wf-m-btn-primary' : ''}`}
                disabled={layoutStyle === 'mobile'}
                onClick={() => pickLayoutStyle('mobile')}
              >
                移动版
              </button>
              <button
                type="button"
                className={`wf-m-btn ${layoutStyle === 'pc' ? 'wf-m-btn-primary' : ''}`}
                disabled={layoutStyle === 'pc'}
                onClick={() => pickLayoutStyle('pc')}
              >
                PC 版
              </button>
            </div>
          </div>
          <p className="wf-m-footnote">
            PC 版布局是桌面客户端的完整移植（触屏可直接点按操作，PC 独占能力已隐藏）；
            平板横竖屏都可用，手机形态仅横屏生效——竖屏会自动保持移动版，转回横屏即恢复。
            移动版为原生触屏设计。
          </p>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">PC 版界面缩放</span>
                <span className="wf-m-card-sub">当前基准宽 {pcTouchWidth}px（数值越大字越小、一屏内容越多）</span>
              </span>
            </div>
            <div className="wf-m-scene-picker">
              {PC_TOUCH_WIDTH_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className={`wf-m-btn ${pcTouchWidth === opt.value ? 'wf-m-btn-primary' : ''}`}
                  onClick={() => { setPcTouchWidth(opt.value); setPcTouchWidthState(opt.value); mobileToast(`PC 版缩放：${opt.label}（${opt.value}px）`) }}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">开发者模式</span>
                <span className="wf-m-card-sub">开启 :3008 热更新调试服务（改前端免重装 APK）</span>
              </span>
              <button
                type="button"
                className={`wf-m-btn ${developerMode ? 'wf-m-btn-primary' : ''}`}
                onClick={() => toggleDeveloperMode(!developerMode)}
              >
                {developerMode ? '已开启' : '开启'}
              </button>
            </div>
            {developerMode && (
              <div className="wf-m-card-row wf-m-devtoken">
                <span className="wf-m-card-main">
                  <span className="wf-m-card-title">USB 直推（推荐）</span>
                  <span className="wf-m-card-sub wf-m-mono">node scripts/push-hot-update.mjs --adb --rebuild</span>
                </span>
              </div>
            )}
            {developerMode && (
              <div className="wf-m-card-row wf-m-devtoken">
                <span className="wf-m-card-main">
                  <span className="wf-m-card-title">局域网直推（配对令牌）</span>
                  <span className="wf-m-card-sub wf-m-mono">
                    {debugToken
                      ? `node scripts/push-hot-update.mjs <手机IP> --token=${debugToken}`
                      : '令牌获取中…（稍后展开）'}
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {section === 'about' && (
        <div className="wf-m-cards">
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">WaveForge 澜音工坊</span>
                <span className="wf-m-card-sub">移动端 · {document.documentElement.dataset.form === 'tablet' ? '平板布局' : '手机布局'}</span>
              </span>
            </div>
          </div>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main"><span className="wf-m-card-title">检查更新</span>
                <span className="wf-m-card-sub">应用内下载并安装新版本</span></span>
              <button type="button" className="wf-m-btn" onClick={checkUpdate}>
                <IconRefresh size={14} /> 检查
              </button>
            </div>
          </div>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">设备识别码</span>
                <span className="wf-m-card-sub wf-m-mono">{deviceId()}</span>
              </span>
            </div>
          </div>
          <p className="wf-m-footnote">
            移动端不含桌面端专属功能（桌面歌词/壁纸/调音室/AI 混音等）。
            功能随 PC 大版本一起发布，「检查更新」即可升级。
          </p>
          <div className="wf-m-card">
            <div className="wf-m-card-row">
              <span className="wf-m-card-main">
                <span className="wf-m-card-title">防后台清理（重要）</span>
                <span className="wf-m-card-sub">
                  播放时已自动启用前台服务，但部分系统仍会清后台。请把本应用加入
                  「设置 → 电池 → 后台高耗电/自启动」白名单，退出后再进入才不会重载。
                </span>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 登录面板（复用桌面/TV 的 LoginView，内含 QQ 扫码、网易云 Cookie、酷狗/汽水登录） */}
      {loginTarget && (
        <div className="wf-m-modal">
          <div className="wf-m-modal-head">
            <span>登录 {platformLabel(loginTarget)}</span>
            <button type="button" className="wf-m-iconbtn" onClick={() => setLoginTarget(null)}><IconClose size={18} /></button>
          </div>
          <div className="wf-m-modal-body">
            <Suspense fallback={<div className="wf-m-loading"><span className="wf-m-spinner" /></div>}>
              <LoginView
                platform={loginTarget}
                onCancel={() => setLoginTarget(null)}
                onLoginSuccess={(cookie, username) => {
                  void handleLoginSuccess(loginTarget, cookie, username)
                  setLoginTarget(null)
                }}
              />
            </Suspense>
          </div>
        </div>
      )}

      {/* 登出确认 */}
      {confirmLogout && (
        <div className="wf-m-dialog-mask" onClick={() => setConfirmLogout(null)}>
          <div className="wf-m-dialog" onClick={e => e.stopPropagation()}>
            <p>退出 {platformLabel(confirmLogout)} 登录？</p>
            <div className="wf-m-dialog-actions">
              <button type="button" className="wf-m-btn" onClick={() => setConfirmLogout(null)}>取消</button>
              <button type="button" className="wf-m-btn wf-m-btn-danger" onClick={() => { mobileLogout(confirmLogout); setConfirmLogout(null); refresh() }}>
                退出登录
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 缓存清理（PC 同款组件：封面/歌单列表/错误日志分类清理） */}
      {showCacheClear && (
        <Suspense fallback={null}>
          <CacheClearModal show={showCacheClear} onClose={() => setShowCacheClear(false)} playerTheme={theme} />
        </Suspense>
      )}
    </div>
  )
})

function deviceId(): string {
  try {
    const native = (window as any).WaveForgeNative
    if (native?.getDeviceId) return String(native.getDeviceId())
  } catch { /* ignore */ }
  return '—'
}
