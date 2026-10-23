import { motion, AnimatePresence } from 'framer-motion'

interface TranslationDisplayProps {
  translation: string
  show: boolean
  songId?: string | number // 添加歌曲ID作为key
  /** 当前行的和声翻译：非空时在主翻译药丸旁显示第二枚（和声）药丸 */
  vocalTranslation?: string
}

export default function TranslationDisplay({ translation, show, songId, vocalTranslation }: TranslationDisplayProps) {
  const vocalText = (vocalTranslation ?? '').trim()
  return (
    <AnimatePresence mode="wait">
      {show && (translation && translation.trim() !== '' && translation.trim() !== '//' || vocalText) && (
        <motion.div
          key={`translation-${songId}`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className="fixed bottom-8 z-30 flex items-center gap-2.5"
          style={{
            left: 'calc(50% + 360px)', // 调整位置，避免与进度条重叠
            width: 'auto',
            maxWidth: 'calc(50% - 400px)', // 确保不超出屏幕
            minWidth: '280px' // 增加最小宽度
          }}
        >
          {translation && translation.trim() !== '' && translation.trim() !== '//' && (
            <div
              className="rounded-full border px-6 py-3 shadow-2xl" // 改为 rounded-full 药丸形状
              style={{
                background: 'rgba(0, 0, 0, 0.7)',
                backdropFilter: 'blur(40px) saturate(180%)',
                WebkitBackdropFilter: 'blur(40px) saturate(180%)',
                borderColor: 'rgba(255, 255, 255, 0.2)',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
                flex: vocalText ? '1 1 0' : undefined,
                minWidth: 0,
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
          )}
          {/* 和声翻译药丸：当前行有和声时并排显示（主药丸旁），标注「和声」区分来源 */}
          {vocalText && (
            <div
              className="rounded-full border px-5 py-3 shadow-2xl"
              style={{
                background: 'rgba(0, 0, 0, 0.6)',
                backdropFilter: 'blur(40px) saturate(180%)',
                WebkitBackdropFilter: 'blur(40px) saturate(180%)',
                borderColor: 'rgba(255, 255, 255, 0.14)',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1)',
                flex: '1 1 0',
                minWidth: 0,
              }}
            >
              <div
                className="flex items-center gap-2"
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  writingMode: 'horizontal-tb'
                }}
              >
                <span
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ background: 'rgba(255, 255, 255, 0.14)', color: 'rgba(255, 255, 255, 0.6)' }}
                >
                  和声
                </span>
                <span className="truncate text-white/72 text-[15px] leading-snug">{vocalText}</span>
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
