import type {
  ComputerUseContext,
  ComputerUseProvider,
  FindElementOptions,
  GetTreeOptions,
  InvokeElementOptions,
  ReadStateOptions,
  SelectMenuOptions,
  SetValueOptions,
} from './provider.js'
import {
  CapabilityReportSchema,
  type ActionResult,
  type AppState,
  type AppTarget,
  type CapabilityReport,
  type ComputerUseAction,
  type ComputerUsePlatform,
  type ElementNode,
  type ElementSelector,
  type ElementSource,
} from '../types.js'

export interface LegacyFallbackAdapterCallbacks {
  listApps?: (context?: ComputerUseContext) => Promise<AppState[]>
  getAppState?: (target: AppTarget, options?: ReadStateOptions) => Promise<AppState>
  getAppTree?: (target: AppTarget, options?: GetTreeOptions) => Promise<ElementNode>
  findElement?: (selector: ElementSelector, options?: FindElementOptions) => Promise<ElementNode | null>
  invokeElement?: (element: ElementNode, action?: ComputerUseAction, options?: InvokeElementOptions) => Promise<ActionResult>
  setValue?: (element: ElementNode, value: string | number | boolean | null, options?: SetValueOptions) => Promise<ActionResult>
  selectMenu?: (target: AppTarget | undefined, menuPath: string[], options?: SelectMenuOptions) => Promise<ActionResult>
  getCapabilities?: (target?: AppTarget, context?: ComputerUseContext) => Promise<Partial<CapabilityReport>>
}

export interface LegacyFallbackAdapterConfig extends LegacyFallbackAdapterCallbacks {
  id: string
  displayName?: string
  platform: ComputerUsePlatform
  kind: 'vision-ocr' | 'hid'
  source: ElementSource[]
  priority?: number
}

function unsupportedResult(provider: LegacyFallbackAdapterConfig, actionType: ActionResult['actionType'], message: string): ActionResult {
  return {
    ok: false,
    actionType,
    providerId: provider.id,
    providerKind: provider.kind,
    fallbackSuggested: provider.kind !== 'hid',
    fallbackReason: message,
    error: {
      code: 'unsupported_fallback_operation',
      message,
    },
    warnings: [],
  }
}

function unsupported(method: string): Error {
  return new Error(`Fallback adapter does not implement ${method}.`)
}

/**
 * Wraps existing screenshot/OCR/HID implementations in the new provider contract.
 *
 * This is intentionally an extension point: Agent B/C/D can bind current Claw
 * desktop-tools, Swift daemon detectElements/click/type, or Windows PowerShell
 * OCR/HID callbacks without changing the public MCP tool interface.
 */
export function createLegacyFallbackProvider(config: LegacyFallbackAdapterConfig): ComputerUseProvider {
  return {
    id: config.id,
    kind: config.kind,
    platform: config.platform,
    displayName: config.displayName,
    priority: config.priority,
    source: config.source,

    listApps(context?: ComputerUseContext) {
      return config.listApps?.(context) ?? Promise.resolve([])
    },

    getAppState(target: AppTarget, options?: ReadStateOptions) {
      return config.getAppState?.(target, options) ?? Promise.reject(unsupported('getAppState'))
    },

    getAppTree(target: AppTarget, options?: GetTreeOptions) {
      return config.getAppTree?.(target, options) ?? Promise.reject(unsupported('getAppTree'))
    },

    findElement(selector: ElementSelector, options?: FindElementOptions) {
      return config.findElement?.(selector, options) ?? Promise.resolve(null)
    },

    invokeElement(element: ElementNode, action?: ComputerUseAction, options?: InvokeElementOptions) {
      return config.invokeElement?.(element, action, options)
        ?? Promise.resolve(unsupportedResult(config, action?.type ?? 'invoke', 'invokeElement is not implemented by this fallback adapter.'))
    },

    setValue(element: ElementNode, value: string | number | boolean | null, options?: SetValueOptions) {
      return config.setValue?.(element, value, options)
        ?? Promise.resolve(unsupportedResult(config, 'setValue', 'setValue is not implemented by this fallback adapter.'))
    },

    selectMenu(target: AppTarget | undefined, menuPath: string[], options?: SelectMenuOptions) {
      return config.selectMenu?.(target, menuPath, options)
        ?? Promise.resolve(unsupportedResult(config, 'selectMenu', `selectMenu(${menuPath.join(' > ')}) is not implemented by this fallback adapter.`))
    },

    async getCapabilities(target?: AppTarget, context?: ComputerUseContext) {
      const override = await config.getCapabilities?.(target, context)
      return CapabilityReportSchema.parse({
        providerId: config.id,
        providerKind: config.kind,
        platform: config.platform,
        source: config.source,
        priority: config.priority ?? 0,
        backgroundRead: false,
        backgroundInvoke: false,
        backgroundType: false,
        requiresForeground: true,
        visionFallbackNeeded: config.kind === 'hid',
        supportedActions: config.kind === 'hid' ? ['click', 'typeText', 'hotkey', 'scroll'] : ['readState', 'click', 'invoke'],
        verificationSupport: config.kind === 'vision-ocr' ? ['visible-state'] : ['none'],
        supportsElementTree: config.kind === 'vision-ocr',
        supportsSelectorLookup: config.kind === 'vision-ocr',
        supportsWindowState: false,
        permissions: config.kind === 'vision-ocr' ? ['screen-recording'] : ['accessibility-or-input-monitoring'],
        limitations: [
          'Fallback provider is best-effort and should be used after semantic providers fail or require foreground.',
        ],
        confidence: config.kind === 'vision-ocr' ? 0.65 : 0.45,
        target,
        ...override,
      })
    },
  }
}
