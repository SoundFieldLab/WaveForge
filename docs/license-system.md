# WaveForge 授权体系总纲（识别码 · 兑换码 · 密钥）

> **本文档是授权体系的单一事实源**。任何要接入"功能解锁/兑换码/设备绑定/测试通道"的
> 维护者（含 AI 协作者）先读这里；改动了链路也要回写这里。

## 1. 体系鸟瞰

```
┌─────────────────────────── 开发者机（签发侧） ───────────────────────────┐
│  %APPDATA%\WaveForge License Studio\license-private-key.pem  ← 私钥只在这  │
│  scripts/license-keys.cjs          init/check/rotate/export/issue/…       │
│  resources/license-studio/issue.cjs ← App 内签发桥（IPC 子进程）           │
│  GitHub 开发者验证门: developers/roster.json 签名提交链 + 协作者强校验      │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ 签出兑换码（离线发给用户）
┌──────────────────────────────▼───────────────────────────────────────────┐
│  用户 App（验证侧，仓库内含公钥，可开源）                                  │
│  desktop/device-fingerprint.cjs  硬件指纹 → 稳定 DeviceId                 │
│  desktop/device-license.cjs      verifyCode / hasFeature / redeem / reset │
│  desktop/license-public-key.cjs  + update-manifest-public-key.cjs (公钥)  │
│  src/components/DeveloperLicenseManager.tsx  开发者管理弹窗（签发+状态）   │
└───────────────────────────────────────────────────────────────────────────┘
```

信任方向：**私钥签 → 公钥验**。公钥在客户端仓库里公开是安全的；私钥永远只在
开发者机。任何人拿到完整源码但没有（a）私钥文件 与（b）GitHub 花名册身份，
都无法签出有效兑换码。

## 2. 识别码（设备身份）

**文件**：`desktop/device-fingerprint.cjs`（v2），消费方 `desktop/device-license.cjs`。

- **因子与权重**：主板序列号 3、BIOS 序号 2、系统盘序列号 2、主板型号 1（合计 8）。
- **派生**：`sha256("WF-FP-v2:<因子键值对>")` → UUID v4 形态 `WF-XXXXXXXX-…`，
  与兑换码 `deviceHash` 口径（`hashDeviceId`）衔接。
- **确定性**：快照（注册表 `HKCU\Software\WaveForge\DeviceFingerprint` + userData
  `device-fingerprint.json` 双份）全部丢失后重算，同一台机器得到**同一个 ID**。
  卸载勾选清理注册表、重装系统（保留磁盘）都不变。
- **容忍策略**：与快照比对，剩余匹配权重 ≥5 视为同一台设备并刷新快照——
  换硬盘/更新 BIOS 等单点变化不换 ID；换主板（3+1）或全换则视为新设备。
- **兜底**：非 Windows / WMI 全空 / 异常 → 随机 UUID（v1 行为），不阻断授权。
- **重置**：`resetDeviceLicense` 会连指纹快照一起清；因确定性设计，清除后重算
  仍得同一 ID，重置清的是"已兑换授权"而非设备身份。

## 3. 兑换码

**格式**：`WF1.<base64url(payload)>.<base64url(Ed25519 签名)>`

```jsonc
payload = {
  v: 1,
  deviceHash: "<sha256(normalize(DeviceId))>",  // 绑定目标设备
  tier: "limited" | "test" | "universal",       // 无 tier 的旧码视为 limited
  feature: "supporter",                          // limited 必填；test 固定 update.test-channel
  label: "支持者",                               // 展示名
  issuedAt: 1792690000, expiresAt: null | 179…,  // 秒级；防回拨水位见 device-license.cjs
  note: "issued by YoshinoRinn",                 // 追溯
  nonce: "<hex>"                                 // 防重放分析
}
```

**等级语义**（扩展时在 `CODE_TIERS` 追加 + `hasFeature` 加一条规则，并更新本文档）：

| tier | 能力 |
| --- | --- |
| `limited` | 仅解锁 `feature` 指定功能；支持 `abc.*` 前缀通配 |
| `test` | 仅解锁 `update.test-channel`（测试版更新通道；正式版通道就绪后用户可自选） |
| `universal` | 最高等级：一切 limited 功能 + 测试通道 |

**判定入口**：`hasFeature(app, featureName)`（分级感知）。新功能接解锁时一律调它，
**不要**自己数 grants——等级语义集中在这一处。

**存储**：已兑换码在 userData `device-license.json`（上限 50 条）；注册表
`RedeemedCodes` 仅作 v1 迁移读取。

## 4. 签发（两条等价路径，同一道验证门）

**门（必过）**：GitHub 仓库 `SoundFieldLab/WaveForge` 的 `developers/roster.json`
是唯一信任根。协作者以 **SSH/GPG 签名提交**维护 `developers` 数组（登记=授予、
移除=吊销）。签发前验证三层：roster 最新提交 `verification.verified` → 签名者在
花名册 → token 账号 == 签名者且 `/collaborators` 实时确认（无 token 时 CLI 退化
为"本机 git user.name == 签名者"弱校验）。

- **App 内**：设置 → 开发者选项 → 连点警告 8 次 → `DeveloperLicenseManager`
  弹窗 → ② 开发者验证 → ③ 签发。实际签发经 IPC `license-studio:issue` spawn
  `resources/license-studio/issue.cjs`（ELECTRON_RUN_AS_NODE 子进程）。
- **CLI**：`node scripts/license-keys.cjs issue --tier <t> --device <WF-…> [--feature …] [--expires-days N]`。

**注意**：App 面板签发目标是**别的设备**的识别码（面板预填的是本机 ID，可改）。
用户把"设置→授权"页的识别码发给你，你签发后把码发回。

## 5. 密钥管理

**工具**：`scripts/license-keys.cjs`（详见 `docs/license-keys.md`）。

- `init` 生成密钥对；`check` 校验私钥与两个公钥文件匹配；`export --for-ci` 导出
  CI secret（`LICENSE_PRIVATE_KEY`，base64）；`rotate --force` 轮换并就地改写公钥
  文件；`sign-manifest` 独立签 update.json。
- 公钥内嵌：`desktop/license-public-key.cjs`（兑换码）、
  `desktop/update-manifest-public-key.cjs`（更新清单）。轮换后必须同步 CI secret，
  且发布顺序：**先发带新公钥的客户端，再切清单签名**。

## 6. 防逆向边界（逆向面清单）

| 攻击面 | 现状 | 结论 |
| --- | --- | --- |
| 逆向 App 提取签发能力 | 私钥不在 App 包/进程内；签发器（随包分发）只含"读 `%APPDATA%` 私钥 + GitHub 验证门"逻辑 | 无私钥即哑弹 ✅ |
| 伪造兑换码 | Ed25519（64B 签名），公钥验签 | 无私钥不可伪造 ✅ |
| 复制授权文件克隆身份 | v2 ID 硬件派生，跨机必然不同 | ✅（代价：真换主板需新码） |
| 篡改码内 tier/feature | payload 在签名覆盖范围内 | ✅ |
| 回拨系统时间续期 | 单调水位（`device-license-clock.json`） | 封住 ✅ |
| 离线码被共享 | 设备绑定 `deviceHash` | 一码一机 ✅ |
| 面板入口被非开发者触发 | 8 连点只是提示性门；实际能力由 GitHub 验证门 + 本机私钥把守 | 双保险 ✅ |
| token 泄露 | 面板仅会话内存/localStorage（开发者本机）；token 需同时满足"== roster 签名者 && 仍是协作者" | 低风险 ✅ |
| roster 被未授权者修改 | push 需协作者权限 + 签名提交 + GitHub 验签 | ✅ |
| 已兑换码泄露分析 | 码内只有 deviceHash/feature/时间/nonce，无隐私无密钥材料 | 可公开分析 ✅ |

残余风险（诚实声明）：离线验证体系无法防"用户改时钟到水位以下"以外的物理层
攻击（如直接 patch 公钥字节）；那已超出兑换码体系目标，需要在线授权才能根治。

## 7. 接入清单（新功能要接入解锁时）

1. 确定功能标识（如 `dj.stem`），在代码里用 `hasFeature(app, 'dj.stem')` 守卫
   （主进程）或先经 IPC 暴露状态（渲染层）。
2. 需要测试通道守卫的功能用 `hasFeature(app, 'update.test-channel')`。
3. 签发对应码：`issue --tier limited --feature dj.stem --device <用户识别码>`。
4. 回写本文档的功能标识注册表（下节）。

## 8. 功能标识注册表

| feature | 含义 | 状态 |
| --- | --- | --- |
| `update.test-channel` | 测试版更新通道（test/universal 自动含） | 已定义，通道后端待接正式版 |
| `supporter` | 支持者标识（示例） | 示例，未绑定实际功能 |

（新接入的功能在此追加一行。）
