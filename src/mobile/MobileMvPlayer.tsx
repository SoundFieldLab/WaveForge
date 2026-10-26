/**
 * 移动端全屏 MV 播放器：video 元素 + 进度/暂停 + 关闭（下滑关闭与 BACK）。
 * 取流走 getMVPlaybackInfo 的代理 URL（由调用方解析后传入 url）。
 */
import { memo, useEffect, useRef, useState } from 'react'
import type { MobileMvTarget } from './nav'
import { useMobileBack } from './mobileBack'
import { IconClose, IconPause, IconPlay, fmtTime } from './ui'

export default memo(function MobileMvPlayer({ target, onClose }: { target: MobileMvTarget; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [paused, setPaused] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState('')

  useMobileBack(() => { onClose(); return true }, [onClose])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.play().catch(() => setPaused(true))
  }, [target.url])

  return (
    <div className="wf-m-mv">
      <video
        ref={videoRef}
        className="wf-m-mv-video"
        src={target.url}
        playsInline
        onClick={() => {
          const v = videoRef.current
          if (!v) return
          if (v.paused) { void v.play(); setPaused(false) } else { v.pause(); setPaused(true) }
        }}
        onTimeUpdate={e => setTime(e.currentTarget.currentTime)}
        onDurationChange={e => setDuration(e.currentTarget.duration || 0)}
        onEnded={onClose}
        onError={() => setError('MV 播放失败（格式或网络不支持）')}
      />
      <header className="wf-m-mv-head">
        <button type="button" className="wf-m-iconbtn" onClick={onClose}><IconClose size={22} /></button>
        <div className="wf-m-mv-title">
          <span>{target.title}</span>
          {target.artist && <em>{target.artist}</em>}
        </div>
        <span style={{ width: 44 }} />
      </header>
      {paused && !error && (
        <button type="button" className="wf-m-mv-centerbtn" onClick={() => { void videoRef.current?.play(); setPaused(false) }}>
          <IconPlay size={40} />
        </button>
      )}
      {error && <div className="wf-m-mv-error">{error}</div>}
      {!error && (
        <footer className="wf-m-mv-foot">
          <span className="wf-m-time">{fmtTime(time)}</span>
          <input
            className="wf-m-slider wf-m-slider-seek"
            type="range" min={0} max={Math.max(1, Math.floor(duration))} step={1}
            value={Math.floor(time)}
            onChange={e => {
              const v = videoRef.current
              if (v) { v.currentTime = Number(e.target.value); setTime(Number(e.target.value)) }
            }}
          />
          <span className="wf-m-time">{duration > 0 ? fmtTime(duration) : '--:--'}</span>
          <button type="button" className="wf-m-iconbtn" onClick={() => {
            const v = videoRef.current
            if (!v) return
            if (v.paused) { void v.play(); setPaused(false) } else { v.pause(); setPaused(true) }
          }}>
            {paused ? <IconPlay size={22} /> : <IconPause size={22} />}
          </button>
        </footer>
      )}
    </div>
  )
})
