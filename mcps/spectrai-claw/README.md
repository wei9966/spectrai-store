# SpectrAI Claw

跨平台桌面自动化 MCP Server，macOS 端已升级为常驻 daemon 架构（Node.js 长连接 Swift daemon）。

## 架构图

```text
AI Agent
   │
   │ MCP Tool Call
   ▼
Node.js MCP Server
   │
   │ zod 校验 / 参数转换
   ▼
DaemonClient (Unix socket)
   │
   ▼
Swift daemon (spectrai-claw-helper)
   │
   ├─ AXorcist (Accessibility)
   ├─ ScreenCaptureKit + CoreGraphics
   └─ CGEvent (mouse / keyboard)
```

## 安装

### 从源码构建

```bash
cd mcps/spectrai-claw
npm install
npm run build:all
```

### 运行要求

- macOS 14+
- Node.js 18+
- Xcode Command Line Tools（或完整 Xcode）
- 首次运行会触发系统权限请求：
  - Screen Recording
  - Accessibility

## MCP 工具（macOS daemon 路径）

| 工具 | 用途 | 关键参数 |
|---|---|---|
| `describe_screen` | 截图 + AX 扫描 + SoM 标注 | `target?`, `annotated?`, `allow_web_focus?` |
| `click` | 点击元素或坐标 | `element_id`（优先）, `snapshot_id?`, `x?`, `y?` |
| `type_text` | Unicode 输入（中文可用） | `text`, `element_id?`, `snapshot_id?` |
| `hotkey` | 发送组合键 | `keys[]`, `hold_ms?` |
| `scroll` | 滚轮滚动 | `direction`, `amount`, `x?`, `y?` |
| `list_apps` | 列出运行中的应用 | - |
| `activate_app` | 激活应用到前台 | `bundle_id` 或 `name` |

## 性能数据（估计值）

> 以下数据为 **估计值**，用于说明架构收益；属于本地环境观察与工程估算，后续可补充统一基准测试报告。

| 操作 | 旧架构（execFileSync） | 新架构（daemon） | 比值 |
|---|---:|---:|---:|
| ping | N/A | ~1ms | - |
| listApplications | ~150ms | ~5ms | ~30x |
| captureScreen (full) | ~200ms | ~80ms | ~2.5x |
| AX tree scan（cached） | ~800ms | ~3ms | ~240x |

## daemon 管理

- 自动拉起：`DaemonLifecycle.ensure()` 会先尝试连接，失败时自动 spawn daemon。
- 手动启动：

```bash
./src/swift-helper/.build/release/spectrai-claw-helper daemon run --socket <path>
```

- 默认 socket：`~/Library/Application Support/spectrai-claw/claw.sock`
- 健康检查（推荐）：

```bash
node scripts/smoke-daemon.mjs
```

- 低层协议见：`docs/ipc-protocol.md`

## 综合测试

```bash
# 单测（mock socket）
npm run test:daemon-client

# E2E（真实 spawn daemon）
npm run test:e2e
```

## 已知局限

- 仅 macOS 14+（依赖 ScreenCaptureKit）
- Windows 端当前仍为旧路径，尚未迁移到 daemon 架构
- Chrome / Electron 首次 `detectElements` 可能有约 150ms 额外延迟（AX Web 唤醒）
- 在仅 Xcode CLT 环境下，`swift test` 可能不可用（建议完整 Xcode.app）
