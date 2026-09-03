import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/components/ChromaConsoleModal.tsx', import.meta.url), 'utf8')

describe('Chroma console two-layer contract', () => {
  it('keeps visualizer, background, and response controls separate', () => {
    expect(source).toContain('可视化前景')
    expect(source).toContain('背景效果')
    expect(source).toContain('可视化属性')
    expect(source).not.toContain('方向与色板')
    expect(source).not.toContain('光谱响应')
  })

  it('uses independent foreground and background settings', () => {
    expect(source).toContain('settings.foregroundStaticColor')
    expect(source).toContain('settings.foregroundGradient')
    expect(source).toContain('settings.foregroundDirection')
    expect(source).toContain('settings.backgroundStaticColor')
    expect(source).toContain('settings.backgroundGradient')
    expect(source).toContain('settings.backgroundDirection')
    expect(source).toContain('settings.backgroundEffect !== "off"')
  })

  it('caps visible brightness controls at 100 percent', () => {
    const brightnessBlocks = source.match(/label="(?:可视化亮度|背景亮度|设备强度)"[\s\S]*?max=\{1\}/g) || []
    expect(brightnessBlocks).toHaveLength(3)
    expect(source).toContain('label="减弱"')
    expect(source).toContain('label="大小"')
    expect(source).toContain('只调整设备上的波形高度，不改变预览')
  })

  it('renders separate strip and two-dimensional field previews', () => {
    expect(source).toContain('一维设备灯带')
    expect(source).toContain('二维灯光场')
    expect(source).toContain('Chroma 一维设备灯带预览')
    expect(source).toContain('256 列频率、64 行高度的 Chroma 规范灯光画布')
  })
})
