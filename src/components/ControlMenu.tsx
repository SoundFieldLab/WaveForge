import { useState } from 'react'
import { motion } from 'framer-motion'
import { Settings, User, Menu } from 'lucide-react'

interface ControlMenuProps {
  onSettingsClick: () => void
  onProfileClick: () => void
}

export default function ControlMenu({ onSettingsClick, onProfileClick }: ControlMenuProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  return (
    <div 
      className="relative inline-flex"
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      {/* 容器 - 增强液态玻璃效果 */}
      <div 
        className="flex items-center gap-2 p-1.5 rounded-full shadow-2xl relative overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, rgba(15,15,25,0.75) 0%, rgba(0,0,0,0.85) 100%)',
          backdropFilter: 'blur(60px) saturate(180%)',
          WebkitBackdropFilter: 'blur(60px) saturate(180%)',
          border: '1px solid rgba(255,255,255,0.2)',
          boxShadow: '0 8px 32px 0 rgba(0,0,0,0.5), inset 0 1px 2px rgba(255,255,255,0.15), 0 0 0 1px rgba(255,255,255,0.05)',
        }}
      >
        {/* 动态光晕 */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none opacity-60"
          style={{
            background: 'radial-gradient(circle at 25% 25%, rgba(100,150,255,0.15) 0%, transparent 50%)',
            animation: 'pulse 3s ease-in-out infinite',
          }}
        />
        
        {/* 顶部高光 */}
        <div
          className="absolute top-0 left-0 right-0 h-1/2 rounded-full pointer-events-none"
          style={{
            background: 'linear-gradient(180deg, rgba(255,255,255,0.15) 0%, transparent 100%)',
          }}
        />
        {/* 个人中心按钮 - 展开时显示 */}
        <motion.button
          initial={false}
          animate={{
            width: isExpanded ? 'auto' : 0,
            opacity: isExpanded ? 1 : 0,
            marginRight: isExpanded ? '0.25rem' : 0,
          }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          onClick={onProfileClick}
          className="relative z-10 p-2.5 hover:bg-white/5 rounded-full transition-colors overflow-hidden"
          style={{ display: isExpanded ? 'block' : 'none' }}
          title="个人中心"
        >
          <User className="w-4.5 h-4.5 text-white" />
        </motion.button>

        {/* 设置按钮 - 展开时显示 */}
        <motion.button
          initial={false}
          animate={{
            width: isExpanded ? 'auto' : 0,
            opacity: isExpanded ? 1 : 0,
            marginRight: isExpanded ? '0.25rem' : 0,
          }}
          transition={{ duration: 0.2, ease: 'easeOut', delay: 0.05 }}
          onClick={onSettingsClick}
          className="relative z-10 p-2.5 hover:bg-white/5 rounded-full transition-colors overflow-hidden"
          style={{ display: isExpanded ? 'block' : 'none' }}
          title="设置"
        >
          <Settings className="w-4.5 h-4.5 text-white" />
        </motion.button>

        {/* 菜单按钮 - 始终显示 */}
        <button
          className="relative z-10 p-2.5 hover:bg-white/5 rounded-full transition-all duration-200 hover:scale-110"
          title={isExpanded ? "收起" : "菜单"}
        >
          <Menu className="w-5 h-5 text-white" />
        </button>
      </div>
    </div>
  )
}
