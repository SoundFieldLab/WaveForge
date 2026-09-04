/**
 * 《法律声明与用户协议》正文（共享组件，唯一内容来源）
 *
 * 供两处复用，避免文案分叉：
 * 1. 设置 → 关于 → 法律声明/用户协议 弹窗（SettingsPanel，右上角可切换语言）
 * 2. OOBE 1（OobeGuide）免责声明页的"法律声明/用户协议"链接弹窗
 *
 * 文案来自 src/i18n/legal.ts（7 语言），locale 由父级传入。
 */
import type { LocaleCode } from '../../i18n'
import { LEGAL_STRINGS, type LegalStringKey } from '../../i18n/legal'

interface LegalAgreementProps {
  theme?: 'light' | 'dark'
  locale?: LocaleCode
}

export default function LegalAgreement({ theme = 'dark', locale = 'zh-CN' }: LegalAgreementProps) {
  const textPrimary = theme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = theme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = theme === 'dark' ? 'text-white/40' : 'text-black/40'

  const t = (key: LegalStringKey) => LEGAL_STRINGS[key][locale]

  return (
    <div className={`space-y-6 ${textSecondary} text-sm leading-relaxed`}>
      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s1h1')}</h3>
        <p>{t('s1p1')}</p>
        <p className="mt-2">{t('s1p2')}</p>
        <p className="mt-2">{t('s1p3')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s2h1')}</h3>
        <p>{t('s2p1')}</p>
        <ul className={`mt-2 list-disc pl-5 space-y-1.5`}>
          <li>{t('s2li1')}</li>
          <li>{t('s2li2')}</li>
          <li>{t('s2li3')}</li>
          <li>{t('s2li4')}</li>
          <li>{t('s2li5')}</li>
        </ul>
        <p className="mt-2">{t('s2p2')}</p>
        <p className="mt-2">{t('s2p3')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s3h1')}</h3>
        <p>{t('s3p1')}</p>
        <p className="mt-1.5">{t('s3p2')}</p>
        <p className="mt-1.5">{t('s3p3')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s4h1')}</h3>
        <p>{t('s4intro')}</p>
        <ul className={`mt-2 list-disc pl-5 space-y-1.5`}>
          <li>{t('s4li1')}</li>
          <li>{t('s4li2')}</li>
          <li>{t('s4li3')}</li>
          <li>{t('s4li4')}</li>
          <li>{t('s4li5')}</li>
          <li>{t('s4li6')}</li>
          <li>{t('s4li7')}</li>
          <li>{t('s4li8')}</li>
        </ul>
        <p className="mt-2">{t('s4p2')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s5h1')}</h3>
        <p>{t('s5p1')}</p>
        <p className="mt-1.5">{t('s5p2')}</p>
        <p className="mt-1.5">{t('s5p3')}</p>
        <p className="mt-1.5">{t('s5p4')}</p>
        <p className="mt-1.5">{t('s5p5')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s6h1')}</h3>
        <p>{t('s6p1')}</p>
        <p className="mt-1.5">{t('s6p2')}</p>
        <p className="mt-1.5">{t('s6p3')}</p>
        <p className="mt-1.5">{t('s6p4')}</p>
        <p className="mt-1.5">{t('s6p5')}</p>
        <p className="mt-1.5">{t('s6p6')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s7h1')}</h3>
        <p>{t('s7p1')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s8h1')}</h3>
        <p>{t('s8p1')}</p>
        <p className="mt-2">{t('s8p2')}</p>
        <p className="mt-2">{t('s8p3')}</p>
        <p className="mt-2">{t('s8intro')}</p>
        <ul className={`mt-2 list-disc pl-5 space-y-1.5`}>
          <li>{t('s8li1')}</li>
          <li>{t('s8li2')}</li>
          <li>{t('s8li3')}</li>
          <li>{t('s8li4')}</li>
          <li>{t('s8li5')}</li>
          <li>{t('s8li6')}</li>
          <li>{t('s8li7')}</li>
          <li>{t('s8li8')}</li>
          <li>{t('s8li9')}</li>
          <li>{t('s8li10')}</li>
          <li>{t('s8li11')}</li>
          <li>{t('s8li12')}</li>
          <li>{t('s8li13')}</li>
        </ul>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s9h1')}</h3>
        <p>{t('s9p1')}</p>
        <p className="mt-2">{t('s9p2')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s10h1')}</h3>
        <p>{t('s10p1')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s11h1')}</h3>
        <p>{t('s11p1')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s12h1')}</h3>
        <p>{t('s12p1')}</p>
        <p className="mt-1.5">{t('s12p2')}</p>
        <p className="mt-1.5">{t('s12p3')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s13h1')}</h3>
        <p>{t('s13p1')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s14h1')}</h3>
        <p>{t('s14p1')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s15h1')}</h3>
        <p>{t('s15p1')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s16h1')}</h3>
        <p>{t('s16p1')}</p>
      </section>

      <section>
        <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>{t('s17h1')}</h3>
        <p>{t('s17p1')}</p>
        <p className="mt-1.5">{t('s17p2')}</p>
        <p className="mt-1.5">{t('s17p3')}</p>
        <p className="mt-1.5">{t('s17p4')}</p>
      </section>

      <div className={`mt-6 p-4 rounded-lg ${theme === 'dark' ? 'bg-zinc-800/50' : 'bg-gray-100'}`}>
        <p className={`text-xs ${textTertiary}`}>
          {t('footer1')}<br />
          {t('footer2')}
        </p>
      </div>
    </div>
  )
}
