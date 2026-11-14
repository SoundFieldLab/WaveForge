// WE 场景验证探针专用临时 dev 配置：
// 原版 vite.config.ts 的 split-city-data 插件在 configureServer 里批量 rm src/generated/city-data，
// 会撞 safe-delete 护栏导致 dev server 起不来 → 此配置不带任何插件，仅静态服务探针页。
// /api 代理到场景测试实例（3019），探针页用 ?server=same 走同源请求，绕开 CORS 白名单。
// ⚠️ resolve.alias 必须与主配置一致：src/components/oobe/DglabOobeGuide.tsx 用了 '@/plugins/clients/...'，
//    缺 alias 会让 vite Pre-transform 500 → HMR overlay 盖满探针页 → 截图全是错误遮罩（2026-10-20 教训）。
import { fileURLToPath } from 'node:url'

export default {
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // 独立 cacheDir：config 变更触发 re-optimize 时需清空 deps，会撞 safe-delete 批量
  // 删除护栏（>50 文件）→ dev server 直接起不来。独立目录无此问题。
  // ⚠️ lockfile 变化会触发 deps 重优化删除本目录 → 撞护栏。对策：换新日期后缀目录
  // （不删旧缓存），旧目录留给 safe-delete guard approve 后手工清理。
  // .vite-we-probe@1030、.vite-we-probe-1102（2026-11-02，lockfile 变更）、
  // .vite-we-probe-1103（2026-11-03，装 webwallgl/mediabunny 触发重优化，护栏拦截 191 删除）、
  // .vite-we-probe-1107（2026-11-07，升级 webwallgl 3.0.1）
  cacheDir: 'node_modules/.vite-we-probe-1107',
  server: {
    port: 3020,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
    },
  },
  clearScreen: false,
}
