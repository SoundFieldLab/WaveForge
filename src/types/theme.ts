export type ThemeType = 'gradient' | 'minimal' | 'particle' | 'wave'

export interface Theme {
  id: ThemeType
  name: string
  description: string
}

export const THEMES: Theme[] = [
  {
    id: 'gradient',
    name: '渐变主题',
    description: '根据封面自动调整背景渐变色'
  },
  {
    id: 'minimal',
    name: '极简主题',
    description: '纯色背景，专注音乐本身'
  },
  {
    id: 'particle',
    name: '粒子主题',
    description: '动态粒子效果（开发中）'
  },
  {
    id: 'wave',
    name: '波浪主题',
    description: '音频波浪可视化（开发中）'
  }
]
