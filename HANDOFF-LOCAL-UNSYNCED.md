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
| 学校电脑 | 拉过 `8185a17`，在其基础上做了开发，**未 push** |
| 家里这台机器（`D:\opencode\WaveForge`） | `master` 已停在 `8185a17`，工作区有 5 个未提交的新文件（见下） |

⚠️ 之前出现过一次把仓库搞混的情况：真正的工作仓库是 `D:\opencode\WaveForge`（remote 直连 GitHub）。另有外层 `D:\opencode` 是一个 gitee 远端、项目错位嵌套在 `WaveForge/` 下的无关/畸形仓库，**不要把它当成工作仓库**。任何操作前先 `git remote -v` 确认 remote 是 `github.com/SoundFieldLab/WaveForge`。

## 家里这台机器未提交的内容（已存入分支 `local/unsynced-work`）
> 这 5 个文件在 `8185a17` 的云端版本里**不存在**，是本地新建、尚未提交的开发：

| 文件 | 行数 | 内容 | 历史出现次数 |
|---|---|---|---|
| `desktop/main.js` | 51 | Electron 主进程入口（创建 BrowserWindow 等） | 0（纯新建） |
| `src/components/ControlMenu.tsx` | 90 | 控制菜单组件（设置/个人按钮 + 折叠动画） | 1（旧版曾存在，后被删） |
| `src/components/ThemeSwitcher.tsx` | 44 | 主题切换组件，依赖 `src/types/theme.ts` | 0（纯新建） |
| `src/types/theme.ts` | 30 | 主题类型定义（`gradient/minimal/particle/wave` + `THEMES`） | 0（纯新建） |
| `test-login-status.txt` | 7 | 登录状态调试用临时文本（建议忽略，不入库） | 0（纯新建） |

说明：`ThemeSwitcher.tsx` + `types/theme.ts` + `ControlMenu.tsx` 为一组（主题切换 + 控制菜单 UI 功能）；`desktop/main.js` 是 Electron 主入口，注意当前云端主入口是 `desktop/main.cjs`（二者可能冲突/需取舍）；`test-login-status.txt` 为调试产物，一般应加入 `.gitignore`。

> 注：`git status` 还曾显示 `public/v3-worklet.js`、`resources/beat-this/model.json` 为“已修改”，但经三处 blob 哈希比对，其内容与该仓库 `8185a17` 完全一致（仅是 `eol`/索引标记噪音），**无需处理**。

## 推荐的合并流程（让学校开发上岸）
1. 在学校电脑上，把未 push 的开发 **不要直接动 `master`**，先 `git fetch` 拉取本分支：
   ```
   git fetch origin local/unsynced-work
   git checkout -b local/unsynced-work origin/local/unsynced-work
   ```
2. 在学校电脑的本地开发分支（或新建 `dev/school`）上，把 `origin/local/unsynced-work` 与学校这边的改动 **逐文件对照合并**。重点冲突点预判：
   - `desktop/main.js`（家里）vs 云端 `desktop/main.cjs`（学校若也改了主入口 → 需取舍用哪个/合并逻辑）。
   - 主题/菜单相关文件（`ThemeSwitcher.tsx`、`types/theme.ts`、`ControlMenu.tsx`）若学校也做了主题或菜单功能 → 很可能冲突，需人工 review。
3. 合并确认无误后，再决定最终落地：可以合并回学校的 `master` 并 push 到 GitHub，或直接在一个功能分支上协作。**先别 force push `master`**。
4. 家里这台机器的 `local/unsynced-work` 已 push 到 GitHub，可作为交叉参考；合并完成后若该分支不再需要，再清理。

## 提示
- 当前 `D:\opencode\WaveForge` 的 `master` 干净停在 `8185a17`，`local/unsynced-work` 分支承载未提交的新文件。
- 两个仓库不要混淆（见上“历史背景”中的畸形外层仓库提醒）。
- 任何合并前，先 `git status` / `git log --oneline -3` 确认所在分支与 HEAD。
