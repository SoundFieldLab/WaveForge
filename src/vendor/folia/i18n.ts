/**
 * Folia 可视化器子树的 i18next 实例。
 * 上游用 react-i18next 的 useTranslation() 取键（ui.visualizerClassic 等 388 个键），
 * WaveForge 无全局 i18next，这里用 folia 自带的 zh-CN 语言包单独初始化一个实例，
 * 在挂载任何 folia 组件前调用 ensureFoliaI18n() 即可。
 */
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales_zh-CN'

let foliaI18nInitialized = false

export function ensureFoliaI18n(): void {
  if (foliaI18nInitialized || i18next.isInitialized) return
  foliaI18nInitialized = true
  void i18next.use(initReactI18next).init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    resources: {
      'zh-CN': { translation: zhCN },
    },
    interpolation: { escapeValue: false },
  })
}
