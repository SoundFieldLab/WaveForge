# WaveForge 工作交接说明（2026-09-18）

> 阅读对象：在学校电脑上接手的 AI 助手 / 开发者
> 关联仓库：`https://github.com/SoundFieldLab/WaveForge.git`

## 一句话结论
本地（`D:\opencode\WaveForge`）与 GitHub 云端 **`master` / `origin/master` 已经完全同步**，都在提交 **`8185a17`**，不存在“本地落后云端”的问题。当前真正的待办是：**把学校和家里的未推送开发合并到一起**。

## 历史背景（来自会话存档）
- `sess_21fee968`（2026-09-10）：把云端 `origin/master` 下拉，并将本地修复分支 `fix/ci-and-local-changes`（提交 `85c5295`）合并进 `master`，生成合并提交 `eaeb3b8` 并推送。
- `sess_26c82ecd`（2026-09-17）：在 `master` 上改了 OOBE 相关文件并提交 `8185a17`，推送到 GitHub（`eaeb3b8..8185a17`）。
- 推送后的连续历史：`... → 4aa33d0 → eaeb3b8 → 8185a17 (= origin/master)`。

## 两端当前状态
| 位置 | 说明 |
|---|---|
| 学校电脑 | 拉过 `8185a17`，在其基础上做了**大量开发，未 push**，工作区有很多未提交/未上传的修改 |
| 家里这台机器（`D:\opencode\WaveForge`） | `master` 已停在 `8185a17`，工作区有 5 个未提交的新文件（已存入分支 `local/unsynced-work`） |

⚠️ 之前出现过一次把仓库搞混的情况：真正的工作仓库是 `D:\opencode\WaveForge`（remote 直连 GitHub）。另有外层 `D:\opencode` 是一个 gitee 远端、项目错位嵌套在 `WaveForge/` 下的无关/畸形仓库，**不要把它当成工作仓库**。任何操作前先 `git remote -v` 确认 remote 是 `github.com/SoundFieldLab/WaveForge`。

---

## 🔴 学校电脑侧：大量未 push 本地修改的处理指南（重点）

学校电脑上有一大堆还没 push 的本地开发。这些改动**目前只存在于学校那台机器的工作区/本地分支**里，GitHub 上并没有。处理原则：**先安顿好学校这边的改动，再和家里那边的分支交叉合并，最后才决定 push 到云端。绝对不要直接 force push `master`，也不要在没理清改动前随意 `git checkout`/重置，否则会丢工作。**

### 第 1 步：先看清学校这边到底改了啥（别急着动）
```bash
git status                 # 看未提交/未跟踪文件全貌
git log --oneline -10      # 看本地 commit
git stash list             # 看有没有 stash
git branch -a              # 看本地有哪些分支（改动可能在某个分支上，而不在 master 工作区）
```
- 如果改动已经在某个**本地分支**上（比如 `dev/school` 或别的），记下来分支名——后面就在那个分支上操作。
- 如果改动是**散落在 `master` 工作区**（未 commit），继续下面第 2 步。

### 第 2 步：把学校这边的改动安全保存下来（二选一）
> 目的：先给自己的改动做个“防丢点”，再做合并。

- **方案 A（推荐，改动确需保留且能 commit）**：把改动的、且有意义的文件提交到一个本地分支
  ```bash
  git checkout -b dev/school            # 从当前位置新建本地开发分支
  git add <有意义的改动文件>            # 只 add 你确认要保留的，别一把梭 add -A 把调试产物也收了
  git commit -m "wip(school): 学校电脑的本地开发"
  ```
- **方案 B（改动还很乱、不想 commit）**：用 stash 暂存，后面再 pop
  ```bash
  git stash push -u -m "school-local-work"   # -u 连同未跟踪文件一起暂存
  ```

### 第 3 步：把家里那边的分支拉下来对照
```bash
git fetch origin
git fetch origin local/unsynced-work
# 看家里那 5 个文件到底是啥、改了哪些行
git log --oneline origin/local/unsynced-work -1
git diff 8185a17 origin/local/unsynced-work --stat
```

### 第 4 步：合并两端（在学校分支上进行，别碰 master）
在学校分支（如 `dev/school`）上，把家里的分支合并进来，逐个解决冲突：
```bash
git checkout dev/school
git merge origin/local/unsynced-work
# 若有冲突：git status 看冲突文件，逐个人工 review 后
# git add <解决完的文件> && git commit
```
或想先看差异再手动搬文件（更可控）：
```bash
git diff dev/school origin/local/unsynced-work -- <具体文件>
```

### 第 5 步：预判冲突点（学校&家里都改到的地方）
- `desktop/main.js`（家里新建）vs 云端 `desktop/main.cjs`（学校若也动了 Electron 主入口）→ 需取舍用哪个、或合并逻辑。
- 主题/菜单文件：`src/components/ThemeSwitcher.tsx`、`src/types/theme.ts`、`src/components/ControlMenu.tsx`（家里新建）。若学校也做过主题/菜单功能，几乎必然冲突，需人工 review。
- 其它两边可能都改的公共模块（如 `src/services/*`、`App.tsx`、各组件）。

### 第 6 步：确认无误后再 push 到云端
```bash
# 先在本地充分自测（构建/启动能跑）
# 合并结果落到 master 或功能分支后再推
git push -u origin dev/school        # 先推到功能分支，别直接动 master
# 确认没问题，再考虑合并回 master 并 push
```
- **不要 force push `master`**，除非你完全清楚历史会被覆盖。
- 调试产物（如 `test-login-status.txt`、临时日志）建议加进 `.gitignore`，别入库。

---

## 🟢 家里这台机器（已处理）
家里这边的 5 个未提交文件已存入分支 `local/unsynced-work` 并 push 到 GitHub，内容如下（在 `8185a17` 云端版本里均不存在，属本地新建）：

| 文件 | 行数 | 内容 | 历史出现次数 |
|---|---|---|---|
| `desktop/main.js` | 51 | Electron 主进程入口（创建 BrowserWindow 等） | 0（纯新建） |
| `src/components/ControlMenu.tsx` | 90 | 控制菜单组件（设置/个人按钮 + 折叠动画） | 1（旧版曾存在，后被删） |
| `src/components/ThemeSwitcher.tsx` | 44 | 主题切换组件，依赖 `src/types/theme.ts` | 0（纯新建） |
| `src/types/theme.ts` | 30 | 主题类型定义（`gradient/minimal/particle/wave` + `THEMES`） | 0（纯新建） |
| `test-login-status.txt` | 7 | 登录状态调试用临时文本（建议忽略，不入库） | 0（纯新建） |

说明：`ThemeSwitcher.tsx` + `types/theme.ts` + `ControlMenu.tsx` 为一组（主题切换 + 控制菜单 UI）；`desktop/main.js` 是 Electron 主入口，注意云端主入口是 `desktop/main.cjs`；`test-login-status.txt` 为调试产物，一般应加入 `.gitignore`。

> 注：家里 `git status` 还曾显示 `public/v3-worklet.js`、`resources/beat-this/model.json` 为“已修改”，但经三处 blob 哈希比对，其内容与该仓库 `8185a17` 完全一致（仅是 `eol`/索引标记噪音），**无需处理**。

## 推荐合并流程小结
1. **学校**：先按上文“学校电脑侧”第 1–2 步把本地大量改动安顿到本地分支（或 stash）。
2. **学校**：`git fetch origin local/unsynced-work` 拉下家里分支。
3. **学校**：在本地开发分支上把 `origin/local/unsynced-work` 合并进来，逐文件解决冲突（重点看上面的冲突点）。
4. 自测通过后，先 `push` 到功能分支，再决定如何落地到 `master`。先别 force push `master`。
5. 家里这台机器的 `local/unsynced-work` 已 push，可作为交叉参考；合并完成后若该分支不再需要，再清理。

## 通用提示
- 当前 `D:\opencode\WaveForge` 的 `master` 干净停在 `8185a17`，`local/unsynced-work` 分支承载家里未提交的新文件。
- 两个仓库不要混淆（见上文“畸形外层仓库”提醒）。
- 任何合并前，先 `git status` / `git log --oneline -3` 确认所在分支与 HEAD。
