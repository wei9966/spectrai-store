# SpectrAI Claw

跨平台桌面自动化 MCP Server。macOS 端已升级为 Node.js 长连接 Swift daemon，并在 v0.4 引入三路检测：**AX 主路 + Vision OCR 兵底 + CDP 浏览器专路**。

## 架构图

```text
AI → MCP Server (Node.js) → [zod] → DaemonClient (Unix socket)
                                              ↓
                                       Swift daemon
                                              ↓
                  ┌────────────────┼─────────────────┐
           ┌───┴───┐                  │                  │
           ▼       ▼                  ▼                  ▼
      AXorcist   ScreenCaptureKit  Vision (OCR/Rect)  CDP (WebSocket)
      增强 Web AX  截图              兵底补充             浏览器专路
```

## 三路识别模式（`describe_screen.mode`）

> 可选值：`auto` / `ax_only` / `ax_plus_vision` / `ax_plus_cdp` / `cdp_only` / `vision_only`

| mode | 适用 | 识别率 | 速度 | 依赖 |
|---|---|---|---|---|
| `ax_only` | 原生 AppKit / Tauri (Electron) | 80-95% | 极快 (~80ms) | AX 权限 |
| `ax_plus_vision` | Web 页面内容 / 后补 | 95%+ | 中 (~1s) | + Screen Recording |
| `ax_plus_cdp` | Chrome / Edge | 99% | 极快 (~30ms) | + Chrome `--remote-debugging-port` |
| `cdp_only` | Chrome 专项任务 | 99% | 极快 (~30ms) | + debug port |
| `vision_only` | 原本不提供 AX 的游戏 / Java app | 70-85% | 中 (~1s) | + Screen Recording |
| `auto` | 默认 | 自适应 | 自适应 | - |

## 实测性能（主会话）

| 场景 | mode | 元素识别数 | 说明 |
|---|---|---|---|
| SpectrAI (Tauri) | ax_only | 124 (vs 8) | AXManualAccessibility 唤醒后取醒 web AX |
| Chrome 首页 | ax_only | 48 (vs 41) | Chrome 主线禁用了唤醒 API，有限 |
| Chrome 首页 | ax_plus_vision | 140 | Vision 补 92 个网页元素（含主 CTA 按钮） |

以上数据与 v0.4 集成验证一致：Tauri/Electron 提升明显，Chrome 在 AX 主线受限时依赖 Vision/CDP 补齐。

## CDP 浏览器启用说明

```bash
# 1. 退出 Chrome
# 2. 启动时加参数
open -a "Google Chrome" --args --remote-debugging-port=9222

# 3. 验证
curl http://localhost:9222/json | head -20
```

启用后 `ax_plus_cdp` 模式会自动检测。

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
| `describe_screen` | 截图 + UI 元素识别 + SoM 标注 | `target?`, `annotated?`, `allow_web_focus?`, `mode?` |
| `click` | 点击元素或坐标 | `element_id`（优先）, `snapshot_id?`, `x?`, `y?` |
| `type_text` | Unicode 输入（中文可用） | `text`, `element_id?`, `snapshot_id?` |
| `hotkey` | 发送组合键 | `keys[]`, `hold_ms?` |
| `scroll` | 滚轮滚动 | `direction`, `amount`, `x?`, `y?` |
| `list_apps` | 列出运行中的应用 | - |
| `activate_app` | 激活应用到前台 | `bundle_id` 或 `name` |

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

- AXManualAccessibility 在 Chrome 主线被限制（issue 37465），Tauri/Electron 仍然有效
- Vision OCR 冷启约 500ms，后续走 cache；且需要 Screen Recording 权限
- CDP 需手动启用 debug port，不能动态唤醒已启动的 Chrome
- 仅 macOS 14+（依赖 ScreenCaptureKit）
- Windows 端当前仍为旧路径，尚未迁移到 daemon 架构
