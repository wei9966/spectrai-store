# Browser DOM/CDP Computer Use Provider

Browser provider 将浏览器内容区作为一等 Computer Use target 处理：优先通过 Chrome DevTools Protocol (CDP) 和 DOM selector 读取网页状态、定位元素、执行语义动作与动作后验证；截图、OCR、坐标/HID 只作为失败后的 fallback 建议。

## 代码位置

- Provider 类型与 canonical schema：`src/computer-use/providers/browser/types.ts`
- 零依赖 CDP HTTP/WebSocket adapter：`src/computer-use/providers/browser/cdp-client.ts`
- DOM selector/action 脚本：`src/computer-use/providers/browser/dom-scripts.ts`
- Provider 实现：`src/computer-use/providers/browser/provider.ts`
- MCP 薄工具注册：`src/computer-use/providers/browser/tools.ts`
- smoke test：`src/computer-use/providers/browser/__tests__/browser-provider.test.ts`

## Browser provider API

`BrowserDomCdpProvider` 实现以下一等 provider API：

```ts
const provider = new BrowserDomCdpProvider({ browserURL: 'http://127.0.0.1:9222' })

await provider.listTargets()
await provider.listWindows()
await provider.readDomSnapshot({ css: 'input[name=q]' }, 200)
await provider.findElement({ role: 'button', text: '百度一下' })
await provider.executeAction({ type: 'navigate', url: 'https://www.baidu.com' })
await provider.executeAction({ type: 'click', selector: { text: '百度一下' }, verify: { urlIncludes: 'baidu.com' } })
await provider.getCapabilityReport()

// Core compatibility aliases:
await provider.getAppState()
await provider.getAppTree()
await provider.invokeElement({ css: 'button[type=submit]' })
await provider.setValue({ css: 'input[name=q]' }, 'SpectrAI')
await provider.getCapabilities()
```

MCP tool names:

- `browser_list_targets`
- `browser_list_windows`
- `browser_get_app_state`
- `browser_find_element`
- `browser_execute_action`
- `browser_navigate`
- `browser_get_capabilities`

## CDP / Playwright 接入策略

### 1. 复用真实登录态

推荐用用户已有浏览器 profile 启动远程调试端口，这样 provider 读取的是用户真实登录态、Cookie、扩展和本地会话：

```powershell
# Windows 示例：使用默认用户数据目录或指定一个已登录 profile
Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222"
```

```bash
# macOS 示例
open -a "Google Chrome" --args --remote-debugging-port=9222
```

如果要隔离自动化会话，可传独立 `--user-data-dir`，但这不会复用主浏览器登录态。

### 2. 与现有 Chrome MCP/CDP 能力边界

现有 Swift daemon 已有 `BrowserControlService`，用于 `detectElements(mode=ax_plus_cdp/cdp_only)` 补充桌面 AX/Vision 的元素列表。本 provider 是 TypeScript 侧的一等 Computer Use provider：

- 不通过截图编号点击；
- 不依赖 AXWebArea 是否能被唤醒；
- 通过 `/json` 发现 tab target；没有 page target 时用 `/json/new?<url>` 开新 tab；
- 打开网页走 CDP `Page.navigate`（不要点地址栏）；
- 通过 `Runtime.evaluate` 在页面上下文执行 DOM selector/action/verification；
- 与 Playwright 的边界是：Playwright 可通过 `connectOverCDP` 复用同一 `http://127.0.0.1:9222` endpoint，在跨源 frame、下载、上传、权限弹窗等复杂场景提供更完整封装。

当前实现不强行引入 Playwright 或 `ws` 依赖，CDP adapter 使用 Node 内置 `http/net/tls/crypto`。

## Selector 支持

`BrowserSelector` 支持：

| 字段 | 用途 |
| --- | --- |
| `css` | `document.querySelectorAll` |
| `xpath` | `document.evaluate` |
| `text` | 按 label/text/value 包含匹配 |
| `role` | 显式 `role` 或按 tag/type 推断，如 `button`、`textbox`、`link` |
| `ariaLabel` | 匹配 `aria-label` |
| `testId` / `testIdAttribute` | 默认匹配 `data-testid` |
| `framePath` | 同源 iframe 路径，entry 可为 iframe index 字符串或 iframe CSS selector |
| `urlIncludes` / `titleIncludes` | 选择 CDP target/tab |
| `bounds` | 对 DOM `getBoundingClientRect()` 做近似匹配 |
| `elementId` / `spectraiId` | 复用 snapshot 中注入的 `data-spectrai-cuid` |

返回元素是 canonical `BrowserElement`，包含 `id/provider/role/label/text/value/tagName/attributes/bounds/actionable/enabled/visible/checked/selected/focused/metadata`。

## Action 支持

| action | 实现状态 | 验证方式 |
| --- | --- | --- |
| `click` | DOM `scrollIntoView` + `click()`，`Runtime.evaluate userGesture=true` | 默认 mutation/url 变化；也可显式 `verify` |
| `type` / `setValue` | 原生 value setter 或 contenteditable 文本更新 + input/change 事件 | 默认 `value` 等于输入值 |
| `pressKey` / `hotkey` | DOM KeyboardEvent 薄实现 | 显式 `verify` 推荐 |
| `select` | 设置 `select.value` + input/change | 默认 `value` 等于 option value |
| `scroll` | DOM/window scroll | 显式 `verify` 推荐 |
| `hover` | MouseEvent `mouseover` 薄实现 | 显式 `verify` 推荐 |
| `menu` / `contextMenu` | MouseEvent `contextmenu` 薄实现 | 显式 `verify` 推荐 |
| `navigate`（别名 `goto`/`open`/`load`） | CDP `Page.enable` + `Page.navigate({url})`；失败或无 page target 时 fallback `/json/new?<url>` | 默认 `urlIncludes` hostname/path；超时 `max(action.timeoutMs, 15000)` |
| `upload` | 接口已建模，当前返回 permission-aware fallback | 建议 Playwright/CDP `DOM.setFileInputFiles` 路径 |

## 动作后验证

`executeAction` 会在动作前后读取 DOM state，并输出 canonical verification：

- `value`：输入框/选择框值；
- `textIncludes`：元素或页面文本包含；
- `checked` / `selected` / `focused`；
- `urlIncludes`：导航或提交后的 URL；
- `mutation`：页面 body 文本 hash 或 URL 是否变化；
- `networkIdleMs`：等待简单网络/DOM稳定时间后再读 state。

失败时输出：

```json
{
  "ok": false,
  "failure": {
    "code": "verification_failed",
    "message": "Browser action verification failed.",
    "details": { "checks": [] }
  },
  "fallback": {
    "provider": "desktop-vision-hid",
    "action": "click",
    "reason": "DOM verification failed; fall back to the visual/HID provider only after rereading page state."
  }
}
```

## Capability report 示例

```json
{
  "provider": "browser-dom-cdp",
  "status": "available",
  "targetCount": 1,
  "backgroundRead": true,
  "backgroundInvoke": true,
  "backgroundType": true,
  "requiresForeground": false,
  "visionFallbackNeeded": false,
  "selectorSupport": ["css", "xpath", "text", "role", "aria-label", "testId", "framePath", "url/title", "bounds"],
  "actions": {
    "click": "native",
    "type": "native",
    "setValue": "native",
    "pressKey": "thin",
    "hotkey": "thin",
    "select": "native",
    "scroll": "native",
    "hover": "thin",
    "menu": "thin",
    "contextMenu": "thin",
    "upload": "fallback",
    "navigate": "native"
  }
}
```

当 DOM/CDP 可用时，`backgroundActionSuccess` 的预期是：`backgroundRead/backgroundInvoke/backgroundType=true`，`requiresForeground=false`，动作通过 DOM state 验证；仅在跨源 frame、下载/上传、浏览器权限弹窗、系统文件选择器、passkey/clipboard 等用户手势受限场景降级。

## 打开网页

不要点地址栏。一次成功的 CDP 导航即可：

```ts
await provider.executeAction({ type: 'navigate', url: 'https://www.baidu.com' })
```

等价 MCP：

```json
{
  "tool": "browser_navigate",
  "arguments": {
    "url": "https://www.baidu.com"
  }
}
```

或 `browser_execute_action`：`action.type=navigate` + `action.url`。别名 `goto`/`open`/`load` 以及顶层 `url` / `action.value`（像 URL 时）也会归一成 navigate。`example.com` 会补 `https://`。

## 百度搜索示例

```ts
const provider = new BrowserDomCdpProvider({ browserURL: 'http://127.0.0.1:9222' })

await provider.executeAction({ type: 'navigate', url: 'https://www.baidu.com' })

await provider.setValue(
  { css: 'input[name="wd"], input[name="word"]', urlIncludes: 'baidu.com' },
  'SpectrAI Computer Use',
)

await provider.executeAction({
  type: 'click',
  selector: { css: 'input[type="submit"], button[type="submit"], #su', urlIncludes: 'baidu.com' },
  verify: { urlIncludes: 'baidu.com', textIncludes: 'SpectrAI' },
})
```

等价 MCP 调用思路：

```json
{
  "tool": "browser_execute_action",
  "arguments": {
    "connection": { "browserURL": "http://127.0.0.1:9222" },
    "target": { "urlIncludes": "baidu.com" },
    "action": {
      "type": "setValue",
      "selector": { "css": "input[name=wd], input[name=word]" },
      "value": "SpectrAI Computer Use",
      "verify": { "value": "SpectrAI Computer Use" }
    }
  }
}
```

## 表单填写示例

```ts
await provider.setValue({ testId: 'email' }, 'user@example.com')
await provider.setValue({ ariaLabel: 'Password' }, 'correct horse battery staple')
await provider.executeAction({
  type: 'select',
  selector: { css: 'select[name=country]' },
  optionValue: 'US',
  verify: { value: 'US' },
})
await provider.executeAction({
  type: 'click',
  selector: { role: 'button', text: 'Submit' },
  verify: { textIncludes: 'Success' },
})
```

## 验证命令

```bash
cd mcps/spectrai-claw
npm run build
node --test dist/computer-use/providers/browser/__tests__/browser-provider.test.js dist/computer-use/providers/browser/__tests__/ensure-debug-browser.test.js dist/computer-use/providers/browser/__tests__/selector-normalize.test.js
```

可选真实浏览器 smoke：

1. 启动 Chrome：`chrome --remote-debugging-port=9222`；
2. 打开测试页面或百度；
3. 调用 `browser_get_capabilities`，确认 `status=available`；
4. 调用 `browser_find_element` 和 `browser_execute_action`。
