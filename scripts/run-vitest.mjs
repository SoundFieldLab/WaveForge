/**
 * Vitest 启动器：规避 vitest#11872（Windows 盘符大小写两份 runtime）。
 *
 * Git Bash / 沙箱 shell 的 argv 常以小写盘符（c:/...）指向 vitest CLI，而
 * vitest 4 在 Windows 下若 CLI 入口盘符大小写与项目根不一致，会加载两份自身
 * runtime → 每个测试文件都挂在 describe()：Vitest failed to find the current
 * suite / Cannot read properties of undefined (reading 'config')，全部套件
 * no tests（2026-11-19 实证：npx vitest 全挂，canonical 路径直调全绿）。
 *
 * 这里用 realpathSync.native 取 CLI 的真实（盘符大写）路径再同进程动态 import，
 * 参数原样透传：`node scripts/run-vitest.mjs run <files>` ≙ `vitest run <files>`。
 * Linux/macOS（CI）路径无盘符，realpath 结果与原路径一致，行为不变。
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const cli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))

let canonical = cli
try {
  canonical = realpathSync.native(cli)
} catch { /* CLI 不存在时让 vitest 自己报错 */ }

await import(pathToFileURL(canonical).href)
