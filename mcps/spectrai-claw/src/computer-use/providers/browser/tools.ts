import { registerTool } from '../../../tools/registry.js'
import { BrowserDomCdpProvider } from './provider.js'
import type { BrowserAction, BrowserConnectionOptions, BrowserSelector, BrowserTargetQuery } from './types.js'

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
    css: { type: 'string' },
    xpath: { type: 'string' },
    text: { type: 'string' },
    role: { type: 'string' },
    ariaLabel: { type: 'string' },
    testId: { type: 'string' },
    testIdAttribute: { type: 'string' },
    framePath: { type: 'array', items: { type: 'string' } },
    urlIncludes: { type: 'string' },
    titleIncludes: { type: 'string' },
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
    type: { type: 'string', enum: ['click', 'type', 'setValue', 'pressKey', 'hotkey', 'select', 'scroll', 'hover', 'menu', 'contextMenu', 'upload'] },
    selector: selectorSchema,
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
  required: ['type'],
  additionalProperties: false,
}

export function registerBrowserComputerUseTools(): void {
  registerTool(
    'browser_list_targets',
    'Browser Computer Use: list Chrome/Edge/Brave CDP page targets from a remote debugging endpoint. This is DOM/CDP-based and does not use screenshots.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = createProvider(args)
      const targets = await provider.listTargets()
      return json({ targets })
    },
    { title: 'Browser list targets', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  )

  registerTool(
    'browser_list_windows',
    'Browser Computer Use: list browser page targets as canonical Computer Use windows.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = createProvider(args)
      const windows = await provider.listWindows()
      return json({ windows })
    },
    { title: 'Browser list windows', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  )

  registerTool(
    'browser_get_app_state',
    'Browser Computer Use: read a DOM snapshot/tree from a CDP page target using selector-capable DOM semantics. Use this instead of screenshot/OCR for browser content when CDP is available.',
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
      const provider = createProvider(args)
      const snapshot = await provider.readDomSnapshot(readObject<BrowserSelector>(args.selector), Number(args.maxElements ?? 200), readObject<BrowserTargetQuery>(args.target))
      return json(snapshot)
    },
    { title: 'Browser DOM state', readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_find_element',
    'Browser Computer Use: find one DOM element by css/xpath/text/role/aria-label/testId/framePath/url/title/bounds selector and return a canonical element with DOM metadata.',
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
      const provider = createProvider(args)
      const element = await provider.findElement(readObject<BrowserSelector>(args.selector) ?? {}, readObject<BrowserTargetQuery>(args.target))
      return json({ element })
    },
    { title: 'Browser find element', readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_execute_action',
    'Browser Computer Use: execute DOM/CDP semantic browser actions such as click, setValue/type, select, scroll, hover and contextMenu, then verify via DOM value/text/focus/url/mutation state. Visual/HID is only a fallback suggestion.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
        target: targetSchema,
        action: actionSchema,
      },
      required: ['action'],
      additionalProperties: false,
    },
    async (args) => {
      const provider = createProvider(args)
      const result = await provider.executeAction(readObject<BrowserAction>(args.action) ?? { type: 'click' }, readObject<BrowserTargetQuery>(args.target))
      return json(result)
    },
    { title: 'Browser execute action', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  )

  registerTool(
    'browser_get_capabilities',
    'Browser Computer Use: report DOM/CDP background read/invoke/type capability, limitations, frame/permission/userGesture constraints and fallback order.',
    {
      type: 'object',
      properties: {
        connection: connectionSchema,
      },
      additionalProperties: false,
    },
    async (args) => {
      const provider = createProvider(args)
      const report = await provider.getCapabilityReport()
      return json(report)
    },
    { title: 'Browser capability report', readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  )
}

function createProvider(args: Record<string, unknown>): BrowserDomCdpProvider {
  return new BrowserDomCdpProvider(readObject<BrowserConnectionOptions>(args.connection) ?? {})
}

function readObject<T>(value: unknown): T | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as T
  }
  return undefined
}

function json(value: unknown) {
  const text = JSON.stringify(value, null, 2)
  return {
    content: [{ type: 'text', text }],
    structuredContent: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { value },
  }
}
