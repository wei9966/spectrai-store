import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { registerTool } from '../../../tools/registry.js'
import { ensureDebugBrowser } from './ensure-debug-browser.js'
import { BrowserDomCdpProvider, looksLikeUrl } from './provider.js'
import { normalizeBrowserSelector } from './selector-normalize.js'
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserElementState,
  BrowserConnectionOptions,
  BrowserScreenshotResult,
  BrowserSelector,
  BrowserTargetQuery,
} from './types.js'

const connectionSchema = {
  type: 'object',
  properties: {
    host: { type: 'string', description: 'CDP host, defaults to 127.0.0.1 or SPECTRAI_BROWSER_CDP_HOST.' },
    port: { type: 'number', description: 'CDP port, defaults to 9222 or SPECTRAI_BROWSER_CDP_PORT.' },
    browserURL: { type: 'string', description: 'Full CDP browser URL, for example http://127.0.0.1:9222.' },
    defaultTimeoutMs: { type: 'number', description: 'Default CDP command timeout in milliseconds.' },
  },
  additionalProperties: false,
}

const targetSchema = {
  type: 'object',
  properties: {
    targetId: { type: 'string' },
    webSocketDebuggerUrl: { type: 'string' },
    urlIncludes: { type: 'string' },
    titleIncludes: { type: 'string' },
  },
  additionalProperties: false,
}

const boundsSchema = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
  },
  additionalProperties: false,
}

const selectorSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['css', 'xpath', 'text', 'role', 'aria-label', 'testId', 'bounds', 'elementId'] },
    type: { type: 'string', description: 'Agent alias for kind; normalized to kind + flat locator fields.' },
    value: {
      description: 'Agent alias for the locator payload paired with type/kind.',
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, boundsSchema],
    },
    css: { type: 'string' },
    xpath: { type: 'string' },
    text: { type: 'string' },
    role: { type: 'string' },
    ariaLabel: { type: 'string' },
    'aria-label': { type: 'string' },
    testId: { type: 'string' },
    testIdAttribute: { type: 'string' },
    framePath: { type: 'array', items: { type: 'string' } },
    urlIncludes: { type: 'string' },
    titleIncludes: { type: 'string' },
    url: { type: 'string', description: 'Agent sometimes puts the page URL here; navigate will read it.' },
    bounds: boundsSchema,
    index: { type: 'number' },
    visible: { type: 'boolean' },
    elementId: { type: 'string' },
    spectraiId: { type: 'string' },
  },
  additionalProperties: false,
}

const verificationSchema = {
  type: 'object',
  properties: {
    value: { type: 'string' },
    textIncludes: { type: 'string' },
    checked: { type: 'boolean' },
    selected: { type: 'boolean' },
    focused: { type: 'boolean' },
    urlIncludes: { type: 'string' },
    mutation: { type: 'boolean' },
    networkIdleMs: { type: 'number' },
    timeoutMs: { type: 'number' },
  },
  additionalProperties: false,
}

const actionSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: [
        'click',
        'type',
        'setValue',
        'pressKey',
        'hotkey',
        'select',
        'scroll',
        'hover',
        'menu',
        'contextMenu',
        'upload',
        'navigate',
        'goto',
        'open',
        'load',
        'Page.navigate',
        'cdp_navigate',
        'reload',
        'refresh',
        'Page.reload',
        'back',
        'goBack',
        'Page.goBack',
        'forward',
        'goForward',
        'Page.goForward',
      ],
      description: 'Use navigate (aliases: goto/open/load) with action.url to open a page. reload/back/forward are page-level CDP actions (not DOM click). Do not click the address bar.',
    },
    selector: selectorSchema,
    url: { type: 'string', description: 'Absolute or host/path URL for navigate; file:// URLs and local absolute paths are supported. example.com is normalized to https://example.com.' },
    text: { type: 'string' },
    value: { type: 'string' },
    key: { type: 'string' },
    keys: { type: 'array', items: { type: 'string' } },
    modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
    optionValue: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    scroll: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
        block: { type: 'string' },
        inline: { type: 'string' },
      },
      additionalProperties: false,
    },
    verify: verificationSchema,
    timeoutMs: { type: 'number' },
  },
  // ponytail: url-only payloads default to navigate in the handler; do not require type.
  required: [],
  // ponytail: Agent often sends extra fields (url/href); reject-all was causing "导航参数不对".
  additionalProperties: true,
}

export function registerBrowserComputerUseTools(): void {
  registerTool(
    'browser_list_targets',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): list Chrome/Edge/Brave CDP page targets from a remote debugging endpoint. This is DOM/CDP-based and does not use screenshots.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const targets = await provider.listTargets()
      return json({ targets })
    },
    { title: 'Browser list targets', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  )

  registerTool(
    'browser_list_windows',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): list browser page targets as canonical Computer Use windows.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const windows = await provider.listWindows()
      return json({ windows })
    },
    { title: 'Browser list windows', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  )

  registerTool(
    'browser_get_app_state',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): read a DOM snapshot/tree from a CDP page target using selector-capable DOM semantics. Use this instead of screenshot/OCR for browser content when CDP is available.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        selector: selectorSchema,
        maxElements: { type: 'number', description: 'Maximum DOM elements to return; defaults to 200.' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const snapshot = await provider.readDomSnapshot(normalizeBrowserSelector(readObject(args.selector)), Number(args.maxElements ?? 200), readObject<BrowserTargetQuery>(args.target))
      return json(snapshot)
    },
    { title: 'Browser DOM state', readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_find_element',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): find one DOM element by css/xpath/text/role/aria-label/testId/framePath/url/title/bounds selector and return a canonical element with DOM metadata.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        selector: selectorSchema,
      },
      required: ['selector'],
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const element = await provider.findElement(normalizeBrowserSelector(readObject(args.selector)) ?? {}, readObject<BrowserTargetQuery>(args.target))
      return json({ element })
    },
    { title: 'Browser find element', readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_execute_action',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): execute DOM/CDP semantic browser actions such as click, setValue/type, select, scroll, hover, contextMenu, upload, navigate, reload, back and forward. upload: action.files = absolute local paths, selector = the file input or the visible upload button around it (no OS file dialog; never use python/pyautogui for uploads). Page-level reload/back/forward use background CDP (Page.reload / Page.getNavigationHistory), not DOM click or HID. To open a page, use action.type=navigate (aliases: goto/open/load) with action.url — do not click the address bar or type into omnibox. Do not use desktop screenshot, followForeground or HID.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        action: actionSchema,
        url: { type: 'string', description: 'Optional page URL; used when action.url is missing (navigate).' },
        verbose: verboseSchema,
      },
      required: ['action'],
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const action = normalizeBrowserAction(readObject<BrowserAction>(args.action) ?? {}, typeof args.url === 'string' ? args.url : undefined)
      const result = await provider.executeAction(action, readObject<BrowserTargetQuery>(args.target))
      return json(compactActionResult(result, args.verbose === true))
    },
    { title: 'Browser execute action', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_navigate',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): open a page with CDP Page.navigate (or /json/new). Pass url. Do not click the address bar.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        url: { type: 'string', description: 'http(s) URL, file:// URL, local absolute path (F:\\dir\\a.html), or host/path (https:// is added).' },
        verbose: verboseSchema,
      },
      required: ['url'],
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const action = normalizeBrowserAction({ type: 'navigate' }, typeof args.url === 'string' ? args.url : undefined)
      const result = await provider.executeAction(action, readObject<BrowserTargetQuery>(args.target))
      return json(compactActionResult(result, args.verbose === true))
    },
    { title: 'Browser navigate', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_screenshot',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): capture a background page screenshot via CDP Page.captureScreenshot. The response includes a saved file path — Read that PNG first, then operate. Do not use desktop screenshot, window_focus, or HID — this stays on the CDP page target even when the browser is in the background.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format. Defaults to png.' },
        quality: { type: 'number', minimum: 1, maximum: 100, description: 'JPEG quality 1-100. Ignored unless format=jpeg.' },
        fullPage: { type: 'boolean', description: 'When true, Page.captureScreenshot uses captureBeyondViewport: true.' },
        savePath: { type: 'string', description: 'File path to save screenshot. Default: temp spectrai_browser_ss_yyyyMMdd_HHmmss_fff.png|.jpg.' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const result = await provider.captureScreenshot(
        {
          format: args.format === 'jpeg' ? 'jpeg' : 'png',
          quality: typeof args.quality === 'number' ? args.quality : undefined,
          fullPage: args.fullPage === true,
        },
        readObject<BrowserTargetQuery>(args.target),
      )
      const persisted = await persistBrowserScreenshot(
        result,
        typeof args.savePath === 'string' ? args.savePath : undefined,
      )
      return {
        content: [
          { type: 'text', text: persisted.text },
          { type: 'image', data: result.data, mimeType: result.mimeType },
        ],
        structuredContent: persisted.meta,
      }
    },
    { title: 'Browser page screenshot', readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_reload',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): reload the current CDP page with Page.reload (background, no desktop screenshot / followForeground / HID / json/activate).',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        timeoutMs: { type: 'number' },
        verbose: verboseSchema,
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const result = await provider.executeAction(
        { type: 'reload', timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined },
        readObject<BrowserTargetQuery>(args.target),
      )
      return json(compactActionResult(result, args.verbose === true))
    },
    { title: 'Browser reload', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_back',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): go back via CDP Page.getNavigationHistory + Page.navigateToHistoryEntry. Background CDP only — do not use history.back(), desktop screenshot, followForeground, HID or /json/activate.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        timeoutMs: { type: 'number' },
        verbose: verboseSchema,
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const result = await provider.executeAction(
        { type: 'back', timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined },
        readObject<BrowserTargetQuery>(args.target),
      )
      return json(compactActionResult(result, args.verbose === true))
    },
    { title: 'Browser back', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_forward',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): go forward via CDP Page.getNavigationHistory + Page.navigateToHistoryEntry. Background CDP only — do not use history.forward(), desktop screenshot, followForeground, HID or /json/activate.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        timeoutMs: { type: 'number' },
        verbose: verboseSchema,
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const result = await provider.executeAction(
        { type: 'forward', timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined },
        readObject<BrowserTargetQuery>(args.target),
      )
      return json(compactActionResult(result, args.verbose === true))
    },
    { title: 'Browser forward', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_wait',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): poll /json URL/title plus document.readyState (and optional body text) until a condition matches. Does not subscribe to CDP events. Background CDP — no desktop screenshot / followForeground / HID.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        urlIncludes: { type: 'string' },
        titleIncludes: { type: 'string' },
        textIncludes: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Defaults to 15000.' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const result = await provider.waitForPage(
        {
          urlIncludes: typeof args.urlIncludes === 'string' ? args.urlIncludes : undefined,
          titleIncludes: typeof args.titleIncludes === 'string' ? args.titleIncludes : undefined,
          textIncludes: typeof args.textIncludes === 'string' ? args.textIncludes : undefined,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        },
        readObject<BrowserTargetQuery>(args.target),
      )
      return json(result)
    },
    { title: 'Browser wait for page', readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_get_page_text',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): read location.href / document.title / document.body.innerText via Runtime.evaluate. Background CDP — no desktop screenshot / followForeground / HID.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        maxChars: { type: 'number', description: 'Truncate innerText to this many characters. Defaults to 50000.' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const result = await provider.getPageText(
        readObject<BrowserTargetQuery>(args.target),
        typeof args.maxChars === 'number' ? args.maxChars : undefined,
      )
      return json(result)
    },
    { title: 'Browser get page text', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  )

  registerTool(
    'browser_eval',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): run a JavaScript function body in the page (await allowed; use `return` to send back a JSON-serializable value). Prefer this for multi-step page work — query several elements, fill a whole form, click, wait for DOM changes, extract data — in ONE call instead of many single actions. Do not drive the browser with python/playwright/selenium scripts. For file uploads use browser_execute_action type=upload.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        script: { type: 'string', description: 'Function body, e.g. "const b=document.querySelector(\'#save\'); b.click(); await new Promise(r=>setTimeout(r,500)); return document.title"' },
        timeoutMs: { type: 'number', description: 'Defaults to 30000, max 120000.' },
        maxChars: { type: 'number', description: 'Truncate the JSON result to this many characters. Defaults to 20000.' },
      },
      required: ['script'],
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const result = await provider.evaluateScript(
        String(args.script ?? ''),
        readObject<BrowserTargetQuery>(args.target),
        typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      )
      const limit = typeof args.maxChars === 'number' && args.maxChars > 0 ? Math.floor(args.maxChars) : 20_000
      const valueText = JSON.stringify(result.value) ?? ''
      if (valueText.length > limit) {
        return json({ ...result, value: valueText.slice(0, limit), truncated: true, charCount: valueText.length })
      }
      return json(result)
    },
    { title: 'Browser evaluate script', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_new_tab',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): open a new tab via HTTP /json/new (default about:blank). Background CDP — do not use /json/activate, window_focus, desktop screenshot, followForeground or HID.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        url: { type: 'string', description: 'Optional URL. Defaults to about:blank.' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const result = await provider.openTab(typeof args.url === 'string' ? args.url : undefined)
      return json(result)
    },
    { title: 'Browser new tab', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_close_tab',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): close a tab via HTTP GET /json/close/<targetId>. Background CDP — do not use /json/activate, desktop screenshot, followForeground or HID.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const result = await provider.closeTab(readObject<BrowserTargetQuery>(args.target))
      return json(result)
    },
    { title: 'Browser close tab', readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  )

  registerTool(
    'browser_get_capabilities',
    'Browser Computer Use (SpectrAI built-in browser by default — use browser_* for all web tasks): report DOM/CDP background read/invoke/type capability, limitations, frame/permission/userGesture constraints and fallback order.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = await createProvider(args)
      const report = await provider.getCapabilityReport()
      return json(report)
    },
    { title: 'Browser capability report', readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  )
}

export async function persistBrowserScreenshot(
  result: Pick<BrowserScreenshotResult, 'ok' | 'provider' | 'method' | 'url' | 'title' | 'targetId' | 'mimeType' | 'byteLength' | 'requiresForeground' | 'data'>,
  savePath?: string,
  now: Date = new Date(),
): Promise<{ path: string; text: string; meta: Record<string, unknown> }> {
  const ext = result.mimeType === 'image/jpeg' ? '.jpg' : '.png'
  const absolutePath = savePath?.trim()
    ? resolve(savePath.trim())
    : join(tmpdir(), `spectrai_browser_ss_${formatBrowserScreenshotStamp(now)}${ext}`)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, Buffer.from(result.data, 'base64'))
  const meta = {
    ok: result.ok,
    provider: result.provider,
    method: result.method,
    url: result.url,
    title: result.title,
    targetId: result.targetId,
    mimeType: result.mimeType,
    byteLength: result.byteLength,
    requiresForeground: result.requiresForeground,
    path: absolutePath,
    savePath: absolutePath,
  }
  const text = [
    `Screenshot saved: ${absolutePath}`,
    `Capture: url=${result.url} title=${result.title} method=${result.method} byteLength=${result.byteLength} requiresForeground=${result.requiresForeground}`,
    'NEXT: The image is attached to this result — look at it and understand the page before clicking. Do NOT re-open the file with a file/Read tool.',
    JSON.stringify(meta, null, 2),
  ].join('\n')
  return { path: absolutePath, text, meta }
}

function formatBrowserScreenshotStamp(now: Date): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${pad(now.getMilliseconds(), 3)}`
}

async function createProvider(args: Record<string, unknown>): Promise<BrowserDomCdpProvider> {
  const options = readObject<BrowserConnectionOptions>(args.connection) ?? {}
  await ensureDebugBrowser(options)
  return new BrowserDomCdpProvider(options)
}

function readObject<T>(value: unknown): T | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as T
  }
  return undefined
}

const NAVIGATE_ALIASES = new Set(['navigate', 'goto', 'open', 'load', 'page.navigate', 'cdp_navigate'])
const RELOAD_ALIASES = new Set(['reload', 'refresh', 'page.reload'])
const BACK_ALIASES = new Set(['back', 'goback', 'page.goback'])
const FORWARD_ALIASES = new Set(['forward', 'goforward', 'page.goforward'])

function pickUrl(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (looksLikeUrl(trimmed)) return trimmed
  }
  return undefined
}

function normalizeActionType(raw: unknown, hasUrl: boolean): BrowserAction['type'] {
  const type = typeof raw === 'string' ? raw.trim() : ''
  const typeKey = type.toLowerCase()
  if (type && RELOAD_ALIASES.has(typeKey)) return 'reload'
  if (type && BACK_ALIASES.has(typeKey)) return 'back'
  if (type && FORWARD_ALIASES.has(typeKey)) return 'forward'
  if (type && NAVIGATE_ALIASES.has(typeKey)) return 'navigate'
  if (!type && hasUrl) return 'navigate'
  if (type) return type as BrowserAction['type']
  return 'click'
}

function normalizeBrowserAction(action: BrowserAction | Record<string, unknown>, topLevelUrl?: string): BrowserAction {
  const raw = (action ?? {}) as BrowserAction & Record<string, unknown>
  const selector = raw.selector
    ? normalizeBrowserSelector(raw.selector as BrowserSelector | Record<string, unknown>)
    : undefined
  const url = pickUrl(raw.url, topLevelUrl, raw.value, raw.text, selector?.url)
  const type = normalizeActionType(raw.type, Boolean(url))
  return {
    ...(raw as BrowserAction),
    type,
    selector,
    ...(url ? { url } : {}),
  }
}

const verboseSchema = { type: 'boolean', description: 'Return the full result (raw payload, before/after state, all checks). Default: compact.' }

function clip(value: unknown, max: number): unknown {
  return typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value
}

function compactState(state: BrowserElementState | undefined) {
  if (!state) return undefined
  return { url: state.url, title: state.title, ...(state.value !== undefined ? { value: clip(state.value, 200) } : {}), text: clip(state.text, 300) }
}

// Every round-trip re-reads the result; ~2.5KB per click was slowing agents down. verbose=true restores the full payload.
function compactActionResult(result: BrowserActionResult, verbose: boolean) {
  if (verbose) return result
  const { raw: _raw, before: _before, after, target, verification, ...rest } = result
  return {
    ...rest,
    target: target
      ? { id: target.id, role: target.role, tagName: target.tagName, label: clip(target.label, 80), text: clip(target.text, 120), ...(target.value !== undefined ? { value: clip(target.value, 200) } : {}) }
      : undefined,
    after: compactState(after),
    verification: verification
      ? {
          ok: verification.ok,
          status: verification.status,
          message: verification.message,
          failedChecks: verification.checks.filter((check) => !check.ok).map((check) => ({ ...check, actual: clip(typeof check.actual === 'string' ? check.actual : JSON.stringify(check.actual), 300) })),
        }
      : undefined,
  }
}

function json(value: unknown) {
  const text = JSON.stringify(value, null, 2)
  return {
    content: [{ type: 'text', text }],
    structuredContent: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { value },
  }
}
