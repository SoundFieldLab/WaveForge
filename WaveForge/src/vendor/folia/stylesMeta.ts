/**
 * Folia 歌词样式元数据（轻量静态表）。
 * 名称与排序与上游 registry（各样式目录 entry.tsx 的 order/labelKey）
 * 保持一致，供歌词面板第二页在不引入整个可视化器树（保证懒加载）的情况下列出样式。
 * 上游中文名取自 folia zh-CN 语言包。
 */
export interface FoliaStyleMeta {
  id: string
  zhName: string
  /** 面板卡片渐变背景（贴近各样式气质的示意色） */
  gradient: string
}

export const FOLIA_STYLES: FoliaStyleMeta[] = [
  { id: 'classic', zhName: '流光', gradient: 'linear-gradient(135deg, #0a2540 0%, #1b6ca8 55%, #0a0f18 100%)' },
  { id: 'cadenza', zhName: '心象', gradient: 'linear-gradient(135deg, #2a1040 0%, #7a3f9d 55%, #100818 100%)' },
  { id: 'partita', zhName: '云阶', gradient: 'linear-gradient(135deg, #0d1f3a 0%, #4a7fb5 45%, #dbe9f4 100%)' },
  { id: 'fume', zhName: '浮名', gradient: 'linear-gradient(135deg, #1c1c1e 0%, #5c5c66 50%, #0a0a0b 100%)' },
  { id: 'tilt', zhName: '倾诉', gradient: 'linear-gradient(135deg, #33261a 0%, #8a6a45 55%, #14100b 100%)' },
  { id: 'claddagh', zhName: '回环', gradient: 'linear-gradient(135deg, #06281f 0%, #1f7a5c 55%, #04120e 100%)' },
  { id: 'monet', zhName: '莫奈', gradient: 'linear-gradient(135deg, #233a6b 0%, #7f9fd4 40%, #c9a7c7 75%, #2b2b3d 100%)' },
  { id: 'pendolo', zhName: '时计', gradient: 'linear-gradient(135deg, #241a08 0%, #a67c2e 55%, #17100a 100%)' },
  { id: 'cappella', zhName: '群唱', gradient: 'linear-gradient(135deg, #301a2b 0%, #a45a8f 55%, #150a12 100%)' },
  { id: 'diorama', zhName: '镜台', gradient: 'linear-gradient(145deg, #05060c 0%, #3f6fff 45%, #0b1b2a 75%, #030409 100%)' },
  { id: 'sonnet', zhName: '商籁', gradient: 'linear-gradient(135deg, #3d0f18 0%, #b8434f 50%, #1b0508 100%)' },
  { id: 'tempera', zhName: '凝彩', gradient: 'linear-gradient(135deg, #12303a 0%, #cf7a4a 55%, #0c1a1f 100%)' },
]
