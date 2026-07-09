import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useState } from 'react'

interface TranslationDisplayProps {
  translation: string
  show: boolean
  songId?: string | number // 添加歌曲ID作为key
}

export default function TranslationDisplay({ translation, show, songId }: TranslationDisplayProps) {
  return (
    <AnimatePresence mode="wait">
      {show && translation && (
        <motion.div
          key={`translation-${songId}`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="fixed bottom-8 z-30"
          style={{ 
            left: 'calc(50% + 360px)', // 调整位置，避免与进度条重叠
            width: 'auto',
            maxWidth: 'calc(50% - 400px)', // 确保不超出屏幕
            minWidth: '280px' // 增加最小宽度
          }}
        >
          <div
            className="rounded-full border px-6 py-3 shadow-2xl" // 改为 rounded-full 药丸形状
            style={{
              background: 'rgba(0, 0, 0, 0.7)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
              borderColor: 'rgba(255, 255, 255, 0.2)',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
            }}
          >
            <div 
              className="text-white/90 text-base leading-snug text-center"
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                writingMode: 'horizontal-tb'
              }}
            >
              {translation}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
