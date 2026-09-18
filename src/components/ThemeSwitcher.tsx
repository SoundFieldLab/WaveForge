import { motion } from 'framer-motion'
import { Palette } from 'lucide-react'
import { ThemeType, THEMES } from '../types/theme'

interface ThemeSwitcherProps {
  currentTheme: ThemeType
  onThemeChange: (theme: ThemeType) => void
}

export default function ThemeSwitcher({ currentTheme, onThemeChange }: ThemeSwitcherProps) {
  return (
    <div className="fixed top-6 right-6 z-50">
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-black/40 backdrop-blur-xl rounded-2xl p-4 shadow-2xl"
      >
        <div className="flex items-center gap-3 mb-3">
          <Palette className="w-5 h-5 text-white/70" />
          <h3 className="text-white/70 text-sm font-medium">主题</h3>
        </div>
        
        <div className="flex gap-2">
          {THEMES.map((theme) => (
            <motion.button
              key={theme.id}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => onThemeChange(theme.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                currentTheme === theme.id
                  ? 'bg-white text-black'
                  : 'bg-white/10 text-white/60 hover:bg-white/20'
              }`}
              title={theme.description}
            >
              {theme.name}
            </motion.button>
          ))}
        </div>
      </motion.div>
    </div>
  )
}
