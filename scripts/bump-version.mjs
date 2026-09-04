#!/usr/bin/env node
/**
 * 版本号更迭工具（semver bump）
 *
 * 用法：
 *   node scripts/bump-version.mjs patch            # 0.1.0 -> 0.1.1
 *   node scripts/bump-version.mjs minor            # 0.1.0 -> 0.2.0
 *   node scripts/bump-version.mjs major            # 0.1.0 -> 1.0.0
 *   node scripts/bump-version.mjs pre              # 0.1.0 -> 0.1.1-beta.0
 *   node scripts/bump-version.mjs 1.2.3            # 指定具体版本
 *
 * 选项：
 *   --dry-run   只打印将要执行的操作，不落地
 *   --no-commit 不自动 git commit（仅改文件）
 *   --no-tag    不打 git tag
 *   --no-push   不推送（commit/tag 只在本地）
 *   --force     忽略工作区未提交改动（默认拒绝，避免污染版本提交）
 *
 * 默认流程：更新 package.json + package-lock.json 版本号
 *   → git add 两个文件 → git commit "chore: bump version to vX.Y.Z"
 *   → git tag vX.Y.Z → git push origin <分支> && git push origin vX.Y.Z
 *
 * 与发布策略配套（AGENTS.md）：bump 后执行 `npm run build:electron`
 * 产出安装版，再 `gh release create` 发布（Releases 只发安装版）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- 参数解析 ----
const args = process.argv.slice(2)
const bumpArg = args.find(a => !a.startsWith('--'))
const flags = new Set(args.filter(a => a.startsWith('--')))
const DRY_RUN = flags.has('--dry-run')
const DO_COMMIT = !flags.has('--no-commit')
const DO_TAG = !flags.has('--no-tag')
const DO_PUSH = !flags.has('--no-push')
const FORCE = flags.has('--force')

// ---- semver 工具 ----
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

function parseVersion(v) {
  const m = SEMVER_RE.exec(String(v).trim().replace(/^v/, ''))
  if (!m) throw new Error(`无效的 semver 版本: ${v}`)
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || null,
    build: m[5] || null,
  }
}

function formatVersion(v) {
  const base = `${v.major}.${v.minor}.${v.patch}`
  const pre = v.pre ? `-${v.pre}` : ''
  const build = v.build ? `+${v.build}` : ''
  return `${base}${pre}${build}`
}

function nextVersion(current, bump) {
  const v = parseVersion(current)
  if (SEMVER_RE.test(bump)) {
    // 指定具体版本
    return bump.replace(/^v/, '')
  }
  switch (bump) {
    case 'patch':
      if (v.pre) { v.pre = null } else { v.patch += 1 }
      return formatVersion(v)
    case 'minor':
      v.minor += 1
      v.patch = 0
      v.pre = null
      return formatVersion(v)
    case 'major':
      v.major += 1
      v.minor = 0
      v.patch = 0
      v.pre = null
      return formatVersion(v)
    case 'pre': {
      // 0.1.0 -> 0.1.1-beta.0；0.1.1-beta.0 -> 0.1.1-beta.1
      if (v.pre && /^beta\.\d+$/.test(v.pre)) {
        const n = Number(v.pre.split('.')[1]) + 1
        v.pre = `beta.${n}`
      } else {
        if (!v.pre) v.patch += 1
        v.pre = 'beta.0'
      }
      return formatVersion(v)
    }
    default:
      throw new Error(`未知的更迭类型: ${bump}（可用 patch | minor | major | pre | <具体版本>）`)
  }
}

// ---- git 辅助 ----
function git(args, opts = {}) {
  return execSync(`git ${args}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  }).trim()
}

function ensureCleanWorktree() {
  const status = git('status --porcelain')
  if (status) {
    throw new Error(
      `工作区有未提交改动，拒绝 bump（避免污染版本提交）：\n${status}\n` +
      `如确需继续，加 --force`
    )
  }
}

// ---- 主流程 ----
if (!bumpArg) {
  console.error('用法: node scripts/bump-version.mjs <patch|minor|major|pre|版本号> [--dry-run] [--no-commit] [--no-tag] [--no-push] [--force]')
  process.exit(1)
}

// 读取当前版本
const pkgPath = path.join(root, 'package.json')
const lockPath = path.join(root, 'package-lock.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))

const current = pkg.version
const next = nextVersion(current, bumpArg)

if (!DRY_RUN && !FORCE) ensureCleanWorktree()

// 校验 lock 版本一致性
if (lock.version !== current) {
  console.warn(`⚠️  package-lock.json 版本(${lock.version})与 package.json(${current})不一致，将一并同步`)
}

console.log(`版本更迭: ${current} -> ${next}`)
if (DRY_RUN) {
  console.log(`[dry-run] 将更新 package.json / package-lock.json 的 version 为 ${next}`)
  if (DO_COMMIT) console.log(`[dry-run] git commit "chore: bump version to v${next}"`)
  if (DO_TAG) console.log(`[dry-run] git tag v${next}`)
  if (DO_PUSH) console.log(`[dry-run] git push origin <分支> + v${next}`)
  process.exit(0)
}

// 1. 更新版本号
pkg.version = next
lock.version = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
console.log(`✅ 已更新 package.json / package-lock.json -> ${next}`)

// 2. 提交
if (DO_COMMIT) {
  git(`add package.json package-lock.json`)
  git(`commit -m "chore: bump version to v${next}"`)
  console.log(`✅ 已提交: chore: bump version to v${next}`)
} else {
  console.log('⏭️  跳过 commit（--no-commit），版本文件已更新待手动提交')
}

// 3. 打 tag
if (DO_TAG) {
  const existing = git('tag -l').split(/\r?\n/).filter(Boolean)
  if (existing.includes(`v${next}`)) {
    console.log(`⚠️  tag v${next} 已存在，跳过`)
  } else {
    git(`tag -a v${next} -m "WaveForge v${next}"`)
    console.log(`✅ 已打 tag: v${next}`)
  }
} else {
  console.log('⏭️  跳过 tag（--no-tag）')
}

// 4. 推送
if (DO_PUSH) {
  const branch = git('branch --show-current')
  git(`push origin ${branch}`)
  console.log(`✅ 已推送分支 ${branch}`)
  git(`push origin v${next}`)
  console.log(`✅ 已推送 tag v${next}`)
} else {
  console.log('⏭️  跳过推送（--no-push）')
}

console.log(`\n下一步（发布，Releases 只发安装版）：`)
console.log(`  npm run build:electron`)
console.log(`  gh release create v${next} "release/WaveForge-${next}-Setup.exe" --title "v${next}" --notes "changelog"`)
