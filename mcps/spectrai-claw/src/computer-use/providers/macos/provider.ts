import { getDaemonClient } from '../../../helpers/DarwinHelper.js'
import type {
  Bounds,
  DetectedElement,
  OpName,
  OpParams,
  OpResult,
} from '../../../helpers/ipc/protocol.js'
import { buildElementTree, findBestElement } from './ax-selector.js'
import { createMacOSCapabilityReport } from './capabilities.js'
import { selectMenuWithJXA } from './jxa-adapter.js'
import type {
  MacOSActionMethod,
  MacOSActionResult,
  MacOSActionVerification,
  MacOSAppDescriptor,
  MacOSAXSelector,
  MacOSAXTreeSnapshot,
  MacOSCapabilityReport,
  MacOSComputerAction,
  MacOSElementNode,
  MacOSProviderResult,
  MacOSReadTreeOptions,
  MacOSWindowDescriptor,
} from './types.js'

interface DaemonLike {
  call<O extends OpName>(op: O, params: OpParams<O>, timeoutMs?: number): Promise<OpResult<O>>
}

interface MacOSAccessibilityProviderOptions {
  client?: DaemonLike
  platform?: NodeJS.Platform
  defaultTimeoutMs?: number
}

interface ResolvedElementTarget {
  snapshot: MacOSAXTreeSnapshot
  element: MacOSElementNode
}

function normalize(text: string | null | undefined): string {
  return (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function containsText(actual: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return true
  return normalize(actual).includes(normalize(expected))
}

function boundsToString(bounds: Bounds | null | undefined): string {
  if (!bounds) return 'none'
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
}

function mapActionMethod(rawMethod: unknown): MacOSActionMethod {
  switch (rawMethod) {
    case 'axPress':
      return 'daemon.axPress'
    case 'axSetValue':
      return 'daemon.axSetValue'
    case 'hidClick':
      return 'daemon.hidClick'
    case 'hidType':
      return 'daemon.hidType'
    default:
      return 'unsupported'
  }
}

function selectorFromAction(action: MacOSComputerAction): MacOSAXSelector | undefined {
  const selector: MacOSAXSelector = { ...(action.selector ?? {}) }
  if (action.pid != null) selector.pid = action.pid
  if (action.bundleId) selector.bundleId = action.bundleId
  if (action.processName) selector.processName = action.processName
  if (action.windowId != null) selector.windowId = action.windowId
  if (action.windowTitle) selector.windowTitle = action.windowTitle
  return Object.keys(selector).length > 0 ? selector : undefined
}

export class MacOSAccessibilityProvider {
  readonly id = 'macos-ax'
  readonly platform: NodeJS.Platform
  private readonly injectedClient?: DaemonLike
  private readonly defaultTimeoutMs: number

  constructor(options: MacOSAccessibilityProviderOptions = {}) {
    this.injectedClient = options.client
    this.platform = options.platform ?? process.platform
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000
  }

  isSupported(): boolean {
    return this.platform === 'darwin'
  }

  async getCapabilityReport(): Promise<MacOSCapabilityReport> {
    if (!this.isSupported()) {
      return createMacOSCapabilityReport(this.platform)
    }

    try {
      const client = await this.client()
      const permissions = await client.call('permissionsStatus', {}, 5_000)
      return createMacOSCapabilityReport(this.platform, {
        accessibility: permissions.accessibility,
        screenRecording: permissions.screenRecording,
      })
    } catch {
      return createMacOSCapabilityReport(this.platform)
    }
  }

  async listApps(): Promise<MacOSProviderResult<MacOSAppDescriptor[]>> {
    if (!this.isSupported()) return this.unsupported('listApps')

    try {
      const apps = await this.listAppsRaw()
      return { ok: true, platform: this.platform, data: apps, warnings: [] }
    } catch (error) {
      return this.failure(error, 'listApps failed')
    }
  }

  async listWindows(selector: MacOSAXSelector = {}): Promise<MacOSProviderResult<MacOSWindowDescriptor[]>> {
    if (!this.isSupported()) return this.unsupported('listWindows')

    try {
      const client = await this.client()
      const app = await this.resolveApp(selector)
      const result = await client.call('listWindows', app?.pid != null ? { pid: app.pid } : {}, 10_000)
      let windows = result.windows.map(window => this.mapWindow(window))
      if (selector.windowId != null) {
        windows = windows.filter(window => window.windowId === selector.windowId)
      }
      if (selector.windowTitle) {
        windows = windows.filter(window => containsText(window.title, selector.windowTitle))
      }
      return { ok: true, platform: this.platform, data: windows, warnings: [] }
    } catch (error) {
      return this.failure(error, 'listWindows failed')
    }
  }

  async readTree(
    selector: MacOSAXSelector = {},
    options: MacOSReadTreeOptions = {},
  ): Promise<MacOSProviderResult<MacOSAXTreeSnapshot>> {
    if (!this.isSupported()) return this.unsupported('readTree')

    try {
      const client = await this.client()
      const target = await this.resolveTarget(selector)
      const params: Record<string, unknown> = {
        allowWebFocus: options.allowWebFocus ?? true,
        maxDepth: options.maxDepth ?? 10,
        maxCount: options.maxCount ?? 300,
        mode: options.includeVisionFallback ? 'ax_plus_vision' : 'ax_only',
      }
      if (target.pid != null) params.pid = target.pid
      if (target.windowId != null) params.windowId = target.windowId

      const result = await client.call('detectElements', params as any, this.defaultTimeoutMs)
      const tree = this.mapTreeSnapshot(result, target)
      return { ok: true, platform: this.platform, data: tree, warnings: tree.warnings }
    } catch (error) {
      return this.failure(error, 'readTree failed')
    }
  }

  async findElement(
    selector: MacOSAXSelector,
    options: MacOSReadTreeOptions = {},
  ): Promise<MacOSProviderResult<ResolvedElementTarget | null>> {
    if (!this.isSupported()) return this.unsupported('findElement')

    const treeResult = await this.readTree(selector, options)
    if (!treeResult.ok) return treeResult

    const element = findBestElement(treeResult.data.flatElements, selector)
    return {
      ok: true,
      platform: this.platform,
      data: element ? { snapshot: treeResult.data, element } : null,
      warnings: element ? treeResult.warnings : [...treeResult.warnings, 'element_not_found'],
    }
  }

  async executeAction(action: MacOSComputerAction): Promise<MacOSProviderResult<MacOSActionResult>> {
    if (!this.isSupported()) return this.unsupported('executeAction')

    try {
      switch (action.name) {
        case 'focus':
          return await this.executeFocus(action)
        case 'press':
        case 'invoke':
          return await this.executePress(action)
        case 'setValue':
        case 'type':
          return await this.executeType(action)
        case 'select':
          return action.menuPath ? await this.executeMenu(action) : await this.executePress(action)
        case 'selectMenu':
        case 'menu':
          return await this.executeMenu(action)
        default:
          return this.actionFailure(action, 'unsupported action name')
      }
    } catch (error) {
      return this.failure(error, `${action.name} failed`)
    }
  }

  private async executeFocus(action: MacOSComputerAction): Promise<MacOSProviderResult<MacOSActionResult>> {
    const client = await this.client()
    const selector = selectorFromAction(action) ?? {}
    const target = await this.resolveTarget(selector)
    const warnings: string[] = []
    let raw: unknown
    let method: MacOSActionMethod

    if (action.requireBackground) {
      return this.actionFailure(action, 'focus changes foreground app/window and cannot satisfy requireBackground')
    }

    if (target.windowId != null) {
      raw = await client.call('focusWindow', { windowId: target.windowId }, 10_000)
      method = 'daemon.focusWindow'
    } else if (target.pid != null || selector.bundleId || selector.app?.bundleId) {
      raw = await client.call('activateApplication', {
        pid: target.pid,
        bundleId: selector.bundleId ?? selector.app?.bundleId,
      }, 10_000)
      method = 'daemon.activateApplication'
    } else {
      return this.actionFailure(action, 'focus requires windowId, pid, bundleId, or app selector')
    }

    const verification = await this.verifyWindowState(action, target)
    const data: MacOSActionResult = {
      provider: 'macos-ax',
      ok: verification.status !== 'failure',
      action: action.name,
      method,
      requiresForeground: true,
      visionFallbackNeeded: false,
      warnings,
      verification,
      raw,
    }
    return { ok: true, platform: this.platform, data, warnings }
  }

  private async executePress(action: MacOSComputerAction): Promise<MacOSProviderResult<MacOSActionResult>> {
    const client = await this.client()
    const target = await this.resolveElementForAction(action)
    if (!target) {
      return this.actionFailure(action, 'press/invoke requires snapshotId+elementId or a selector that resolves to an AX element')
    }

    const raw = await client.call('click', {
      snapshotId: target.snapshot.snapshotId,
      elementId: target.element.id,
      button: 'left',
      clickCount: 1,
      modifiers: [],
    }, 10_000)
    const method = mapActionMethod(raw.method)

    if (action.requireBackground && method !== 'daemon.axPress') {
      return this.actionFailure(action, `daemon fell back to ${method}; background-only action was requested`)
    }

    const verification = await this.verifyElementAction(action, target, method)
    const warnings = [...target.snapshot.warnings]
    const data: MacOSActionResult = {
      provider: 'macos-ax',
      ok: verification.status !== 'failure',
      action: action.name,
      method,
      requiresForeground: method !== 'daemon.axPress',
      visionFallbackNeeded: method === 'daemon.hidClick',
      warnings,
      verification,
      target: target.element,
      raw,
    }
    return { ok: true, platform: this.platform, data, warnings }
  }

  private async executeType(action: MacOSComputerAction): Promise<MacOSProviderResult<MacOSActionResult>> {
    const client = await this.client()
    const text = action.value ?? action.text
    if (text == null) return this.actionFailure(action, 'setValue/type requires value or text')

    const target = await this.resolveElementForAction(action)
    const raw = await client.call('type', {
      text,
      clearExisting: action.clearExisting ?? action.name === 'setValue',
      snapshotId: target?.snapshot.snapshotId,
      elementId: target?.element.id,
    }, 10_000)
    const method = mapActionMethod(raw.method)

    if (action.requireBackground && method !== 'daemon.axSetValue') {
      return this.actionFailure(action, `daemon fell back to ${method}; background-only action was requested`)
    }

    const verification = target
      ? await this.verifyElementAction(action, target, method, text)
      : {
          status: 'unknown',
          strategy: 'none',
          checks: ['typed without AX element target; no semantic state to verify'],
        } satisfies MacOSActionVerification

    const warnings = target?.snapshot.warnings ?? ['no_element_target_hid_type_may_require_foreground']
    const data: MacOSActionResult = {
      provider: 'macos-ax',
      ok: verification.status !== 'failure',
      action: action.name,
      method,
      requiresForeground: method !== 'daemon.axSetValue',
      visionFallbackNeeded: method === 'daemon.hidType',
      warnings,
      verification,
      target: target?.element,
      raw,
    }
    return { ok: true, platform: this.platform, data, warnings }
  }

  private async executeMenu(action: MacOSComputerAction): Promise<MacOSProviderResult<MacOSActionResult>> {
    if (!action.menuPath || action.menuPath.length < 2) {
      return this.actionFailure(action, 'menu/selectMenu requires menuPath with at least [topLevelMenu, item]')
    }
    if (action.requireBackground) {
      return this.actionFailure(action, 'menu selection uses System Events and requires the target menu bar to become foreground')
    }

    const selector = selectorFromAction(action) ?? {}
    const app = await this.resolveApp(selector)
    const processName = app?.processName ?? selector.processName ?? selector.app?.processName
    if (!processName) {
      return this.actionFailure(action, 'menu selection requires processName or an app selector that resolves to a process')
    }

    const raw = await selectMenuWithJXA(processName, action.menuPath)
    const verification: MacOSActionVerification = raw.ok
      ? {
          status: 'unknown',
          strategy: 'window-state',
          checks: ['System Events returned success', 'menu actions are app-specific; verify with follow-up AX tree or screenshot when needed'],
          observed: raw.data,
        }
      : {
          status: 'failure',
          strategy: 'window-state',
          checks: ['System Events returned failure'],
          reason: raw.error,
          observed: raw.stderr,
        }

    const warnings = ['menu_selection_requires_foreground_and_automation_permission']
    const data: MacOSActionResult = {
      provider: 'macos-ax',
      ok: raw.ok,
      action: action.name,
      method: 'jxa.systemEventsMenu',
      requiresForeground: true,
      visionFallbackNeeded: !raw.ok,
      warnings,
      verification,
      raw,
    }
    return { ok: true, platform: this.platform, data, warnings }
  }

  private async verifyElementAction(
    action: MacOSComputerAction,
    target: ResolvedElementTarget,
    method: MacOSActionMethod,
    expectedText?: string,
  ): Promise<MacOSActionVerification> {
    if (action.verify === false) {
      return { status: 'unknown', strategy: 'none', checks: ['verification disabled by caller'] }
    }

    const selector = action.selector ?? target.element.selector
    const reread = await this.findElement(selector, {
      maxDepth: 10,
      maxCount: 300,
      allowWebFocus: false,
      includeVisionFallback: false,
    })

    if (!reread.ok) {
      return {
        status: method === 'daemon.axPress' || method === 'daemon.axSetValue' ? 'unknown' : 'failure',
        strategy: 'snapshot',
        checks: ['daemon returned action result', 'AX reread failed'],
        reason: reread.error,
      }
    }

    if (!reread.data) {
      return {
        status: action.name === 'press' || action.name === 'invoke' ? 'success' : 'failure',
        strategy: 'ax-tree',
        checks: ['daemon returned action result', 'target disappeared after action'],
        reason: 'target element no longer found after action',
      }
    }

    if (expectedText != null) {
      const observedValue = reread.data.element.value ?? reread.data.element.label ?? ''
      const ok = action.clearExisting ?? action.name === 'setValue'
        ? observedValue === expectedText
        : observedValue.includes(expectedText)
      return {
        status: ok ? 'success' : 'failure',
        strategy: 'ax-value',
        checks: ['daemon returned action result', `AX value reread from ${reread.data.element.id}`],
        reason: ok ? undefined : `expected text not observed; observed="${observedValue}"`,
        observed: { value: observedValue, bounds: boundsToString(reread.data.element.bounds) },
      }
    }

    return {
      status: 'success',
      strategy: 'ax-tree',
      checks: ['daemon returned action result', `AX tree reread succeeded for ${reread.data.element.id}`],
      observed: { bounds: boundsToString(reread.data.element.bounds) },
    }
  }

  private async verifyWindowState(
    action: MacOSComputerAction,
    target: { pid?: number; windowId?: number },
  ): Promise<MacOSActionVerification> {
    if (action.verify === false) {
      return { status: 'unknown', strategy: 'none', checks: ['verification disabled by caller'] }
    }

    const windowsResult = await this.listWindows({ pid: target.pid, windowId: target.windowId })
    if (!windowsResult.ok) {
      return {
        status: 'unknown',
        strategy: 'window-state',
        checks: ['focus command returned', 'window list verification failed'],
        reason: windowsResult.error,
      }
    }

    const focused = windowsResult.data.find(window => {
      if (target.windowId != null) return window.windowId === target.windowId && window.isFrontmost
      if (target.pid != null) return window.pid === target.pid && window.isFrontmost
      return false
    })

    return {
      status: focused ? 'success' : 'unknown',
      strategy: 'window-state',
      checks: ['focus command returned', focused ? 'target window/app is frontmost' : 'frontmost state not proven'],
      observed: focused,
    }
  }

  private async resolveElementForAction(action: MacOSComputerAction): Promise<ResolvedElementTarget | null> {
    if (action.snapshotId && action.elementId) {
      const client = await this.client()
      const result = await client.call('getSnapshot', { snapshotId: action.snapshotId }, 10_000)
      const target = this.mapTreeSnapshot(result, {})
      const element = target.flatElements.find(node => node.id === action.elementId)
      return element ? { snapshot: target, element } : null
    }

    const selector = selectorFromAction(action)
    if (!selector) return null
    const found = await this.findElement(selector, { includeVisionFallback: false })
    return found.ok ? found.data : null
  }

  private async resolveTarget(selector: MacOSAXSelector): Promise<{ pid?: number; windowId?: number }> {
    const app = await this.resolveApp(selector)
    let windowId = selector.windowId

    if (windowId == null && selector.windowTitle) {
      const client = await this.client()
      const windows = await client.call('listWindows', app?.pid != null ? { pid: app.pid } : {}, 10_000)
      const matched = windows.windows.find(window => containsText(window.title, selector.windowTitle))
      windowId = matched?.windowId
      return { pid: app?.pid ?? matched?.pid, windowId }
    }

    return { pid: app?.pid ?? selector.pid ?? selector.app?.pid, windowId }
  }

  private async resolveApp(selector: MacOSAXSelector): Promise<MacOSAppDescriptor | null> {
    const pid = selector.pid ?? selector.app?.pid
    const bundleId = selector.bundleId ?? selector.app?.bundleId
    const processName = selector.processName ?? selector.app?.processName

    if (pid == null && !bundleId && !processName) return null

    const apps = await this.listAppsRaw()
    return apps.find(app => {
      if (pid != null && app.pid !== pid) return false
      if (bundleId && normalize(app.bundleId) !== normalize(bundleId)) return false
      if (processName && !containsText(app.processName, processName)) return false
      return true
    }) ?? null
  }

  private async listAppsRaw(): Promise<MacOSAppDescriptor[]> {
    const client = await this.client()
    const result = await client.call('listApplications', {}, 10_000)
    return result.applications.map(app => ({
      provider: 'macos-ax',
      pid: app.pid,
      bundleId: app.bundleId,
      processName: app.name,
      isActive: app.isActive,
    }))
  }

  private mapWindow(window: {
    windowId: number
    pid: number
    title: string
    bounds: Bounds
    isMinimized: boolean
    isFrontmost: boolean
  }): MacOSWindowDescriptor {
    return {
      provider: 'macos-ax',
      windowId: window.windowId,
      pid: window.pid,
      title: window.title,
      bounds: window.bounds,
      isMinimized: window.isMinimized,
      isFrontmost: window.isFrontmost,
    }
  }

  private mapTreeSnapshot(result: {
    snapshotId: string
    screenshotPath?: string
    annotatedPath?: string
    elements: DetectedElement[]
    applicationName: string | null
    windowTitle: string | null
    windowBounds: Bounds | null
    warnings: string[]
    processId?: number | null
  }, target: { pid?: number; windowId?: number }): MacOSAXTreeSnapshot {
    const { roots, flat } = buildElementTree(result.elements)
    return {
      provider: 'macos-ax',
      snapshotId: result.snapshotId,
      app: {
        pid: result.processId ?? target.pid ?? null,
        processName: result.applicationName,
      },
      window: {
        title: result.windowTitle,
        bounds: result.windowBounds,
        windowId: target.windowId,
      },
      screenshotPath: result.screenshotPath ?? null,
      annotatedPath: result.annotatedPath || null,
      warnings: result.warnings ?? [],
      elements: roots,
      flatElements: flat,
    }
  }

  private async client(): Promise<DaemonLike> {
    if (!this.isSupported()) {
      throw new Error('macOS provider is unsupported on this platform')
    }
    if (this.injectedClient) return this.injectedClient
    return await getDaemonClient()
  }

  private unsupported<T>(operation: string): MacOSProviderResult<T> {
    return {
      ok: false,
      platform: this.platform,
      unsupported: true,
      error: `${operation} is unsupported because macOS AX provider only runs on darwin.`,
      warnings: ['unsupported_platform'],
      capabilityReport: createMacOSCapabilityReport(this.platform),
    }
  }

  private failure<T>(error: unknown, prefix: string): MacOSProviderResult<T> {
    return {
      ok: false,
      platform: this.platform,
      error: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
      warnings: [],
    }
  }

  private actionFailure(action: MacOSComputerAction, reason: string): MacOSProviderResult<MacOSActionResult> {
    const verification: MacOSActionVerification = {
      status: 'failure',
      strategy: 'none',
      checks: ['preflight failed'],
      reason,
    }
    const data: MacOSActionResult = {
      provider: 'macos-ax',
      ok: false,
      action: action.name,
      method: 'unsupported',
      requiresForeground: action.name === 'focus' || action.name === 'menu' || action.name === 'selectMenu',
      visionFallbackNeeded: false,
      warnings: [reason],
      verification,
    }
    return { ok: true, platform: this.platform, data, warnings: [reason] }
  }
}

export function createMacOSAccessibilityProvider(
  options: MacOSAccessibilityProviderOptions = {},
): MacOSAccessibilityProvider {
  return new MacOSAccessibilityProvider(options)
}
