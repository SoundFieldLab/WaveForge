import { findBestBilibiliMv, BilibiliWatchSettings } from './src/services/bilibiliApi'
const g = globalThis as unknown as { localStorage?: unknown }
if (!g.localStorage) {
  const store = new Map<string, string>()
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size } }
}
const settings: BilibiliWatchSettings = { matchPreference: 'balanced', autoPlayStrictness: 'standard', keywordTemplate: 'auto', customKeywordTemplate: '', forceAutoPlayHighest: false, useRememberedOverride: true, subtitlePreference: 'zh_cn' }
const r = await findBestBilibiliMv({ songKey: 'rt:1', trackId: '', songTitle: 'rainy tone', artists: ['(K)NoW_NAME', 'NIKIIE'], songDuration: 191 } as never, settings, { signal: undefined as never })
console.log('status:', r.status)
if (r.best) console.log('BEST:', r.best.video.bvid, '|', r.best.video.title.slice(0, 44), '|', Math.round(r.best.score), '|', r.best.type)
for (const c of r.candidates.slice(0, 6)) console.log('  ', c.video.bvid, '|', c.video.title.slice(0, 40), '|', Math.round(c.score), '|', c.type)
