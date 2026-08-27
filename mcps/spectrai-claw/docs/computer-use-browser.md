# Browser DOM/CDP Computer Use Provider

Browser provider 将浏览器内容区作为一等 Computer Use target 处理：优先通过 Chrome DevTools Protocol (CDP) 和 DOM selector 读取网页状态、定位元素、执行语义动作与动作后验证。页面截图走 CDP `Page.captureScreenshot`（后台、不抢前台）；桌面 `screenshot` / OCR / 坐标 HID 只作为失败后的 fallback，不要拿来代替浏览器页面截图。

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
await provider.executeAction({ type: 'reload' })
await provider.executeAction({ type: 'back' })
await provider.waitForPage({ urlIncludes: 'baidu.com' })
await provider.getPageText()
await provider.openTab('https://www.baidu.com')
await provider.closeTab()
await provider.captureScreenshot({ format: 'png', fullPage: true })
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
- `browser_screenshot`
- `browser_reload`
- `browser_back`
- `browser_forward`
- `browser_wait`
- `browser_get_page_text`
- `browser_new_tab`
- `browser_close_tab`
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
| `reload`（别名 `refresh`/`Page.reload`） | CDP `Page.enable` + `Page.reload`，再轮询 `/json` + `document.readyState`（URL 可不变） | 后台 CDP，不走 DOM click / HID |
| `back` / `forward`（别名 `goBack`/`Page.goBack`、`goForward`/`Page.goForward`） | CDP **没有** `Page.goBack`。必须 `Page.getNavigationHistory` + `Page.navigateToHistoryEntry({entryId})`。越界返回 `unsupported_action`。禁止 `history.back()` / `history.forward()` | 后台 CDP history API |
| `screenshot`（独立 API，不走 `executeAction`） | CDP `Page.enable` + `Page.captureScreenshot`；`fullPage` 时 `captureBeyondViewport: true` | 返回页面 PNG/JPEG，`requiresForeground=false` |
| `wait`（独立 `waitForPage`） | 轮询 `/json` 的 URL/title + `document.readyState` + 可选 `document.body.innerText`。**不要订阅 CDP 事件**（`CdpSession` 会丢） | 超时 `ok=false` + failure，不抛崩 MCP |
| `newTab`（独立 `openTab`） | 复用 HTTP `/json/new?<url>`（缺省 `about:blank`），再 `waitForTargetLoad`。禁止 `/json/activate` / `window_focus` | `requiresForeground=false` |
| `closeTab`（独立 `closeTab`） | HTTP `GET /json/close/<targetId>`。Chrome 可能返回 `"Target is closing"` 或空 body；2xx 即成功。禁止 `/json/activate` | `method=cdp-http` |
| `getPageText`（独立） | `Runtime.evaluate` 精确表达式 `({url: location.href, title: document.title, text: document.body ? document.body.innerText : ""})`，截断约 50k | 不要宽匹配 DOM snapshot |
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
    "navigate": "native",
    "reload": "native",
    "back": "native",
    "forward": "native",
    "screenshot": "native",
    "wait": "native",
    "newTab": "native",
    "closeTab": "native"
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

## 后台页面截图

不要用桌面 `screenshot`、`followForeground`、任务栏激活或 HID 去拍浏览器。静默操作时前台窗口不是当前 tab，桌面截图会瞎。`browser_screenshot` 对已 attach 的 CDP page target 发 `Page.captureScreenshot`，浏览器可以在后台。

```ts
await provider.captureScreenshot({ format: 'png' })
await provider.captureScreenshot({ format: 'jpeg', quality: 80, fullPage: true })
```

等价 MCP：

```json
{
  "tool": "browser_screenshot",
  "arguments": {
    "connection": { "browserURL": "http://127.0.0.1:9222" },
    "target": { "urlIncludes": "baidu.com" },
    "format": "png",
    "fullPage": true
  }
}
```

返回 MCP content：一段 JSON 文本（`ok/provider/method=cdp-page/url/title/targetId/mimeType/byteLength/requiresForeground=false`）+ 一张 `{ type: "image", data, mimeType }` 方便会话直接看图。

## 后台页级动作（reload / back / wait / 读正文 / tab）

全部走后台 CDP，**不要**桌面 screenshot、`followForeground`、HID、`/json/activate`。

- **reload**：`Page.enable` + `Page.reload`，再轮询 `/json` + `document.readyState`（URL 可不变）。
- **back / forward**：CDP 没有 `Page.goBack`。必须 `Page.getNavigationHistory` + `Page.navigateToHistoryEntry({entryId})`。历史到头返回 `failure.code=unsupported_action`。禁止赌 `history.back()` / `history.forward()`。
- **wait**：轮询 `/json` URL/title + `document.readyState` + 可选 `document.body.innerText`。**不要订阅 CDP 事件**（`CdpSession` 会丢事件）。
- **get_page_text**：`Runtime.evaluate` 精确表达式读 `location.href` / `document.title` / `document.body.innerText`。
- **new_tab**：HTTP `/json/new?<url>`（缺省 `about:blank`）。禁止 `/json/activate` / `window_focus`。
- **close_tab**：HTTP `GET /json/close/<targetId>`。Chrome 可能返回 `"Target is closing"` 或空 body；2xx 即成功。禁止 `/json/activate`。

```ts
await provider.executeAction({ type: 'reload' })
await provider.executeAction({ type: 'back' })
await provider.executeAction({ type: 'forward' })
await provider.waitForPage({ urlIncludes: 'baidu.com', timeoutMs: 15_000 })
await provider.getPageText(undefined, 50_000)
await provider.openTab('https://www.baidu.com')
await provider.closeTab({ urlIncludes: 'baidu.com' })
```

等价 MCP：

```json
{ "tool": "browser_reload", "arguments": { "connection": { "browserURL": "http://127.0.0.1:9222" } } }
```

```json
{ "tool": "browser_back", "arguments": { "target": { "urlIncludes": "baidu.com" } } }
```

```json
{ "tool": "browser_forward", "arguments": {} }
```

```json
{
  "tool": "browser_wait",
  "arguments": {
    "urlIncludes": "baidu.com",
    "titleIncludes": "百度",
    "timeoutMs": 15000
  }
}
```

```json
{ "tool": "browser_get_page_text", "arguments": { "maxChars": 50000 } }
```

```json
{ "tool": "browser_new_tab", "arguments": { "url": "https://www.baidu.com" } }
```

```json
{ "tool": "browser_close_tab", "arguments": { "target": { "targetId": "page_1" } } }
```

`browser_execute_action` 也接受 `reload`/`refresh`/`back`/`goBack`/`forward`/`goForward`（不要把这些当成 navigate）。

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
3. 调用 `browser_get_capabilities`，确认 `status=available` 且 `actions.screenshot=native`；
4. 调用 `browser_find_element`、`browser_execute_action` 和 `browser_screenshot`（不要用桌面 screenshot）。
