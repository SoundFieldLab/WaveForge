import { useState } from 'react'
import { User, LogOut } from 'lucide-react'
import { motion } from 'framer-motion'
import type { MusicPlatform } from '../services/platforms'
import type { AppleUserInfo } from '../services/appleAuth'
import LoginPanel from './LoginPanel'
import QQLoginPanel from './QQLoginPanel'
import AppleLoginPanel from './AppleLoginPanel'
import KugouLoginPanel from './KugouLoginPanel'
import SpotifyLoginPanel from './SpotifyLoginPanel'
import SodaLoginPanel from './SodaLoginPanel'

interface LoginButtonProps {
  platform: MusicPlatform
  isLoggedIn: boolean
  username?: string
  onLogin: (cookie: string, username?: string) => void
  onLogout: () => void
  /** Apple 登录成功/退出的回调（user 为 null 表示面板内退出） */
  onAppleLogin?: (user: AppleUserInfo | null) => void
  playerTheme?: 'light' | 'dark'
}

export default function LoginButton({ platform, isLoggedIn, username, onLogin, onLogout, onAppleLogin, playerTheme = 'dark' }: LoginButtonProps) {
  const [showLoginPanel, setShowLoginPanel] = useState(false)
  
  const platformName = platform === 'netease' ? '网易云' : platform === 'qq' ? 'QQ音乐' : platform === 'apple' ? 'Apple Music' : platform === 'spotify' ? 'Spotify' : platform === 'kugou' ? '酷狗音乐' : '汽水音乐'
  const platformColor = platform === 'netease'
    ? 'bg-red-600 hover:bg-red-700'
    : platform === 'qq'
      ? 'bg-green-600 hover:bg-green-700'
      : platform === 'apple'
        ? 'bg-pink-600 hover:bg-pink-700'
        : platform === 'spotify'
          ? 'bg-[#1DB954] hover:bg-[#17a74b]'
          : platform === 'kugou'
            ? 'bg-orange-500 hover:bg-orange-600'
            : 'bg-sky-500 hover:bg-sky-600'

  const handleLoginSuccess = (cookie: string, extraUsername?: string) => {
    onLogin(cookie, extraUsername)
    setShowLoginPanel(false)
  }

  return (
    <>
      {isLoggedIn ? (
        <motion.div
          whileHover={{ scale: 1.05 }}
          className={`flex items-center gap-3 px-4 py-2 rounded-full ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}
        >
          <div className="flex items-center gap-2">
            <User className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`} />
            <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>{username || platformName}</span>
          </div>
          <button
            onClick={onLogout}
            className={`p-1 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
            title="登出"
          >
            <LogOut className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`} />
          </button>
        </motion.div>
      ) : (
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setShowLoginPanel(true)}
          className={`px-4 py-2 ${platformColor} text-white rounded-full text-sm font-medium transition-colors flex items-center gap-2`}
        >
          <User className="w-4 h-4" />
          登录{platformName}
        </motion.button>
      )}

      {showLoginPanel && platform === 'netease' && (
        <LoginPanel
          platform={platform}
          onClose={() => setShowLoginPanel(false)}
          onLoginSuccess={handleLoginSuccess}
        />
      )}

      {showLoginPanel && platform === 'qq' && (
        <QQLoginPanel
          onClose={() => setShowLoginPanel(false)}
          onLoginSuccess={handleLoginSuccess}
        />
      )}

      {showLoginPanel && platform === 'apple' && (
        <AppleLoginPanel
          accentColor="#fa2d48"
          onClose={() => setShowLoginPanel(false)}
          onLoginSuccess={(user) => {
            onAppleLogin?.(user)
            setShowLoginPanel(false)
          }}
        />
      )}

      {showLoginPanel && platform === 'kugou' && (
        <KugouLoginPanel
          onClose={() => setShowLoginPanel(false)}
          onLoginSuccess={handleLoginSuccess}
        />
      )}

      {showLoginPanel && platform === 'spotify' && (
        <SpotifyLoginPanel
          onClose={() => setShowLoginPanel(false)}
          onLoginSuccess={(username) => {
            onLogin('spotify-logged', username)
            setShowLoginPanel(false)
          }}
        />
      )}

      {showLoginPanel && platform === 'soda' && (
        <SodaLoginPanel
          onClose={() => setShowLoginPanel(false)}
          onLoginSuccess={(token) => {
            onLogin(token)
            setShowLoginPanel(false)
          }}
        />
      )}
    </>
  )
}

