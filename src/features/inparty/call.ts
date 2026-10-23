/**
 * In Party 摄像头广播：直接把摄像头画面「开播」给全房间。
 *
 * 与传统 1v1 通话的差异（产品语义）：
 *  - 广播模型：我开摄像头 = 我向房间声明 cam-start，房间名册出现我；想看的人对发起 WebRTC 连接拉流；
 *  - 安全倒计时：开播时可设自动停止（0/60/180/600s），观众视角能看到剩余时间；
 *  - 一键全黑：不关流、不发通知，画面立刻替换为黑帧（「已遮蔽」），可随时恢复；
 *  - 设置中心可配快捷键（默认 Ctrl+Shift+Z）本地全黑/恢复。
 *
 * 拉流方：watch(broadcasterPeerId) → 发 call-signal offer → 对方 answer → ICE 打洞。
 * 发布方：收到任意 offer 都接受（同房间成员），挂断对应 cam-stop。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CameraBroadcaster } from './model'
import type { InPartySession } from './session'

const ICE_SERVERS: RTCConfiguration = {
  // 纯 P2P：STUN 帮助跨网打洞（只交换连接候选，不经媒体）
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 4,
}

export interface CameraState {
  /** 我在开播（已声明 cam-start） */
  broadcasting: boolean
  /** 开播前倒计时剩余秒数（0=不在倒计时） */
  countdownRemaining: number
  /** 本地 MediaStream（开播中有；blanked 时 video 轨被替换为黑帧） */
  stream: MediaStream | null
  /** 一键全黑状态 */
  blanked: boolean
  /** 自动停止的剩余秒数（0=不倒计时；开播中每秒递减，到 0 自动停） */
  autoStopRemaining: number
  /** 我正在观看的广播者（peerId → 远端流） */
  watching: Map<string, MediaStream>
  error: string
}

/** 图片压缩：超过 maxEdge 的长边缩到 maxEdge，输出 JPEG；返回 {dataUrl, width, height} */
export async function compressImage(file: File, maxEdge = 2048, quality = 0.82): Promise<{ dataUrl: string; compressed: boolean }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = dataUrl
  })
  const longest = Math.max(image.width, image.height)
  if (longest <= maxEdge && file.size <= 1.5 * 1024 * 1024) {
    return { dataUrl, compressed: false } // 小图直传
  }
  const scale = longest > maxEdge ? maxEdge / longest : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return { dataUrl, compressed: false }
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), compressed: true }
}

export function useCameraBroadcast(session: InPartySession, enabled: boolean, defaultAutoStop: number) {
  const [state, setState] = useState<CameraState>({
    broadcasting: false, countdownRemaining: 0, stream: null, blanked: false, autoStopRemaining: 0,
    watching: new Map(), error: '',
  })
  const countdownRef = useRef<number | null>(null)
  const pcMapRef = useRef<Map<string, RTCPeerConnection>>(new Map()) // 观看连接：peerId → pc
  const viewerPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map()) // 拉我流的观众：peerId → pc
  const streamRef = useRef<MediaStream | null>(null)
  const blankCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const blankTimerRef = useRef<number | null>(null)
  const autoStopRef = useRef<number>(0)

  /** 生成黑帧 canvas 轨（一键全黑：不关流，仅替换画面） */
  const makeBlankTrack = (): CanvasCaptureMediaStreamTrack => {
    if (!blankCanvasRef.current) {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 480
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.font = '28px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText('已遮蔽', canvas.width / 2, canvas.height / 2)
      }
      blankCanvasRef.current = canvas
    }
    const stream = blankCanvasRef.current.captureStream(2)
    return stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack
  }

  const stopBroadcast = useCallback((announce = true) => {
    if (countdownRef.current) { window.clearInterval(countdownRef.current); countdownRef.current = null }
    if (blankTimerRef.current) { window.clearInterval(blankTimerRef.current); blankTimerRef.current = null }
    setState(previous => ({ ...previous, countdownRemaining: 0 }))
    for (const pc of viewerPcsRef.current.values()) { try { pc.close() } catch { /* ignore */ } }
    viewerPcsRef.current.clear()
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    blankCanvasRef.current = null
    setState(previous => ({ ...previous, broadcasting: false, stream: null, blanked: false, autoStopRemaining: 0 }))
    if (announce) session.stopCameraBroadcast()
  }, [session])

  /** 开播前倒计时（3-2-1，给整理仪容/构图的时间；countdownRemaining>0 表示在倒计时） */
  const startCountdown = useCallback((autoStopSec: number) => {
    if (!enabled) { setState(previous => ({ ...previous, error: '视频已在设置中关闭' })); return }
    let remaining = 3
    setState(previous => ({ ...previous, countdownRemaining: remaining, error: '' }))
    if (countdownRef.current) window.clearInterval(countdownRef.current)
    countdownRef.current = window.setInterval(() => {
      remaining -= 1
      if (remaining <= 0) {
        if (countdownRef.current) { window.clearInterval(countdownRef.current); countdownRef.current = null }
        setState(previous => ({ ...previous, countdownRemaining: 0 }))
        void startBroadcastInternal(autoStopSec)
        return
      }
      setState(previous => ({ ...previous, countdownRemaining: remaining }))
    }, 1000)
  }, [enabled])

  /** 取消倒计时 */
  const cancelCountdown = useCallback(() => {
    if (countdownRef.current) { window.clearInterval(countdownRef.current); countdownRef.current = null }
    setState(previous => ({ ...previous, countdownRemaining: 0 }))
  }, [])

  const startBroadcastInternal = useCallback(async (autoStopSec: number) => {
    if (!enabled) { setState(previous => ({ ...previous, error: '视频已在设置中关闭' })); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false })
      streamRef.current = stream
      autoStopRef.current = autoStopSec
      setState(previous => ({ ...previous, broadcasting: true, stream, blanked: false, autoStopRemaining: autoStopSec, error: '' }))
      session.startCameraBroadcast(autoStopSec)
      // 安全倒计时
      if (autoStopSec > 0) {
        if (blankTimerRef.current) window.clearInterval(blankTimerRef.current)
        let remaining = autoStopSec
        blankTimerRef.current = window.setInterval(() => {
          remaining -= 1
          if (remaining <= 0) { stopBroadcast(true); return }
          setState(previous => previous.broadcasting ? { ...previous, autoStopRemaining: remaining } : previous)
        }, 1000)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState(previous => ({ ...previous, error: /Permission|NotAllowed/i.test(message) ? '摄像头权限被拒绝' : '无法打开摄像头' }))
    }
  }, [enabled, session, stopBroadcast])

  // 对外「开摄像头」入口 = 倒计时入口
  const startBroadcast = startCountdown

  /** 一键全黑：替换发送中的视频轨为黑帧（所有观众连接立即生效） */
  const toggleBlank = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    const next = !state.blanked
    const sender = viewerPcsRef.current.size
    void sender
    if (next) {
      const blank = makeBlankTrack()
      stream.getVideoTracks().forEach(track => { try { track.stop() } catch { /* ignore */ } })
      stream.removeTrack(stream.getVideoTracks()[0])
      stream.addTrack(blank)
    } else {
      // 恢复：重新拿摄像头（权限通常还有，静默失败就全黑退出）
      void navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false })
        .then(fresh => {
          const track = fresh.getVideoTracks()[0]
          stream.addTrack(track)
        })
        .catch(() => stopBroadcast(true))
    }
    setState(previous => ({ ...previous, blanked: next }))
    session.setCameraBlanked(next)
  }, [session, state.blanked, stopBroadcast])

  /** 观看某位广播者：发 offer 拉流 */
  const watch = useCallback(async (peerId: string) => {
    if (state.watching.has(peerId)) return
    try {
      const pc = new RTCPeerConnection(ICE_SERVERS)
      pcMapRef.current.set(peerId, pc)
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.addTransceiver('audio', { direction: 'recvonly' })
      pc.ontrack = (event) => {
        const [stream] = event.streams
        if (stream) {
          setState(previous => ({ ...previous, watching: new Map(previous.watching).set(peerId, stream) }))
        }
      }
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          session.sendCallSignal(peerId, {
            t: 'ice',
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid ?? undefined,
            sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
          })
        }
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      session.sendCallSignal(peerId, { t: 'offer', sdp: offer.sdp || '' })
    } catch (error) {
      setState(previous => ({ ...previous, error: `连接失败：${error instanceof Error ? error.message : String(error)}` }))
      pcMapRef.current.get(peerId)?.close()
      pcMapRef.current.delete(peerId)
    }
  }, [session, state.watching])

  const unwatch = useCallback((peerId: string) => {
    pcMapRef.current.get(peerId)?.close()
    pcMapRef.current.delete(peerId)
    setState(previous => {
      const watching = new Map(previous.watching)
      watching.delete(peerId)
      return { ...previous, watching }
    })
  }, [])

  // 消费信令：观看侧 answer/ice；发布侧 offer（观众来拉流）→ 建发送连接。
  // consumedUpToRef 追踪已处理下标：session 只追加不清，这里负责「每个信封只处理一次」
  const consumedUpToRef = useRef(-1)
  useEffect(() => {
    return session.subscribe(() => {
      const snapshot = session.getSnapshot()
      for (let index = consumedUpToRef.current + 1; index < snapshot.callSignals.length; index += 1) {
        consumedUpToRef.current = index
        const { from, signal } = snapshot.callSignals[index]
        if (signal.t === 'offer') {
          // 观众拉我的流：建发送 pc
          const existing = viewerPcsRef.current.get(from)
          if (existing) { try { existing.close() } catch { /* ignore */ } }
          void (async () => {
            const pc = new RTCPeerConnection(ICE_SERVERS)
            viewerPcsRef.current.set(from, pc)
            const stream = streamRef.current
            if (stream) for (const track of stream.getTracks()) pc.addTrack(track, stream)
            pc.onicecandidate = (event) => {
              if (event.candidate) {
                session.sendCallSignal(from, {
                  t: 'ice',
                  candidate: event.candidate.candidate,
                  sdpMid: event.candidate.sdpMid ?? undefined,
                  sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
                })
              }
            }
            pc.onconnectionstatechange = () => {
              if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                viewerPcsRef.current.delete(from)
              }
            }
            try {
              await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
              const answer = await pc.createAnswer()
              await pc.setLocalDescription(answer)
              session.sendCallSignal(from, { t: 'answer', sdp: answer.sdp || '' })
            } catch { /* offer 坏包：忽略 */ }
          })()
        } else if (signal.t === 'answer') {
          const pc = pcMapRef.current.get(from)
          if (pc) void pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp }).catch(() => undefined)
        } else if (signal.t === 'ice') {
          const pc = pcMapRef.current.get(from) ?? viewerPcsRef.current.get(from)
          if (pc) void pc.addIceCandidate({ candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex }).catch(() => undefined)
        }
      }
    })
  }, [session])

  // 名册里我消失了（被踢/离房）→ 停流
  useEffect(() => {
    const stillThere = session.getSnapshot().broadcasters.some(b => b.peerId === session.getProfile()?.peerId)
    if (!stillThere && state.broadcasting) stopBroadcast(false)
  }, [session, state.broadcasting, stopBroadcast])

  // 卸载兜底
  useEffect(() => () => {
    if (blankTimerRef.current) window.clearInterval(blankTimerRef.current)
    for (const pc of [...pcMapRef.current.values(), ...viewerPcsRef.current.values()]) { try { pc.close() } catch { /* ignore */ } }
    streamRef.current?.getTracks().forEach(track => track.stop())
  }, [])

  return { cameraState: state, startBroadcast, cancelCountdown, stopBroadcast, toggleBlank, watch, unwatch }
}

/* ═══════════════════════ 语音房（连麦） ═══════════════════════
 *
 * 与摄像头广播同构的「语音版」：我开麦 = 向房间声明 voice-start，全员可听到我；
 * 房间名册显示麦克风状态与说话指示（AnalyserNode 实时电平）。
 * 音频流走 WebRTC 点对点（同摄像头：想听的人对发布方发 offer 拉流）。
 */

export interface VoiceState {
  /** 我在语音房 */
  inVoice: boolean
  /** 本地麦克风流（静音时 track.enabled=false） */
  stream: MediaStream | null
  muted: boolean
  /** 我当前说话电平 0-1（说话指示） */
  speakingLevel: number
  /** 我正在收听的人（peerId → 流） */
  listening: Map<string, MediaStream>
  /** 谁在说话（peerId → 电平；说话指示高亮用） */
  speakingPeers: Record<string, number>
  error: string
}

interface VoiceAnnounce {
  peerId: string
  nickname: string
  avatarEmoji: string
}

export function useVoiceRoom(session: InPartySession, enabled: boolean, options?: { autoListen?: boolean }) {
  const autoListen = options?.autoListen !== false
  const [state, setState] = useState<VoiceState>({
    inVoice: false, stream: null, muted: false, speakingLevel: 0, listening: new Map(), speakingPeers: {}, error: '',
  })
  const peerAnalysersRef = useRef<Map<string, { ctx: AudioContext; analyser: AnalyserNode; buf: Uint8Array }>>(new Map())
  const pcMapRef = useRef<Map<string, RTCPeerConnection>>(new Map()) // 我听别人
  const listenerPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map()) // 别人听我
  const streamRef = useRef<MediaStream | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const levelTimerRef = useRef<number | null>(null)
  const levelBufRef = useRef<Uint8Array | null>(null)
  const meterCtxRef = useRef<AudioContext | null>(null)
  const pendingListenRef = useRef<Set<string>>(new Set())

  const stopLevelMeter = () => {
    if (levelTimerRef.current) { window.clearInterval(levelTimerRef.current); levelTimerRef.current = null }
    analyserRef.current = null
    // 本地 meter 的 AudioContext 一并关闭（否则每次上麦泄漏一个）
    if (meterCtxRef.current) { try { void meterCtxRef.current.close() } catch { /* ignore */ } meterCtxRef.current = null }
    for (const entry of peerAnalysersRef.current.values()) { try { void entry.ctx.close() } catch { /* ignore */ } }
    peerAnalysersRef.current.clear()
  }

  const startLevelMeter = () => {
    stopLevelMeter()
    const stream = streamRef.current
    if (!stream) return
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      meterCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyserRef.current = analyser
      levelTimerRef.current = window.setInterval(() => {
        const node = analyserRef.current
        let level = 0
        if (node) {
          if (!levelBufRef.current || levelBufRef.current.length !== node.frequencyBinCount) levelBufRef.current = new Uint8Array(node.frequencyBinCount)
          node.getByteFrequencyData(levelBufRef.current)
          let sum = 0
          for (const value of levelBufRef.current) sum += value * value
          level = Math.min(1, Math.sqrt(sum / levelBufRef.current.length) / 90)
        }
        // 远端说话人电平
        const speakingPeers: Record<string, number> = {}
        for (const [pid, entry] of peerAnalysersRef.current) {
          entry.analyser.getByteFrequencyData(entry.buf)
          let psum = 0
          for (const value of entry.buf) psum += value * value
          const plevel = Math.min(1, Math.sqrt(psum / entry.buf.length) / 90)
          if (plevel > 0.06) speakingPeers[pid] = plevel
        }
        setState(previous => previous.inVoice ? { ...previous, speakingLevel: level, speakingPeers } : previous)
      }, 120)
    } catch { /* 电平指示不可用不影响连麦 */ }
  }

  const leaveVoice = useCallback((announce = true) => {
    stopLevelMeter()
    for (const pc of listenerPcsRef.current.values()) { try { pc.close() } catch { /* ignore */ } }
    listenerPcsRef.current.clear()
    for (const pc of pcMapRef.current.values()) { try { pc.close() } catch { /* ignore */ } }
    pcMapRef.current.clear()
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    setState(previous => ({ ...previous, inVoice: false, stream: null, muted: false, speakingLevel: 0, listening: new Map() }))
    if (announce) session.stopVoiceBroadcast()
  }, [session])

  const joinVoice = useCallback(async () => {
    if (!enabled) { setState(previous => ({ ...previous, error: '语音房已在设置中关闭' })); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
      streamRef.current = stream
      setState(previous => ({ ...previous, inVoice: true, stream, error: '' }))
      session.startVoiceBroadcast()
      startLevelMeter()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setState(previous => ({ ...previous, error: /Permission|NotAllowed/i.test(message) ? '麦克风权限被拒绝' : '无法打开麦克风' }))
    }
  }, [enabled, session])

  const toggleMute = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    const next = !state.muted
    stream.getAudioTracks().forEach(track => { track.enabled = !next })
    setState(previous => ({ ...previous, muted: next }))
    session.setVoiceMuted(next)
  }, [session, state.muted])

  /** 收听某人的语音（对发布方发 offer） */
  const listenTo = useCallback(async (peerId: string) => {
    if (pcMapRef.current.has(peerId)) return
    try {
      const pc = new RTCPeerConnection(ICE_SERVERS)
      pcMapRef.current.set(peerId, pc)
      pc.addTransceiver('audio', { direction: 'recvonly' })
      pc.ontrack = (event) => {
        const [stream] = event.streams
        if (!stream) return
        // 自动播放远端语音
        const audio = new Audio()
        audio.srcObject = stream
        audio.autoplay = true
        void audio.play().catch(() => undefined)
        setState(previous => ({ ...previous, listening: new Map(previous.listening).set(peerId, stream) }))
        // 说话人电平分析（每 200ms 一帧）
        try {
          const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          const ctx = new Ctor()
          const source = ctx.createMediaStreamSource(stream)
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256
          source.connect(analyser)
          const buf = new Uint8Array(analyser.frequencyBinCount)
          peerAnalysersRef.current.set(peerId, { ctx, analyser, buf })
        } catch { /* 指示不可用不影响收听 */ }
      }
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          session.sendCallSignal(peerId, {
            t: 'ice',
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid ?? undefined,
            sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
          })
        }
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      session.sendCallSignal(peerId, { t: 'offer', sdp: offer.sdp || '' })
    } catch (error) {
      setState(previous => ({ ...previous, error: `语音连接失败：${error instanceof Error ? error.message : String(error)}` }))
      pcMapRef.current.get(peerId)?.close()
      pcMapRef.current.delete(peerId)
    }
  }, [session])

  // 自动收听：语音房名册出现新成员（且不是我）时自动连过去听
  useEffect(() => {
    if (!autoListen) return
    return session.subscribe(() => {
      const snapshot = session.getSnapshot()
      if (!state.inVoice) return
      for (const peerId of Object.keys(snapshot.voiceUsers)) {
        if (peerId !== session.getProfile()?.peerId && !pcMapRef.current.has(peerId) && !pendingListenRef.current.has(peerId)) {
          pendingListenRef.current.add(peerId)
          void listenTo(peerId).finally(() => pendingListenRef.current.delete(peerId))
        }
      }
    })
  }, [autoListen, listenTo, session, state.inVoice])

  // 信令：语音发布方接受观众 offer；观众侧处理 answer/ice（与摄像头共用 call-signal 通道，
  // 通过连接池归属区分：voice 发布连接在 listenerPcsRef，观看连接在摄像头 hook）。
  // voiceConsumedRef 同款「只处理新信封」语义。
  const voiceConsumedRef = useRef(-1)
  useEffect(() => {
    return session.subscribe(() => {
      const snapshot = session.getSnapshot()
      for (let index = voiceConsumedRef.current + 1; index < snapshot.callSignals.length; index += 1) {
        voiceConsumedRef.current = index
        const { from, signal } = snapshot.callSignals[index]
        if (signal.t !== 'offer') continue
        // 有本地麦克风流才接受为「听众连接」；否则忽略（留给摄像头 hook）
        if (!streamRef.current) continue
        const existing = listenerPcsRef.current.get(from)
        if (existing) { try { existing.close() } catch { /* ignore */ } }
        void (async () => {
          const pc = new RTCPeerConnection(ICE_SERVERS)
          listenerPcsRef.current.set(from, pc)
          for (const track of streamRef.current!.getTracks()) pc.addTrack(track, streamRef.current!)
          pc.onicecandidate = (event) => {
            if (event.candidate) {
              session.sendCallSignal(from, {
                t: 'ice',
                candidate: event.candidate.candidate,
                sdpMid: event.candidate.sdpMid ?? undefined,
                sdpMLineIndex: event.candidate.sdpMLineIndex ?? undefined,
              })
            }
          }
          try {
            await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            session.sendCallSignal(from, { t: 'answer', sdp: answer.sdp || '' })
          } catch { /* 坏包忽略 */ }
        })()
      }
    })
  }, [session])

  // 名册里我消失了 → 停
  useEffect(() => {
    const stillThere = session.getSnapshot().broadcasters.some(b => b.peerId === session.getProfile()?.peerId)
    if (!stillThere && state.inVoice) leaveVoice(false)
  }, [session, state.inVoice, leaveVoice])

  // 卸载兜底
  useEffect(() => () => {
    stopLevelMeter()
    for (const pc of [...pcMapRef.current.values(), ...listenerPcsRef.current.values()]) { try { pc.close() } catch { /* ignore */ } }
    streamRef.current?.getTracks().forEach(track => track.stop())
  }, [])

  return { voiceState: state, joinVoice, leaveVoice, toggleMute, listenTo }
}
