import { CdpError, CdpHttpClient, CdpSession } from './cdp-client.js'
import { buildActionExpression, buildDomSnapshotExpression, buildElementStateExpression, buildFindElementExpression } from './dom-scripts.js'
import { ensureDebugBrowser } from './ensure-debug-browser.js'
import type {
  BrowserAction,
  BrowserActionFailure,
  BrowserActionResult,
  BrowserActionVerification,
  BrowserActionVerificationResult,
  BrowserCapabilityReport,
  BrowserComputerUseProvider,
  BrowserConnectionOptions,
  BrowserDomSnapshot,
  BrowserElement,
  BrowserElementState,
  BrowserFallbackSuggestion,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserSelector,
  BrowserTarget,
  BrowserTargetQuery,
  BrowserWindow,
} from './types.js'

interface RuntimeEvaluateResult {
  result?: {
    type?: string
    value?: unknown
    description?: string
  }
  exceptionDetails?: {
    text?: string
    exception?: { description?: string }
  }
}

interface RawDomSnapshotPayload {
  url: string
  title: string
  timestamp: string
  elements: BrowserElement[]
  frames: BrowserDomSnapshot['frames']
  warnings?: string[]
}

interface RawFindPayload {
  element: BrowserElement | null
  warnings?: string[]
}

interface RawActionPayload {
  ok: boolean
  before?: BrowserElementState
  after?: BrowserElementState
  element?: BrowserElement | null
  method?: BrowserActionResult['method']
  warnings?: string[]
  failure?: BrowserActionFailure
}

export class BrowserDomCdpProvider implements BrowserComputerUseProvider {
  private readonly http: CdpHttpClient
  private readonly defaultTimeoutMs: number
  private ensurePromise: Promise<void> | null = null

  constructor(options: BrowserConnectionOptions = {}) {
    this.http = new CdpHttpClient(options)
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000
  }

  async listTargets(): Promise<BrowserTarget[]> {
    await this.ensureReady()
    return await this.http.listTargets()
  }

  async listWindows(): Promise<BrowserWindow[]> {
    const targets = await this.listTargets()
    return targets.map((target) => ({
      id: target.targetId,
      provider: 'browser',
      targetId: target.targetId,
      title: target.title,
      url: target.url,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }))
  }

  async readDomSnapshot(selector?: BrowserSelector, maxElements = 200, target?: BrowserTargetQuery): Promise<BrowserDomSnapshot> {
    const resolvedTarget = await this.resolveTarget(target ?? selector)
    const payload = await this.evaluate<RawDomSnapshotPayload>(resolvedTarget, buildDomSnapshotExpression(selector, maxElements))
    const elements = (payload.elements ?? []).map((element) => this.withTargetMetadata(element, resolvedTarget, selector))

    return {
      provider: 'browser',
      target: resolvedTarget,
      url: payload.url ?? resolvedTarget.url,
      title: payload.title ?? resolvedTarget.title,
      timestamp: payload.timestamp ?? new Date().toISOString(),
      elements,
      frames: payload.frames ?? [],
      warnings: payload.warnings ?? [],
      capabilityHints: {
        backgroundRead: true,
        backgroundInvoke: true,
        backgroundType: true,
        requiresForeground: false,
        visionFallbackNeeded: false,
      },
    }
  }

  async findElement(selector: BrowserSelector, target?: BrowserTargetQuery): Promise<BrowserElement | null> {
    const resolvedTarget = await this.resolveTarget(target ?? selector)
    const payload = await this.evaluate<RawFindPayload>(resolvedTarget, buildFindElementExpression(selector))
    return payload.element ? this.withTargetMetadata(payload.element, resolvedTarget, selector) : null
  }

  async executeAction(action: BrowserAction, target?: BrowserTargetQuery): Promise<BrowserActionResult> {
    const normalizedInput = coerceBrowserAction(action)
    if (normalizedInput.type === 'navigate') {
      return await this.navigateUrl(normalizedInput, target)
    }
    const resolvedTarget = await this.resolveTarget(target ?? normalizedInput.selector)
    const actionWithSelector = await this.normalizeAction(normalizedInput, resolvedTarget)
    const before = actionWithSelector.selector ? await this.safeElementState(resolvedTarget, actionWithSelector.selector) : undefined
    const raw = await this.evaluate<RawActionPayload>(resolvedTarget, buildActionExpression(actionWithSelector))
    const targetElement = raw.element ? this.withTargetMetadata(raw.element, resolvedTarget, actionWithSelector.selector) : actionWithSelector.element
    const beforeState = raw.before ?? before
    const verified = await this.verifyAction(resolvedTarget, actionWithSelector, beforeState, raw.after)
    const { after: verifiedAfter, ...verification } = verified
    const afterState = verifiedAfter ?? raw.after
    const ok = raw.ok === true && verification.ok
    const failure = ok ? undefined : this.toFailure(raw.failure, verification, beforeState, afterState)

    return {
      ok,
      provider: 'browser',
      action: actionWithSelector.type,
      method: raw.method ?? 'dom',
      target: targetElement ?? undefined,
      before: beforeState,
      after: afterState,
      verification,
      failure,
      fallback: ok ? undefined : this.fallbackForFailure(failure, actionWithSelector),
      warnings: raw.warnings ?? [],
      raw,
    }
  }

  async captureScreenshot(options: BrowserScreenshotOptions = {}, target?: BrowserTargetQuery): Promise<BrowserScreenshotResult> {
    const resolvedTarget = await this.resolveTarget(target)
    if (!resolvedTarget.webSocketDebuggerUrl) {
      throw new CdpError('target_not_found', 'Target has no webSocketDebuggerUrl', { target: resolvedTarget })
    }

    const format = options.format === 'jpeg' ? 'jpeg' : 'png'
    const params: Record<string, unknown> = { format }
    if (format === 'jpeg' && options.quality != null && Number.isFinite(options.quality)) {
      params.quality = Math.min(100, Math.max(1, Math.round(options.quality)))
    }
    if (options.fullPage) params.captureBeyondViewport = true

    const session = new CdpSession(resolvedTarget.webSocketDebuggerUrl, this.defaultTimeoutMs)
    try {
      await session.send('Page.enable', {}, this.defaultTimeoutMs)
      const captured = await session.send<{ data?: string }>('Page.captureScreenshot', params, this.defaultTimeoutMs)
      const data = typeof captured?.data === 'string' ? captured.data : ''
      if (!data) {
        throw new CdpError('cdp_command_failed', 'Page.captureScreenshot returned no image data')
      }
      const meta = await this.pageUrlTitle(session, resolvedTarget)
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png'
      return {
        ok: true,
        provider: 'browser',
        method: 'cdp-page',
        url: meta.url,
        title: meta.title,
        targetId: resolvedTarget.targetId,
        mimeType,
        byteLength: Buffer.from(data, 'base64').byteLength,
        requiresForeground: false,
        data,
      }
    } finally {
      session.close()
    }
  }

  async getCapabilityReport(): Promise<BrowserCapabilityReport> {
    let targets: BrowserTarget[] = []
    let status: BrowserCapabilityReport['status'] = 'available'
    const notes: string[] = []

    try {
      await this.ensureReady()
      targets = await this.http.listTargets()
      if (targets.length === 0) {
        status = 'no_page_targets'
      }
    } catch (error) {
      status = 'debug_port_unreachable'
      notes.push(error instanceof Error ? error.message : String(error))
    }

    return {
      provider: 'browser-dom-cdp',
      status,
      endpoint: {
        host: this.http.host,
        port: this.http.port,
        browserURL: this.http.browserURL,
      },
      targetCount: targets.length,
      backgroundRead: status === 'available' || status === 'no_page_targets',
      backgroundInvoke: status === 'available',
      backgroundType: status === 'available',
      requiresForeground: false,
      visionFallbackNeeded: status !== 'available',
      selectorSupport: ['css', 'xpath', 'text', 'role', 'aria-label', 'testId', 'framePath', 'url/title', 'bounds'],
      actions: {
        click: 'native',
        type: 'native',
        setValue: 'native',
        pressKey: 'thin',
        hotkey: 'thin',
        select: 'native',
        scroll: 'native',
        hover: 'thin',
        menu: 'thin',
        contextMenu: 'thin',
        upload: 'fallback',
        navigate: 'native',
        screenshot: 'native',
      },
      limitations: {
        frames: [
          'Same-origin iframe DOM is readable through framePath; cross-origin iframe DOM requires attaching to the frame target or falling back to browser automation/vision.',
          'framePath entries accept iframe index strings or iframe CSS selectors.',
        ],
        permissions: [
          'Chrome/Edge/Brave must expose a remote debugging endpoint such as --remote-debugging-port=9222.',
          'File upload requires explicit local file permission and DOM.setFileInputFiles; the current provider returns a fallback suggestion.',
        ],
        userGesture: [
          'DOM click/input runs with Runtime.evaluate userGesture=true, but browser-gated flows such as clipboard, popups, downloads or passkeys may still require foreground or a Playwright/CDP Input fallback.',
        ],
        upload: [
          'Thin interface is modeled as action=upload with files[], but the safe implementation is intentionally deferred to a permission-aware path.',
        ],
      },
      fallbackOrder: ['browser-dom-cdp', 'playwright-with-existing-cdp-session', 'desktop-vision-hid'],
      notes,
    }
  }

  async getAppState(target?: BrowserTargetQuery): Promise<BrowserDomSnapshot> {
    return await this.readDomSnapshot(undefined, 200, target)
  }

  async getAppTree(target?: BrowserTargetQuery): Promise<BrowserDomSnapshot> {
    return await this.readDomSnapshot(undefined, 500, target)
  }

  async invokeElement(selectorOrElement: BrowserSelector | BrowserElement, action: Partial<BrowserAction> = {}, target?: BrowserTargetQuery): Promise<BrowserActionResult> {
    const browserAction: BrowserAction = {
      type: action.type ?? 'click',
      ...action,
      selector: isBrowserElement(selectorOrElement) ? selectorOrElement.metadata.selector : selectorOrElement,
      element: isBrowserElement(selectorOrElement) ? selectorOrElement : action.element,
    }
    return await this.executeAction(browserAction, target)
  }

  async setValue(selectorOrElement: BrowserSelector | BrowserElement, value: string, target?: BrowserTargetQuery): Promise<BrowserActionResult> {
    const browserAction: BrowserAction = {
      type: 'setValue',
      value,
      verify: { value },
      selector: isBrowserElement(selectorOrElement) ? selectorOrElement.metadata.selector : selectorOrElement,
      element: isBrowserElement(selectorOrElement) ? selectorOrElement : undefined,
    }
    return await this.executeAction(browserAction, target)
  }

  async getCapabilities(): Promise<BrowserCapabilityReport> {
    return await this.getCapabilityReport()
  }

  private async navigateUrl(action: BrowserAction, targetQuery?: BrowserTargetQuery): Promise<BrowserActionResult> {
    const parsed = normalizeNavigateUrl(action.url)
    if (!parsed.ok) {
      return {
        ok: false,
        provider: 'browser',
        action: 'navigate',
        method: 'cdp-dom',
        warnings: [],
        failure: { code: 'unsupported_action', message: parsed.message },
      }
    }

    const timeoutMs = Math.max(action.timeoutMs ?? 0, 15_000)
    await this.ensureReady()

    let target: BrowserTarget | null = null
    try {
      target = await this.resolveTarget(targetQuery ?? action.selector, { waitMs: 400 })
    } catch (error) {
      if (!(error instanceof CdpError) || (error.code !== 'no_page_targets' && error.code !== 'target_not_found')) {
        throw error
      }
    }

    const warnings: string[] = []
    let navigated: BrowserTarget
    try {
      if (target) {
        try {
          navigated = await this.pageNavigate(target, parsed.url, timeoutMs)
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error))
          navigated = await this.http.openUrl(parsed.url, timeoutMs)
          navigated = await this.waitForTargetLoad(navigated, parsed.url, timeoutMs)
        }
      } else {
        navigated = await this.http.openUrl(parsed.url, timeoutMs)
        navigated = await this.waitForTargetLoad(navigated, parsed.url, timeoutMs)
      }
    } catch (error) {
      return {
        ok: false,
        provider: 'browser',
        action: 'navigate',
        method: 'cdp-dom',
        warnings,
        failure: {
          code: 'cdp_unavailable',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }

    const after = (await this.safeElementState(navigated)) ?? {
      url: navigated.url,
      title: navigated.title,
      text: '',
      focused: false,
      enabled: true,
      visible: true,
      mutationHash: navigated.url,
    }
    const verified = await this.verifyAction(navigated, { ...action, type: 'navigate', url: parsed.url }, undefined, after)
    const { after: verifiedAfter, ...verification } = verified
    const afterState = verifiedAfter ?? after
    const ok = verification.ok
    const failure = ok ? undefined : this.toFailure(undefined, verification, undefined, afterState)

    return {
      ok,
      provider: 'browser',
      action: 'navigate',
      method: 'cdp-dom',
      after: afterState,
      verification,
      failure,
      fallback: ok ? undefined : this.fallbackForFailure(failure, { ...action, type: 'navigate', url: parsed.url }),
      warnings,
    }
  }

  private async pageNavigate(target: BrowserTarget, url: string, timeoutMs: number): Promise<BrowserTarget> {
    if (!target.webSocketDebuggerUrl) {
      throw new CdpError('target_not_found', 'Target has no webSocketDebuggerUrl', { target })
    }
    const session = new CdpSession(target.webSocketDebuggerUrl, timeoutMs)
    try {
      await session.send('Page.enable', {}, timeoutMs)
      await session.send('Page.navigate', { url }, timeoutMs)
    } finally {
      session.close()
    }
    return await this.waitForTargetLoad(target, url, timeoutMs)
  }

  private async waitForTargetLoad(target: BrowserTarget, expectedUrl: string, timeoutMs: number): Promise<BrowserTarget> {
    const needle = urlIncludesToken(expectedUrl) ?? expectedUrl
    const deadline = Date.now() + timeoutMs
    let current = target
    while (Date.now() < deadline) {
      try {
        const listed = await this.http.listTargets()
        current =
          listed.find((item) => item.targetId === current.targetId) ??
          listed.find((item) => item.url.includes(needle) || item.url.includes(expectedUrl)) ??
          current
      } catch {
        // /json can flap while Chrome swaps the page target
      }

      if (current.url.includes(needle) || current.url.includes(expectedUrl)) {
        const ready = await this.safeReadyState(current)
        // ponytail: CdpSession drops events; missing readyState still counts if URL already moved.
        if (ready !== 'loading') return current
      }
      await sleep(200)
    }
    return current
  }

  private async safeReadyState(target: BrowserTarget): Promise<string | undefined> {
    try {
      return await this.evaluate<string>(target, 'document.readyState')
    } catch {
      return undefined
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.ensurePromise) {
      this.ensurePromise = ensureDebugBrowser({
        host: this.http.host,
        port: this.http.port,
        browserURL: this.http.browserURL,
      })
        .then(() => undefined)
        .catch((error) => {
          this.ensurePromise = null
          throw error
        })
    }
    await this.ensurePromise
  }

  private async waitForPageTargets(waitMs: number): Promise<BrowserTarget[]> {
    await this.ensureReady()
    const deadline = Date.now() + waitMs
    let targets = await this.http.listTargets()
    while (targets.length === 0 && Date.now() < deadline) {
      await sleep(200)
      targets = await this.http.listTargets()
    }
    return targets
  }

  private async normalizeAction(action: BrowserAction, target: BrowserTarget): Promise<BrowserAction> {
    if (action.selector || action.element) {
      return action
    }
    if (action.type === 'pressKey' || action.type === 'hotkey' || action.type === 'scroll' || action.type === 'navigate') {
      return action
    }
    const element = await this.findElement({ visible: true, urlIncludes: target.url }, { targetId: target.targetId })
    return { ...action, element: element ?? undefined, selector: element?.metadata.selector }
  }

  private async resolveTarget(query?: BrowserTargetQuery | BrowserSelector, options?: { waitMs?: number }): Promise<BrowserTarget> {
    const targets = await this.waitForPageTargets(options?.waitMs ?? 2_000)
    if (targets.length === 0) {
      throw new CdpError('no_page_targets', 'No CDP page targets were found. Start Chrome/Edge with --remote-debugging-port=9222.')
    }

    const queryTargetId = query && 'targetId' in query ? query.targetId : undefined
    const queryWebSocketDebuggerUrl = query && 'webSocketDebuggerUrl' in query ? query.webSocketDebuggerUrl : undefined
    const queryUrlIncludes = query?.urlIncludes
    const queryTitleIncludes = query?.titleIncludes

    const matches = (target: BrowserTarget) => {
      if (!target.webSocketDebuggerUrl) return false
      if (queryTargetId && target.targetId !== queryTargetId) return false
      if (queryWebSocketDebuggerUrl && target.webSocketDebuggerUrl !== queryWebSocketDebuggerUrl) return false
      if (queryUrlIncludes && !target.url.includes(queryUrlIncludes)) return false
      if (queryTitleIncludes && !target.title.includes(queryTitleIncludes)) return false
      return true
    }

    const selected = targets.find(matches) ?? targets.find((target) => Boolean(target.webSocketDebuggerUrl))
    if (!selected?.webSocketDebuggerUrl) {
      throw new CdpError('target_not_found', 'No attachable CDP page target matched the browser query.', { query })
    }
    return selected
  }

  private async pageUrlTitle(session: CdpSession, target: BrowserTarget): Promise<{ url: string; title: string }> {
    try {
      const payload = await session.send<RuntimeEvaluateResult>(
        'Runtime.evaluate',
        {
          expression: '({url: location.href, title: document.title})',
          returnByValue: true,
        },
        this.defaultTimeoutMs,
      )
      const value = extractRuntimeValue<{ url?: unknown; title?: unknown }>(payload)
      return {
        url: typeof value?.url === 'string' && value.url ? value.url : target.url,
        title: typeof value?.title === 'string' ? value.title : target.title,
      }
    } catch {
      return { url: target.url, title: target.title }
    }
  }

  private async evaluate<T>(target: BrowserTarget, expression: string): Promise<T> {
    if (!target.webSocketDebuggerUrl) {
      throw new CdpError('target_not_found', 'Target has no webSocketDebuggerUrl', { target })
    }

    const session = new CdpSession(target.webSocketDebuggerUrl, this.defaultTimeoutMs)
    try {
      const result = await session.send<RuntimeEvaluateResult>(
        'Runtime.evaluate',
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        },
        this.defaultTimeoutMs,
      )
      return extractRuntimeValue<T>(result)
    } finally {
      session.close()
    }
  }

  private withTargetMetadata(element: BrowserElement, target: BrowserTarget, selector?: BrowserSelector): BrowserElement {
    return {
      ...element,
      metadata: {
        ...element.metadata,
        targetId: target.targetId,
        selector: selector ?? element.metadata.selector,
      },
    }
  }

  private async safeElementState(target: BrowserTarget, selector?: BrowserSelector): Promise<BrowserElementState | undefined> {
    try {
      return await this.evaluate<BrowserElementState>(target, buildElementStateExpression(selector))
    } catch {
      return undefined
    }
  }

  private async verifyAction(
    target: BrowserTarget,
    action: BrowserAction,
    before?: BrowserElementState,
    afterFromAction?: BrowserElementState,
  ): Promise<BrowserActionVerificationResult & { after?: BrowserElementState }> {
    const verify = this.defaultVerification(action)
    if (!verify) {
      return { ok: true, status: 'not_requested', checks: [], after: afterFromAction }
    }

    const selector = action.selector ?? action.element?.metadata.selector
    const linkLike = isLinkLikeClick(action)
    let after = afterFromAction

    // Prefer page-level state for clicks: old selectors often vanish after navigation.
    const preferPageState = action.type === 'click' || action.type === 'navigate' || verify.urlIncludes != null
    if (!after || verify.networkIdleMs != null || preferPageState) {
      if (verify.networkIdleMs && verify.networkIdleMs > 0) {
        await sleep(Math.min(verify.networkIdleMs, 5_000))
      } else if (preferPageState && action.type !== 'navigate') {
        // Brief settle for SPA/history navigations that finish after the DOM click returns.
        await sleep(Math.min(verify.timeoutMs ?? 250, 1_000))
      }
      const pageAfter = await this.safeElementState(target)
      if (pageAfter) {
        const actionNavigated = Boolean(after && before && (before.url !== after.url || before.title !== after.title))
        const pageNavigated = Boolean(before && (before.url !== pageAfter.url || before.title !== pageAfter.title))
        if (!after || pageNavigated || (preferPageState && !actionNavigated)) {
          after = pageAfter
        }
        // ponytail: keep action after when it already shows navigation and page re-read is still stale
      } else if (!after && selector) {
        after = await this.safeElementState(target, selector)
      }
    }

    const urlChanged = Boolean(before && after && before.url !== after.url)
    const titleChanged = Boolean(before && after && before.title !== after.title)
    const pageChanged = urlChanged || titleChanged

    // Navigation evidence wins even when the old <a> is gone / unreadable.
    if (action.type === 'click' && pageChanged) {
      const checks: BrowserActionVerificationResult['checks'] = [
        {
          name: urlChanged ? 'urlChanged' : 'titleChanged',
          ok: true,
          expected: 'changed',
          actual: { beforeUrl: before?.url, afterUrl: after?.url, beforeTitle: before?.title, afterTitle: after?.title },
        },
      ]
      if (verify.urlIncludes != null) {
        checks.push({
          name: 'urlIncludes',
          ok: Boolean(after?.url.includes(verify.urlIncludes)),
          expected: verify.urlIncludes,
          actual: after?.url,
        })
      }
      const ok = checks.every((check) => check.ok)
      return {
        ok,
        status: ok ? 'passed' : 'failed',
        checks,
        message: ok ? undefined : 'Browser DOM post-action verification failed.',
        after,
      }
    }

    if (!after) {
      return {
        ok: false,
        status: 'failed',
        checks: [
          {
            name: 'state_available',
            ok: false,
            actual: { beforeUrl: before?.url, linkLike },
          },
        ],
        message: 'Could not read DOM state after action.',
        after,
      }
    }

    const checks: BrowserActionVerificationResult['checks'] = []
    if (verify.value != null) checks.push({ name: 'value', ok: after.value === verify.value, expected: verify.value, actual: after.value })
    if (verify.textIncludes != null) checks.push({ name: 'textIncludes', ok: after.text.includes(verify.textIncludes), expected: verify.textIncludes, actual: after.text })
    if (verify.checked != null) checks.push({ name: 'checked', ok: after.checked === verify.checked, expected: verify.checked, actual: after.checked })
    if (verify.selected != null) checks.push({ name: 'selected', ok: after.selected === verify.selected, expected: verify.selected, actual: after.selected })
    if (verify.focused != null) checks.push({ name: 'focused', ok: after.focused === verify.focused, expected: verify.focused, actual: after.focused })
    if (verify.urlIncludes != null) checks.push({ name: 'urlIncludes', ok: after.url.includes(verify.urlIncludes), expected: verify.urlIncludes, actual: after.url })
    if (verify.mutation === true && before) {
      checks.push({
        name: 'mutation',
        ok: before.mutationHash !== after.mutationHash || before.url !== after.url || before.title !== after.title,
        expected: 'changed',
        actual: { before: before.mutationHash, after: after.mutationHash, beforeUrl: before.url, afterUrl: after.url },
      })
    }

    const ok = checks.length === 0 ? true : checks.every((check) => check.ok)
    return {
      ok,
      status: ok ? 'passed' : 'failed',
      checks,
      message: ok ? undefined : 'Browser DOM post-action verification failed.',
      after,
    }
  }

  private defaultVerification(action: BrowserAction): BrowserActionVerification | undefined {
    if (action.verify) return action.verify
    if (action.type === 'type' || action.type === 'setValue') {
      return { value: action.value ?? action.text ?? '' }
    }
    if (action.type === 'select') {
      return { value: action.optionValue ?? action.value ?? '' }
    }
    if (action.type === 'click') {
      // Links prefer navigation evidence; same-page controls still use mutation.
      return { mutation: true, timeoutMs: action.timeoutMs }
    }
    if (action.type === 'navigate') {
      const url = action.url ?? action.value ?? action.text ?? action.selector?.url
      return { urlIncludes: urlIncludesToken(url) ?? url ?? '', timeoutMs: Math.max(action.timeoutMs ?? 0, 15_000) }
    }
    return undefined
  }

  private toFailure(
    rawFailure: BrowserActionFailure | undefined,
    verification: BrowserActionVerificationResult,
    before?: BrowserElementState,
    after?: BrowserElementState,
  ): BrowserActionFailure | undefined {
    if (rawFailure) return rawFailure
    if (!verification.ok) {
      return {
        code: 'verification_failed',
        message: verification.message ?? 'Browser action verification failed.',
        details: {
          checks: verification.checks,
          beforeUrl: before?.url,
          afterUrl: after?.url,
          beforeTitle: before?.title,
          afterTitle: after?.title,
        },
      }
    }
    return undefined
  }

  private fallbackForFailure(failure: BrowserActionFailure | undefined, action: BrowserAction): BrowserFallbackSuggestion | undefined {
    if (!failure) return undefined
    if (failure.code === 'cdp_unavailable' || failure.code === 'target_not_found') {
      return { provider: 'playwright', action: action.type, reason: 'Attach Playwright to the same CDP endpoint or start the browser with --remote-debugging-port.' }
    }
    if (failure.code === 'cross_origin_frame' || failure.code === 'permission_required') {
      return { provider: 'playwright', action: action.type, reason: 'Use Playwright/CDP frame or permission-aware file input APIs for this browser-gated operation.' }
    }
    if (failure.code === 'verification_failed') {
      const beforeUrl = typeof failure.details?.beforeUrl === 'string' ? failure.details.beforeUrl : undefined
      const afterUrl = typeof failure.details?.afterUrl === 'string' ? failure.details.afterUrl : undefined
      if (beforeUrl && afterUrl && beforeUrl !== afterUrl) {
        // URL already moved; do not push Agent toward navigate / vision.
        return undefined
      }
    }
    return {
      provider: 'desktop-vision-hid',
      action: action.type,
      reason: 'DOM verification failed with no navigation evidence; fall back to the visual/HID provider only after rereading page state.',
    }
  }
}

const NAVIGATE_ALIASES = new Set(['navigate', 'goto', 'open', 'load', 'page.navigate', 'cdp_navigate'])

function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (/^https?:\/\//i.test(trimmed) || /^about:blank$/i.test(trimmed)) return true
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)
}

function pickUrl(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (looksLikeUrl(trimmed)) return trimmed
  }
  return undefined
}

function coerceBrowserAction(action: BrowserAction): BrowserAction {
  const raw = action as BrowserAction & Record<string, unknown>
  const url = pickUrl(raw.url, raw.value, raw.text, raw.selector?.url)
  const typeRaw = typeof raw.type === 'string' ? raw.type.trim() : ''
  if (typeRaw && NAVIGATE_ALIASES.has(typeRaw.toLowerCase())) {
    return { ...action, type: 'navigate', ...(url ? { url } : {}) }
  }
  if (!typeRaw && url) {
    return { ...action, type: 'navigate', url }
  }
  return url ? { ...action, url } : action
}

function normalizeNavigateUrl(raw?: string): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) {
    return { ok: false, message: 'Navigate requires a url (action.url). Do not click the address bar.' }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      // eslint-disable-next-line no-new
      new URL(trimmed)
      return { ok: true, url: trimmed }
    } catch {
      return { ok: false, message: `Invalid URL: ${trimmed}` }
    }
  }
  if (/^about:blank$/i.test(trimmed)) {
    return { ok: true, url: 'about:blank' }
  }
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)) {
    return { ok: true, url: `https://${trimmed}` }
  }
  return { ok: false, message: `Not a URL: ${trimmed}` }
}

function urlIncludesToken(url?: string): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.hostname}${path}` || url
  } catch {
    return url
  }
}

function isLinkLikeClick(action: BrowserAction): boolean {
  if (action.type !== 'click') return false
  const element = action.element
  if (!element) {
    const role = action.selector?.role?.toLowerCase()
    const css = action.selector?.css?.toLowerCase() ?? ''
    return role === 'link' || /(^|[\s,#.>~+])a([\s,.#:>[~]|$)/.test(css) || css.includes('a[href')
  }
  const tag = element.tagName?.toLowerCase()
  const role = element.role?.toLowerCase()
  const href = element.attributes?.href
  return tag === 'a' || role === 'link' || typeof href === 'string'
}

function extractRuntimeValue<T>(payload: RuntimeEvaluateResult): T {
  if (payload.exceptionDetails) {
    const message = payload.exceptionDetails.exception?.description ?? payload.exceptionDetails.text ?? 'Runtime.evaluate exception'
    throw new CdpError('runtime_exception', message, payload.exceptionDetails)
  }
  if (!payload.result) {
    throw new CdpError('runtime_missing_result', 'Runtime.evaluate returned no result')
  }
  return payload.result.value as T
}

function isBrowserElement(value: BrowserSelector | BrowserElement): value is BrowserElement {
  return (value as BrowserElement).provider === 'browser' && typeof (value as BrowserElement).id === 'string'
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
