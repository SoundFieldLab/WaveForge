# License Studio 密钥管理

一把 Ed25519 私钥承担两个签名职责：

| 职责 | 私钥使用方 | 公钥内嵌位置 |
| --- | --- | --- |
| 兑换码/授权码签名 | （独立的 WaveForge License Studio 工具） | `desktop/license-public-key.cjs` |
| 更新清单 `update.json` 签名 | `scripts/publish-release.mjs` | `desktop/update-manifest-public-key.cjs` |

客户端（`desktop/device-license.cjs`、`desktop/update-manager.cjs`）只持有公钥，无法伪造签名。

## 密钥存放

固定路径：`%APPDATA%\WaveForge License Studio\license-private-key.pem`（pkcs8 PEM）。

- CI（`release.yml`）通过 `LICENSE_PRIVATE_KEY` secret（**base64 of PEM**）在构建时写出到同一路径。
- 本地开发机需要手工放置或生成（见下）。

## 本机初始化（新环境 / 第一次）

```bash
node scripts/license-keys.cjs init     # 生成新密钥对（私钥已存在时拒绝，需 --force）
node scripts/license-keys.cjs check    # 校验私钥与两个公钥文件匹配
```

注意：`init` 生成的是**新**密钥对，与仓库里内嵌的旧公钥不匹配（`check` 会报不匹配）。
两情况二选一：

- **从旧机器迁移（推荐，保持旧兑换码有效）**：拷贝旧机的
  `%APPDATA%\WaveForge License Studio\license-private-key.pem` 到本机同路径，`check` 应全绿。
- **确实要换新钥**：`node scripts/license-keys.cjs rotate --force`（会就地改写两个公钥文件，
  旧兑换码全部作废，见下文轮换）。

## 日常自检

```bash
node scripts/license-keys.cjs check
```

输出三项匹配状态（私钥可读、两个公钥文件与私钥一致）。不匹配时给出对应修复指引。

测试与无钥环境：

- `npm run test:license` 在私钥缺失时**跳过**（不再抛错）；可用环境变量
  `WAVEFORGE_LICENSE_TEST_KEY=<pem路径>` 指定任意私钥文件运行。
- CI 无钥时 `check` 支持环境变量 `LICENSE_PRIVATE_KEY`（base64）。

## 导出给 CI

```bash
node scripts/license-keys.cjs export --for-ci   # stdout 输出 base64（即 secret 值）
gh secret set LICENSE_PRIVATE_KEY < <(node scripts/license-keys.cjs export --for-ci)
```

`release.yml` 的「写出清单签名私钥」步骤负责在 CI 构建时还原到 `%APPDATA%` 路径。

## 轮换（换钥）

触发场景：私钥泄露、私钥彻底丢失且无备份、或有其他安全考虑。

```bash
node scripts/license-keys.cjs rotate --force
node scripts/license-keys.cjs check        # 复核
npm run test:license && npm run test:desktop
```

`rotate` 一次性完成：生成新密钥对 → 写私钥到 `%APPDATA%` 路径 → 就地替换
`desktop/license-public-key.cjs` 与 `desktop/update-manifest-public-key.cjs` 的 PEM 块。

**代价与后续**（不可逆）：

1. 所有已签发兑换码立即作废，用户需重新兑换。
2. 更新清单从下次发布起用新钥签；线上旧清单仍由旧钥签——**旧版客户端只认旧公钥**，
   因此必须先发布一个携带新公钥的客户端版本，再切换清单签名（顺序不能反）。
3. 同步更新 CI secret：`node scripts/license-keys.cjs export --for-ci` → `gh secret set`。
4. 若存在多个发布机，分发新私钥后各机 `check` 确认。

## 备份与恢复

私钥文件本身就是全部状态（一个 PEM 文件）。建议：

- 把 `license-private-key.pem` 备份进你的密码管理器附件 / 加密盘（**不要**提交进任何 git 仓库）。
- 换机 / 重装系统前导出：`node scripts/license-keys.cjs export --for-ci` 保存 base64 值。
- 恢复：把 PEM 放回 `%APPDATA%\WaveForge License Studio\license-private-key.pem`，`check` 验证。

## 开发者验证与兑换码签发（issue）

签发兑换码是私钥最高价值操作，受 **GitHub 开发者验证门** 保护（`license-keys.cjs issue`）：

1. 仓库 `developers/roster.json` 是唯一信任根。协作者以 **GPG/SSH 签名提交**维护
   `developers` 数组（登记 = 授予；移除 = 吊销）。
2. `issue` 运行时验证三层：
   - roster 最新提交通过 GitHub 签名校验（`verification.verified`）；
   - 签名提交者在花名册内；
   - 有 `GH_TOKEN` 时强校验：token 账号 == 签名者，且仍是仓库协作者
     （`/collaborators` 204）。无 token 时退化为「本机 git user.name == 签名者」弱校验。
3. 通过后即可签发：

```bash
GH_TOKEN=<token> node scripts/license-keys.cjs issue \
  --feature supporter --device WF-00112233-4455-4667-8899-AABBCCDDEEFF \
  --label 支持者 --expires-days 365 --note "首批内测"
```

批量：`--device-list <文件>`（每行一个设备 ID）。设备哈希口径与
`desktop/device-license.cjs` 的 `hashDeviceId` 完全一致，兑换码可直接在
「设置 → 授权」兑换。

App 内对应能力：`desktop/developer-auth.cjs` + IPC `developer:verify/state/logout`
（`window.waveforge.developerAuth`）。App 用同一套 roster 验证链授予 **App 内
开发者权限**（调试面板等），结果缓存 6 小时、绑定 roster HEAD SHA——roster 一变
缓存即失效，撤销即时生效。架构边界：**兑换码私钥永远不进 App**，签发只发生在
持私钥的工具侧（本文件），App 端验证的是「开发者身份」而非「签名能力」。

roster 维护流程（协作者执行）：

```bash
# 1. 编辑 developers/roster.json 的 developers 数组（GitHub 用户名小写）
# 2. 签名提交（git config user.signingkey 已配置时 -S 自动生效）
git commit -S -m "chore(developers): add/remove <username>" developers/roster.json
git push
```

验证链条端到端联调：`node test/developer-auth.test.cjs`（9 用例，mock GitHub 层，
已并入 `npm run test:desktop`）。

## 工具参考

```
node scripts/license-keys.cjs <子命令>
  init                    生成新密钥对（已有私钥时需 --force）
  check                   校验私钥与两个公钥文件的匹配关系
  export [--for-ci]       导出 CI secret 用的 base64
  rotate [--force]        轮换密钥对并改写两个公钥文件（旧兑换码作废）
  sign-manifest <file>    用现有私钥签 update.json（发布流程外的独立复现）

环境变量：
  LICENSE_STUDIO_DIR            覆盖密钥目录（默认 %APPDATA%\WaveForge License Studio）
  LICENSE_PRIVATE_KEY           base64 私钥，供无钥环境的 check/export
  WAVEFORGE_LICENSE_TEST_KEY    test:license 使用的私钥 PEM 路径
```
