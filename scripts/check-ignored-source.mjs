#!/usr/bin/env node
// 守卫：第一方源码必须入库，绝不允许被 .gitignore 吞掉或忘记 git add。
//
// 背景：2026-09，根目录未锚定的 `data/` 规则匹配了任意层级，把 src/data/bilibiliMvDeclarations.ts
// 连坐忽略；提交 5a6cc58 后该文件只存在于提交者本地，master 全新 clone 构建失败。
//
// 在第一方目录内检查两类问题：
//   1. 被 .gitignore 忽略的源码 —— ignore 规则误伤或文件放错位置；
//   2. 未跟踪且未忽略的文件 —— 还没 git add，推上去后别人全新 clone 必然构建失败。
// 允许被忽略的例外：可再生成的产物（src/generated/、*.generated.json、
// python-beat-service/packages/、resources/python-embed/）。

import { execFileSync } from 'node:child_process'
import process from 'node:process'

const FIRST_PARTY_DIRS = [
  'src/',
  'test/',
  'scripts/',
  'server/',
  'desktop/',
  'shared/',
  'resources/',
  'python-beat-service/',
  'python-apple-bridge/',
  // android/ 整目录在 .gitignore（构建产物不入库），但已跟踪的源文件
  //（.kt/.java/build.gradle.kts/CMakeLists）不受影响——新增文件被静默忽略时
  // 这里必须报警（否则 build:android 带不上新代码，发布后才暴露）。
  'android/',
  'installer/',
]
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|py|json|sh)$/
const IGNORE_ALLOWED = [
  /^src\/generated\//,
  /\.generated\.json$/,
  /^python-beat-service\/packages\//,
  /^resources\/python-embed\//,
  // vitest 缓存（.vite/vitest/<hash>/results.json）：测试运行器可再生成的产物
  /node_modules\/\.vite\//,
  // Android 原生构建中间产物（CMake reply/compile_commands 等，gradle 生成）
  /^android\/app\/\.cxx\//,
  /^android\/\.gradle\//,
  /^android\/app\/build\//,
  /^android\/build\//,
  // android 内嵌 Node 工程整体：main.cjs 是 esbuild 产物、node_modules 是打包依赖
  //（build:android 从根目录 node_modules 重新组装），均由构建脚本整目录生成。
  /^android\/app\/src\/main\/assets\/nodejs-project\//,
]

function git(args, useRepoRoot = false) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(useRepoRoot ? { cwd: repoRoot } : {}),
  })
}

const repoRoot = git(['rev-parse', '--show-toplevel']).trim()
const splitList = (out) => out.split('\0').filter(Boolean)

const ignoredFiles = splitList(git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], true))
const untrackedFiles = splitList(git(['ls-files', '--others', '--exclude-standard', '-z'], true))

const isFirstParty = (p) => FIRST_PARTY_DIRS.some((d) => p.startsWith(d))
const isSource = (p) => SOURCE_EXT.test(p)

const wronglyIgnored = ignoredFiles.filter(
  (p) => isSource(p) && isFirstParty(p) && !IGNORE_ALLOWED.some((re) => re.test(p)),
)
const forgotten = untrackedFiles.filter((p) => isSource(p) && isFirstParty(p))

if (wronglyIgnored.length === 0 && forgotten.length === 0) {
  console.log(`check-ignored-source: OK（忽略产物 ${ignoredFiles.length} 个均为可再生文件，第一方源码无遗漏）`)
  process.exit(0)
}

for (const p of wronglyIgnored) console.error(`[被 .gitignore 误伤的源码] ${p}`)
for (const p of forgotten) console.error(`[未 git add 的源码] ${p}`)
console.error(
  '\n第一方源码必须入库：\n' +
    '  - 被 ignore 误伤 → 修正 .gitignore（目录规则请锚定根目录，如 /data/），或 git add -f <文件>；\n' +
    '  - 忘记 add → git add <文件>；\n' +
    '  - 确属本地临时文件 → 移出第一方目录或加入 .gitignore。',
)
process.exit(1)
