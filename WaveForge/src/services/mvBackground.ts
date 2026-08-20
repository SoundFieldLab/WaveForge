/**
 * MV 背景同步纯函数（ECHO 风格：视频作为静音背景层，跟随歌曲音频时钟）
 *
 * 背景视频 loop 循环播放、muted，歌曲音频一直由本地引擎播放，
 * 因此视频应处时间 = 音频位置对视频时长取模；偏差超阈值才 seek 校正一次。
 * 纯函数，便于单测（对齐 test/bilibiliMatch.test.ts 风格）。
 */

/** 由音频位置计算视频目标时间；无法计算（时长非法/非有限数）返回 null */
export function computeMvSyncTarget(audioPositionSeconds: number, videoDurationSeconds: number, loop = true): number | null {
  if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) return null
  const position = Number.isFinite(audioPositionSeconds) ? Math.max(0, audioPositionSeconds) : 0
  if (!loop) return Math.min(position, videoDurationSeconds)
  const target = position % videoDurationSeconds
  return target < 0 ? target + videoDurationSeconds : target
}

/** 视频当前时间与目标时间偏差是否超过阈值（需要 seek 校正） */
export function shouldSeekMvVideo(currentTime: number, target: number | null, thresholdSeconds = 0.5): boolean {
  if (target === null || !Number.isFinite(currentTime)) return false
  return Math.abs(currentTime - target) > thresholdSeconds
}
