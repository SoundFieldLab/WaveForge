import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Settings as SettingsIcon, User, Palette, Sparkles, Info, ExternalLink, Github, ChevronRight, Trash2 } from 'lucide-react'
import LoginButton from './LoginButton'
import HomeCustomizeModal from './HomeCustomizeModal'
import CacheClearModal from './CacheClearModal'

interface SettingsPanelProps {
  show: boolean
  onClose: () => void
  // 登录状�?  neteaseLoggedIn: boolean
  neteaseUsername: string
  onNeteaseLogin: (cookie: string) => void
  onNeteaseLogout: () => void
  qqLoggedIn: boolean
  qqUsername: string
  onQQLogin: (cookie: string) => void
  onQQLogout: () => void
  playerTheme?: 'light' | 'dark'
}

export default function SettingsPanel({
  show,
  onClose,
  neteaseLoggedIn,
  neteaseUsername,
  onNeteaseLogin,
  onNeteaseLogout,
  qqLoggedIn,
  qqUsername,
  onQQLogin,
  onQQLogout,
  playerTheme = 'dark',
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<'account' | 'advanced' | 'personalization' | 'about'>('account')
  
  // 根据主题生成颜色类名
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  const hoverBg = playerTheme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'
  
  const [wordByWordLyrics, setWordByWordLyrics] = useState(() => {
    const saved = localStorage.getItem('wordByWordLyrics')
    return saved !== null ? JSON.parse(saved) : true
  })
  const [upNextEnabled, setUpNextEnabled] = useState(() => {
    const saved = localStorage.getItem('upNextEnabled')
    return saved !== null ? JSON.parse(saved) : true
  })
  
  const [upNextSeconds, setUpNextSeconds] = useState(() => {
    const saved = localStorage.getItem('upNextSeconds')
    return saved !== null ? parseInt(saved) : 10
  })
  
  const [translationEnabled, setTranslationEnabled] = useState(() => {
    const saved = localStorage.getItem('translationEnabled')
    return saved !== null ? JSON.parse(saved) : false
  })
  const [translationPosition, setTranslationPosition] = useState<'traditional' | 'bottom-right'>(() => {
    const saved = localStorage.getItem('translationPosition')
    return (saved as 'traditional' | 'bottom-right') || 'traditional'
  })
  
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6' // 默认蓝色
  })
  
  // 第三方歌词源设置
  const [thirdPartyLyricsEnabled, setThirdPartyLyricsEnabled] = useState(() => {
    const saved = localStorage.getItem('thirdPartyLyricsEnabled')
    return saved !== null ? JSON.parse(saved) : true
  })
  
  const [adaptiveLyrics, setAdaptiveLyrics] = useState(() => {
    const saved = localStorage.getItem('adaptiveLyrics')
    return saved !== null ? JSON.parse(saved) : true
  })
  
  const [primaryLyricsSource, setPrimaryLyricsSource] = useState<string>(() => {
    const saved = localStorage.getItem('primaryLyricsSource')
    return saved || 'AMLL'
  })
  
  // 首页自定义弹窗状态
  const [showHomeCustomize, setShowHomeCustomize] = useState(false)
  
  // 缓存清理弹窗状态
  const [showCacheClear, setShowCacheClear] = useState(false)
  
  // 预设主题色
  const presetColors = [
    { name: '天空蓝', value: '#3B82F6' },
    { name: '翡翠绿', value: '#10B981' },
    { name: '紫罗兰', value: '#8B5CF6' },
    { name: '玫瑰红', value: '#EC4899' },
    { name: '橙黄色', value: '#F59E0B' },
    { name: '珊瑚红', value: '#EF4444' },
    { name: '青色', value: '#06B6D4' },
    { name: '石板灰', value: '#64748B' },
  ]

  // 保存逐字歌词设置
  const handleWordByWordToggle = (enabled: boolean) => {
    setWordByWordLyrics(enabled)
    localStorage.setItem('wordByWordLyrics', JSON.stringify(enabled))
    // 触发自定义事件，通知其他组件
    window.dispatchEvent(new Event('wordByWordLyricsChanged'))
  }

  // 保存即将播放提示设置
  const handleUpNextToggle = (enabled: boolean) => {
    setUpNextEnabled(enabled)
    localStorage.setItem('upNextEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('upNextEnabledChanged'))
  }
  
  const handleUpNextSecondsChange = (seconds: number) => {
    const newSeconds = Math.max(5, Math.min(30, seconds))
    setUpNextSeconds(newSeconds)
    localStorage.setItem('upNextSeconds', newSeconds.toString())
    window.dispatchEvent(new CustomEvent('upNextSecondsChanged', { detail: newSeconds }))
  }

  // 保存翻译设置
  const handleTranslationToggle = (enabled: boolean) => {
    setTranslationEnabled(enabled)
    localStorage.setItem('translationEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('translationSettingsChanged'))
  }

  const handleTranslationPositionChange = (position: 'traditional' | 'bottom-right') => {
    setTranslationPosition(position)
    localStorage.setItem('translationPosition', position)
    window.dispatchEvent(new Event('translationSettingsChanged'))
  }
  
  // 保存主题色设置
  const handleAccentColorChange = (color: string) => {
    setAccentColor(color)
    localStorage.setItem('accentColor', color)
    window.dispatchEvent(new CustomEvent('accentColorChanged', { detail: color }))
  }

  return (
    <AnimatePresence>
      {show && (
        <>
          {/* 背景遮罩 */}
          <motion.div
            key="settings-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
          />

          {/* 设置面板 */}
          <motion.div
            key="settings-panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 h-full w-full max-w-md z-50 shadow-2xl overflow-hidden"
          >
            {/* 液态玻璃背景层 */}
            <div className="absolute inset-0">
              {/* 主背�?- 根据主题变化 */}
              <div 
                className="absolute inset-0"
                style={{
                  background: playerTheme === 'dark'
                    ? 'linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.92) 50%, rgba(0,0,0,0.88) 100%)'
                    : 'linear-gradient(135deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.92) 50%, rgba(255,255,255,0.88) 100%)',
                  backdropFilter: 'blur(40px) saturate(150%)',
                  WebkitBackdropFilter: 'blur(40px) saturate(150%)',
                }}
              />
              {/* 光泽�?*/}
              <div 
                className="absolute inset-0"
                style={{
                  background: playerTheme === 'dark'
                    ? 'radial-gradient(circle at 20% 30%, rgba(255,255,255,0.08) 0%, transparent 50%)'
                    : 'radial-gradient(circle at 20% 30%, rgba(255,255,255,0.3) 0%, transparent 50%)',
                  pointerEvents: 'none',
                }}
              />
              {/* 左边框高�?*/}
              <div 
                className="absolute inset-y-0 left-0 w-px"
                style={{
                  background: playerTheme === 'dark'
                    ? 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.3), transparent)'
                    : 'linear-gradient(to bottom, transparent, rgba(0,0,0,0.2), transparent)',
                }}
              />
            </div>
            
            {/* 内容�?*/}
            <div className="relative z-10 h-full flex flex-col">
            {/* 头部 */}
            <div className={`flex items-center justify-between p-6 border-b ${
              playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
            }`}>
              <div className="flex items-center gap-3">
                <SettingsIcon className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                <h2 className={`text-2xl font-bold ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`}>设置</h2>
              </div>
              <button
                onClick={onClose}
                className={`p-2 rounded-full transition-colors ${
                  playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                }`}
              >
                <X className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white'/60 : 'text-black/60'}`} />
              </button>
            </div>

            {/* 标签�?*/}
            <div className={`flex border-b ${playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
              <button
                onClick={() => setActiveTab('account')}
                className={`flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'account'
                    ? playerTheme === 'dark'
                      ? 'text-white border-b-2 border-white'
                      : 'text-black border-b-2 border-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <User className="w-5 h-5" />
                账号
              </button>
              <button
                onClick={() => setActiveTab('personalization')}
                className={`flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'personalization'
                    ? playerTheme === 'dark'
                      ? 'text-white border-b-2 border-white'
                      : 'text-black border-b-2 border-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Sparkles className="w-5 h-5" />
                个性化
              </button>
              <button
                onClick={() => setActiveTab('advanced')}
                className={`flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'advanced'
                    ? playerTheme === 'dark'
                      ? 'text-white border-b-2 border-white'
                      : 'text-black border-b-2 border-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Palette className="w-5 h-5" />
                高级
              </button>
              <button
                onClick={() => setActiveTab('about')}
                className={`flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'about'
                    ? playerTheme === 'dark'
                      ? 'text-white border-b-2 border-white'
                      : 'text-black border-b-2 border-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Info className="w-5 h-5" />
                关于
              </button>
            </div>

            {/* 内容�?*/}
            <div className="p-6 overflow-y-auto h-[calc(100vh-140px)]">
              {activeTab === 'account' && (
                <div className="space-y-6">
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>音乐平台账号</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      登录后可以播放VIP歌曲、获取个人歌单
                    </p>
                    
                    <div className="space-y-4">
                      {/* 网易云登�?*/}
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-red-600 flex items-center justify-center">
                              <img 
                                src="https://s1.music.126.net/style/favicon.ico"
                                alt="网易云音乐"
                                className="w-6 h-6"
                                onError={(e) => {
                                  e.currentTarget.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext x='50' y='70' text-anchor='middle' fill='white' font-size='50' font-weight='bold'%3E网%3C/text%3E%3C/svg%3E"
                                }}
                              />
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>网易云音乐</div>
                              <div className={`${textTertiary} text-xs`}>支持二维码扫码登录</div>
                            </div>
                          </div>
                        </div>
                        <div className="mt-4">
                          <LoginButton
                            platform="netease"
                            isLoggedIn={neteaseLoggedIn}
                            username={neteaseUsername}
                            onLogin={onNeteaseLogin}
                            onLogout={onNeteaseLogout}
                          />
                        </div>
                      </div>

                      {/* QQ音乐登录 */}
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-green-600 flex items-center justify-center">
                              <img 
                                src="https://y.qq.com/favicon.ico"
                                alt="QQ音乐"
                                className="w-6 h-6"
                                onError={(e) => {
                                  e.currentTarget.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext x='50' y='70' text-anchor='middle' fill='white' font-size='45' font-weight='bold'%3EQQ%3C/text%3E%3C/svg%3E"
                                }}
                              />
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>QQ音乐</div>
                              <div className={`${textTertiary} text-xs`}>需要手动获取Cookie</div>
                            </div>
                          </div>
                        </div>
                        <div className="mt-4">
                          <LoginButton
                            platform="qq"
                            isLoggedIn={qqLoggedIn}
                            username={qqUsername}
                            onLogin={onQQLogin}
                            onLogout={onQQLogout}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'personalization' && (
                <div className="space-y-6">
                  {/* 首页自定义按钮 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>首页自定义</h3>
                    <button
                      onClick={() => setShowHomeCustomize(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} hover:bg-white/10 transition-all flex items-center justify-between group`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                          <Sparkles className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div className="text-left">
                          <div className={`${textPrimary} font-medium`}>自定义首页显示内容</div>
                          <div className={`${textSecondary} text-sm`}>
                            分别配置网易云和QQ音乐的推荐模块
                          </div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textTertiary} group-hover:translate-x-1 transition-transform`} />
                    </button>
                  </div>
                  
                  {/* 即将播放提示 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放提示</h3>
                    
                    {/* 即将播放提示开关 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>即将播放提示</div>
                          <div className={`${textSecondary} text-sm`}>
                            在歌曲结束前显示下一首歌曲信息
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={upNextEnabled}
                            onChange={(e) => handleUpNextToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full ${playerTheme === 'dark' ? 'peer-checked:after:border-white after:bg-white' : 'peer-checked:after:border-black after:bg-black'} after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: upNextEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {/* 秒数设置 */}
                      {upNextEnabled && (
                        <div className="pt-4 border-t" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          <div className="flex items-center justify-between">
                            <div className={`${textPrimary} text-sm font-medium`}>提前显示时间</div>
                            <div className="flex items-center gap-3">
                              <input
                                type="range"
                                min="5"
                                max="30"
                                value={upNextSeconds}
                                onChange={(e) => handleUpNextSecondsChange(parseInt(e.target.value))}
                                className="w-32 h-2 rounded-lg appearance-none cursor-pointer"
                                style={{
                                  background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${((upNextSeconds - 5) / 25) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} ${((upNextSeconds - 5) / 25) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} 100%)`
                                }}
                              />
                              <span className={`${textPrimary} text-sm font-medium w-12 text-right`}>{upNextSeconds}秒</span>
                            </div>
                          </div>
                          <div className={`${textTertiary} text-xs mt-2`}>
                            在歌曲结束前 {upNextSeconds} 秒显示下一首歌曲信息
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {/* 歌词翻译位置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>歌词翻译</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>翻译显示位置</div>
                        <div className={`${textSecondary} text-sm`}>
                          选择歌词翻译在播放界面的显示位置
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          onClick={() => {
                            setTranslationPosition('traditional')
                            localStorage.setItem('translationPosition', 'traditional')
                            window.dispatchEvent(new CustomEvent('translationPositionChanged', { detail: 'traditional' }))
                          }}
                          className={`p-4 rounded-xl transition-all border-2 ${
                            translationPosition === 'traditional'
                              ? 'border-2'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: translationPosition === 'traditional' ? accentColor : 'transparent',
                            backgroundColor: translationPosition === 'traditional' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} text-sm font-medium`}>传统</div>
                              <div className={`${textTertiary} text-xs mt-1`}>显示于歌词下方</div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => {
                            setTranslationPosition('bottom-right')
                            localStorage.setItem('translationPosition', 'bottom-right')
                            window.dispatchEvent(new CustomEvent('translationPositionChanged', { detail: 'bottom-right' }))
                          }}
                          className={`p-4 rounded-xl transition-all border-2 ${
                            translationPosition === 'bottom-right'
                              ? 'border-2'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: translationPosition === 'bottom-right' ? accentColor : 'transparent',
                            backgroundColor: translationPosition === 'bottom-right' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} text-sm font-medium`}>现代</div>
                              <div className={`${textTertiary} text-xs mt-1`}>右下角浮动显示</div>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {/* 主题色设置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>主题色</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>选择主题色</div>
                        <div className={`${textSecondary} text-sm`}>
                          自定义应用的强调色
                        </div>
                      </div>
                      
                      {/* 色板 */}
                      <div className="grid grid-cols-4 gap-3">
                        {presetColors.map((color) => (
                          <button
                            key={color.value}
                            onClick={() => handleAccentColorChange(color.value)}
                            className={`relative p-3 rounded-xl transition-all ${
                              accentColor === color.value 
                                ? 'ring-2 ring-offset-2 scale-105' 
                                : 'hover:scale-105'
                            }`}
                            style={{
                              backgroundColor: color.value,
                              ringColor: color.value,
                              ringOffsetColor: playerTheme === 'dark' ? '#000' : '#fff',
                            }}
                          >
                            <div className="aspect-square rounded-lg" />
                            {accentColor === color.value && (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <svg className="w-6 h-6 text-white drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                      
                      {/* 色块下方显示颜色名称 */}
                      <div className={`mt-3 text-center ${textSecondary} text-sm`}>
                        当前：{presetColors.find(c => c.value === accentColor)?.name || '自定义'}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 高级标签页 */}
              {activeTab === 'advanced' && (
                <div className="space-y-6">
                  {/* 第三方歌词源 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>第三方歌词源</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      启用后将从社区歌词库获取更丰富的歌词内容，包括逐字歌词和翻译
                    </p>
                    
                    {/* 启用第三方歌词源 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用第三方歌词源</div>
                          <div className={`${textSecondary} text-sm`}>
                            从 AMLL TTML DB 和 Lrclib 获取社区贡献的歌词
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={thirdPartyLyricsEnabled}
                            onChange={(e) => {
                              const enabled = e.target.checked
                              setThirdPartyLyricsEnabled(enabled)
                              localStorage.setItem('thirdPartyLyricsEnabled', JSON.stringify(enabled))
                            }}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: thirdPartyLyricsEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                    </div>

                    {/* 自适应最佳歌词 */}
                    {thirdPartyLyricsEnabled && (
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                        <div className="flex items-center justify-between">
                          <div>
                            <div className={`${textPrimary} font-medium mb-1`}>自适应最佳歌词</div>
                            <div className={`${textSecondary} text-sm`}>
                              自动适配最佳歌词源，若关闭将使用当前平台源
                            </div>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={adaptiveLyrics}
                              onChange={(e) => {
                                const enabled = e.target.checked
                                setAdaptiveLyrics(enabled)
                                localStorage.setItem('adaptiveLyrics', JSON.stringify(enabled))
                              }}
                              className="sr-only peer"
                            />
                            <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: adaptiveLyrics ? accentColor : '' }}></div>
                          </label>
                        </div>
                      </div>
                    )}

                    {/* 歌词库选择 */}
                    {thirdPartyLyricsEnabled && adaptiveLyrics && (
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                        <div className={`${textPrimary} font-medium mb-3`}>首要歌词库</div>
                        <div className={`${textSecondary} text-sm mb-4`}>
                          当多个歌词库都有歌词时，优先使用首要歌词库
                        </div>
                        
                        <div className="space-y-2">
                          {[
                            { key: 'AMLL', name: 'AMLL TTML DB', desc: '社区逐字歌词库（支持翻译）' },
                            { key: 'NetEase', name: '网易云音乐', desc: '官方歌词（支持逐字）' },
                            { key: 'QQMusic', name: 'QQ音乐', desc: '官方歌词' },
                            { key: 'Platform', name: '当前平台', desc: '使用正在播放的平台' }
                          ].map((source) => (
                            <button
                              key={source.key}
                              onClick={() => {
                                setPrimaryLyricsSource(source.key)
                                localStorage.setItem('primaryLyricsSource', source.key)
                              }}
                              className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors border-2 ${
                                primaryLyricsSource === source.key
                                  ? playerTheme === 'dark'
                                    ? 'bg-white/5 hover:bg-white/10'
                                    : 'bg-black/5 hover:bg-black/10'
                                  : playerTheme === 'dark'
                                  ? 'bg-white/5 hover:bg-white/10 border-transparent'
                                  : 'bg-black/5 hover:bg-black/10 border-transparent'
                              }`}
                              style={{
                                borderColor: primaryLyricsSource === source.key ? accentColor : 'transparent',
                                backgroundColor: primaryLyricsSource === source.key 
                                  ? `${accentColor}20`
                                  : ''
                              }}
                            >
                              <div 
                                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center`}
                                style={{
                                  borderColor: primaryLyricsSource === source.key 
                                    ? accentColor 
                                    : playerTheme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
                                  backgroundColor: primaryLyricsSource === source.key ? accentColor : 'transparent'
                                }}
                              >
                                {primaryLyricsSource === source.key && (
                                  <div className="w-2 h-2 rounded-full bg-white"></div>
                                )}
                              </div>
                              <div className="flex-1 text-left">
                                <div className={`${textPrimary} text-sm font-medium`}>{source.name}</div>
                                <div className={`${textTertiary} text-xs`}>{source.desc}</div>
                              </div>
                              {primaryLyricsSource === source.key && (
                                <div 
                                  className={`px-2 py-1 rounded ${textPrimary} text-xs font-medium`}
                                  style={{ backgroundColor: `${accentColor}50` }}
                                >
                                  首选
                                </div>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {/* 缓存清理 */}
                  <div className="mt-8">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>缓存管理</h3>
                    <button
                      onClick={() => setShowCacheClear(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} hover:bg-white/10 transition-all text-left`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div 
                            className="w-10 h-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: `${accentColor}20` }}
                          >
                            <Trash2 className="w-5 h-5" style={{ color: accentColor }} />
                          </div>
                          <div>
                            <div className={`${textPrimary} font-medium mb-1`}>缓存清理</div>
                            <div className={`${textSecondary} text-sm`}>
                              管理封面、歌单列表和错误日志缓存
                            </div>
                          </div>
                        </div>
                        <ChevronRight className={`w-5 h-5 ${textSecondary}`} />
                      </div>
                    </button>
                  </div>
                </div>
              )}

              {/* 关于标签页 */}
              {activeTab === 'about' && (
                <div className="space-y-8">
                  {/* Logo和软件信息 */}
                  <div className="flex flex-col items-center text-center space-y-4">
                    {/* Logo */}
                    <div className={`w-24 h-24 rounded-3xl ${playerTheme === 'dark' ? 'bg-gradient-to-br from-pink-500 to-purple-600' : 'bg-gradient-to-br from-pink-400 to-purple-500'} flex items-center justify-center shadow-lg`}>
                      <svg className="w-14 h-14 text-white" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                      </svg>
                    </div>
                    
                    {/* 软件名称 */}
                    <div>
                      <h2 className={`text-3xl font-bold ${textPrimary} mb-2`}>WaveForge</h2>
                      <p className={`${textSecondary} text-sm`}>开发者：Yoshino</p>
                    </div>
                  </div>

                  {/* 项目链接 */}
                  <div className={`${bgCard} rounded-xl p-4 border ${borderColor} space-y-2`}>
                    <button
                      onClick={() => window.open('https://github.com/YoshinoRinn/WaveForge', '_blank')}
                      className={`w-full flex items-center justify-between p-4 rounded-lg ${hoverBg} transition-colors`}
                    >
                      <div className="flex items-center gap-3">
                        <Github className={`w-5 h-5 ${textPrimary}`} />
                        <span className={`${textPrimary} font-medium`}>GitHub 仓库</span>
                      </div>
                      <ExternalLink className={`w-4 h-4 ${textSecondary}`} />
                    </button>
                    
                    <button
                      onClick={() => window.open('https://gitee.com/kirito666233/wave-forge', '_blank')}
                      className={`w-full flex items-center justify-between p-4 rounded-lg ${hoverBg} transition-colors`}
                    >
                      <div className="flex items-center gap-3">
                        <svg className={`w-5 h-5 ${textPrimary}`} viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 2.247a10 10 0 0 0-3.162 19.487c.5.088.687-.212.687-.475 0-.237-.012-1.025-.012-1.862-2.513.462-3.163-.613-3.363-1.175a3.636 3.636 0 0 0-1.025-1.413c-.35-.187-.85-.65-.013-.662a2.001 2.001 0 0 1 1.538 1.025 2.137 2.137 0 0 0 2.912.825 2.104 2.104 0 0 1 .638-1.338c-2.225-.25-4.55-1.112-4.55-4.937a3.892 3.892 0 0 1 1.025-2.688 3.594 3.594 0 0 1 .1-2.65s.837-.262 2.75 1.025a9.427 9.427 0 0 1 5 0c1.912-1.3 2.75-1.025 2.75-1.025a3.593 3.593 0 0 1 .1 2.65 3.869 3.869 0 0 1 1.025 2.688c0 3.837-2.338 4.687-4.562 4.937a2.368 2.368 0 0 1 .675 1.85c0 1.338-.012 2.413-.012 2.75 0 .263.187.575.687.475A10.005 10.005 0 0 0 12 2.247z"/>
                        </svg>
                        <span className={`${textPrimary} font-medium`}>Gitee 仓库</span>
                      </div>
                      <ExternalLink className={`w-4 h-4 ${textSecondary}`} />
                    </button>
                  </div>

                  {/* 版本信息 */}
                  <div className={`${bgCard} rounded-xl p-6 border ${borderColor}`}>
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <p className={`${textSecondary} text-sm mb-1`}>当前版本</p>
                        <p className={`${textPrimary} text-2xl font-bold`}>v0.0.1 Beta</p>
                      </div>
                    </div>
                    
                    <button
                      onClick={() => {
                        // TODO: 实现版本检查逻辑
                        alert('当前已是最新版本！')
                      }}
                      className={`w-full py-3 px-4 rounded-lg ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/15' : 'bg-black/10 hover:bg-black/15'} ${textPrimary} font-medium transition-colors`}
                    >
                      检查新版本
                    </button>
                  </div>

                  {/* 版权信息 */}
                  <div className="text-center">
                    <p className={`${textTertiary} text-xs`}>
                      © 2026 WaveForge. All rights reserved.
                    </p>
                  </div>
                </div>
              )}
            </div>
            </div> {/* 关闭内容层 div from line 144 */}
          </motion.div>
        </>
      )}
      
      {/* 首页自定义弹窗 */}
      <HomeCustomizeModal 
        show={showHomeCustomize}
        onClose={() => setShowHomeCustomize(false)}
        playerTheme={playerTheme}
      />
      
      {/* 缓存清理弹窗 */}
      <CacheClearModal 
        show={showCacheClear}
        onClose={() => setShowCacheClear(false)}
        playerTheme={playerTheme}
      />
    </AnimatePresence>
  )
}

