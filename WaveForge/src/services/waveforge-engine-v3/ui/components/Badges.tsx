/**
 * 音频认证标志组件
 *
 * 引用真实的品牌 SVG 文件（由用户提供）。
 * 通过 Vite import 获取 URL，用 <img> 渲染以保持原始品牌色。
 */

import type { CSSProperties } from 'react'
import hiResSvg from '../assets/hi-res-audio.svg'
import dtsXSvg from '../assets/dts-x.svg'
import dolbyAtmosSvg from '../assets/dolby-atmos.svg'

export function HiResBadge({ style }: { style?: CSSProperties }) {
  return (
    <img
      src={hiResSvg}
      alt="Hi-Res Audio"
      draggable={false}
      style={{ height: 20, width: 'auto', objectFit: 'contain', ...style }}
    />
  )
}

export function DtsXBadge({ style }: { style?: CSSProperties }) {
  return (
    <img
      src={dtsXSvg}
      alt="DTS:X"
      draggable={false}
      style={{ height: 18, width: 'auto', objectFit: 'contain', ...style }}
    />
  )
}

export function DolbyAtmosBadge({ style }: { style?: CSSProperties }) {
  return (
    <img
      src={dolbyAtmosSvg}
      alt="Dolby Atmos"
      draggable={false}
      style={{ height: 18, width: 'auto', objectFit: 'contain', ...style }}
    />
  )
}
