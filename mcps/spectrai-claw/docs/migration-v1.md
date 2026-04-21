# SpectrAI Claw Migration v1（fork/exec → daemon）

## 为什么迁移

旧 macOS 路径基于 `execFileSync` 每次调用拉起 Swift CLI，存在明显问题：

- 进程启动开销高（高频操作延迟明显）
- 同一轮自动化任务内难以复用状态（snapshot / AX context）
- 并发请求配对与超时管理复杂
- CLI 冷启动导致吞吐不稳定

## 新架构概览

新架构改为：**Node.js 长连接 Unix socket + Swift 常驻 daemon**。

- Node 侧：`DaemonClient.call(op, params, timeoutMs?)`
- 生命周期：`DaemonLifecycle.ensure()` 自动连接或拉起 daemon
- Darwin 入口：`getDaemonClient()` 统一拿连接

收益：

- 降低单次调用延迟（避免每次 fork/exec）
- 支持请求多路复用（按 request id 配对响应）
- 更稳定的超时、重连、错误码模型
- 更容易做 E2E 与健康检查

## 向后兼容

- 旧 `darwin` 对象与 `callHelper` 路径仍保留（用于兼容）
- 但该路径已视为 **deprecated**，不建议新功能继续依赖
- 新增/重构能力应统一走 `DaemonClient`

## 调用方如何切换

### 旧方式（不推荐，兼容保留）

```ts
import { darwin } from './helpers/DarwinHelper.js'

const apps = darwin.windowsList()
```

### 新方式（推荐）

```ts
import { DaemonLifecycle } from './helpers/DaemonLifecycle.js'

const lifecycle = new DaemonLifecycle({
  helperBinary: '/absolute/path/to/spectrai-claw-helper',
})

const client = await lifecycle.ensure()

const ping = await client.call('ping', {})
const apps = await client.call('listApplications', {})

console.log(ping.pong, apps.applications.length)

await lifecycle.stop()
```

## 迁移建议

1. 新代码优先走 `getDaemonClient()` / `DaemonLifecycle`
2. 旧调用逐步替换，先替换高频链路（截图、元素检测、点击）
3. 回归用 `npm run test:e2e` + `node scripts/smoke-daemon.mjs`
4. 关注权限前置（Accessibility / Screen Recording）与错误码处理
