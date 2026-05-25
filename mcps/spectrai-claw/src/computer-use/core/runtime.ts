import { ProviderRegistry, defaultProviderRegistry, type ProviderRouteCandidate, type ProviderRouteOptions } from '../registry.js'
import {
  ComputerUseActionSchema,
  type ActionResult,
  type AppState,
  type AppTarget,
  type CanonicalReport,
  type ComputerUseAction,
  type ComputerUseActionInput,
  type ElementNode,
  type VerificationRequest,
} from '../types.js'
import { actionFailureResult, canonicalFailure, canonicalSuccess, fallbackProviderIds, routeToReportSteps } from './report.js'
import type { ComputerUseProvider } from './provider.js'
import { appTargetFromAction, selectorFromAction, verifyAction } from './verification.js'

export interface ExecuteActionOptions extends ProviderRouteOptions {
  verify?: VerificationRequest
  continueOnProviderFailure?: boolean
}

export interface ReadStateRuntimeOptions extends ProviderRouteOptions {
  includeTree?: boolean
  includeWindows?: boolean
  background?: boolean
}

interface DispatchOutcome {
  result: ActionResult
  state?: AppState
}

function syntheticElement(id: string, source: ElementNode['source'] = 'unknown'): ElementNode {
  return {
    id,
    source,
    role: 'virtual-target',
    isEnabled: true,
    isVisible: true,
    isActionable: true,
  }
}

function defaultVerificationFor(action: ComputerUseAction): VerificationRequest {
  if (action.verify) return action.verify

  if (action.type === 'setValue') {
    return {
      mode: 'compare',
      expectation: {
        selector: action.target,
        value: action.value,
        exists: true,
      },
      timeoutMs: 2_000,
      retries: 1,
    }
  }

  if (action.type === 'typeText' && action.target) {
    return {
      mode: 'compare',
      expectation: {
        selector: action.target,
        text: action.text,
        exists: true,
      },
      timeoutMs: 2_000,
      retries: 1,
    }
  }

  if ('target' in action && action.target) {
    return {
      mode: 'visible-state',
      expectation: {
        selector: action.target,
        exists: true,
        visible: true,
      },
      timeoutMs: 2_000,
      retries: 1,
    }
  }

  if (action.type === 'selectMenu' && action.app) {
    return { mode: 'read', timeoutMs: 2_000, retries: 0 }
  }

  return { mode: 'none', timeoutMs: 2_000, retries: 0 }
}

function isVerificationSupported(candidate: ProviderRouteCandidate, request: VerificationRequest): boolean {
  return request.mode === 'none' || candidate.capability.verificationSupport.includes(request.mode)
}

function actionTarget(action: ComputerUseAction, optionsTarget?: AppTarget): AppTarget | undefined {
  return optionsTarget ?? appTargetFromAction(action)
}

async function dispatchAction(provider: ComputerUseProvider, action: ComputerUseAction, element?: ElementNode): Promise<DispatchOutcome> {
  switch (action.type) {
    case 'readState': {
      const target = action.app ?? element?.nativeRef?.appTarget as AppTarget | undefined
      if (!target) {
        return {
          result: actionFailureResult({
            action,
            providerId: provider.id,
            providerKind: provider.kind,
            code: 'missing_app_target',
            message: 'readState requires an app target.',
          }),
        }
      }

      const state = await provider.getAppState(target, { includeTree: true, includeWindows: true, background: true })
      return {
        state,
        result: {
          ok: true,
          actionId: action.id,
          actionType: 'readState',
          providerId: provider.id,
          providerKind: provider.kind,
          method: 'getAppState',
          changed: false,
          data: { appId: state.appId },
          warnings: [],
        },
      }
    }

    case 'setValue': {
      if (!element) {
        return {
          result: actionFailureResult({
            action,
            providerId: provider.id,
            providerKind: provider.kind,
            code: 'element_not_found',
            message: 'setValue requires a resolved element.',
            fallbackSuggested: true,
          }),
        }
      }

      return { result: await provider.setValue(element, action.value, { append: action.append }) }
    }

    case 'typeText': {
      if (element) {
        return { result: await provider.setValue(element, action.text, { clearExisting: action.clearExisting }) }
      }

      return { result: await provider.invokeElement(syntheticElement('focused-element', 'hid'), action) }
    }

    case 'selectMenu':
      return { result: await provider.selectMenu(action.app, action.menuPath) }

    case 'hotkey':
      return { result: await provider.invokeElement(syntheticElement('system-hotkey', 'hid'), action) }

    case 'scroll':
      return { result: await provider.invokeElement(element ?? syntheticElement('scroll-target', 'hid'), action) }

    case 'invoke':
    case 'click':
    case 'focus':
    case 'select': {
      if (!element) {
        return {
          result: actionFailureResult({
            action,
            providerId: provider.id,
            providerKind: provider.kind,
            code: 'element_not_found',
            message: `${action.type} requires a resolved element.`,
            fallbackSuggested: true,
          }),
        }
      }

      return { result: await provider.invokeElement(element, action) }
    }
  }
}

export class ComputerUseRuntime {
  constructor(readonly registry: ProviderRegistry = defaultProviderRegistry) {}

  canonicalReport(report: CanonicalReport): CanonicalReport {
    return report
  }

  async capabilityReport(target?: AppTarget): Promise<CanonicalReport> {
    const capabilities = await this.registry.capabilityReport(target)
    return canonicalSuccess({
      phase: 'capability',
      target,
      capabilities,
      warnings: capabilities.length === 0 ? ['No computer-use providers are registered.'] : [],
    })
  }

  async route(actionInput: ComputerUseActionInput, options: ProviderRouteOptions = {}): Promise<CanonicalReport> {
    const action = ComputerUseActionSchema.parse(actionInput)
    const candidates = await this.registry.route(action, options)
    const route = routeToReportSteps(candidates)

    if (candidates.length === 0) {
      return canonicalFailure({
        phase: 'route',
        action,
        target: actionTarget(action, options.target),
        code: 'no_provider_available',
        message: `No provider can handle action ${action.type}.`,
        route,
        fallbackSuggested: true,
        fallbackProviders: [],
      })
    }

    return canonicalSuccess({
      phase: 'route',
      providerId: candidates[0].provider.id,
      providerKind: candidates[0].provider.kind,
      action,
      target: actionTarget(action, options.target),
      route,
      capabilities: candidates.map((candidate) => candidate.capability),
    })
  }

  async readState(target: AppTarget, options: ReadStateRuntimeOptions = {}): Promise<CanonicalReport> {
    const action: ComputerUseAction = { type: 'readState', app: target }
    const candidates = await this.registry.route(action, {
      ...options,
      target,
      requireBackground: options.background ?? options.requireBackground,
    })
    const route = routeToReportSteps(candidates)

    for (const candidate of candidates) {
      try {
        const state = await candidate.provider.getAppState(target, {
          includeTree: options.includeTree ?? true,
          includeWindows: options.includeWindows ?? true,
          background: options.background ?? true,
        })

        return canonicalSuccess({
          phase: 'read',
          providerId: candidate.provider.id,
          providerKind: candidate.provider.kind,
          target,
          state,
          route,
          capabilities: candidates.map((item) => item.capability),
        })
      } catch {
        // Try next provider in priority order; final failure is reported below.
      }
    }

    return canonicalFailure({
      phase: 'read',
      action,
      target,
      code: 'read_state_failed',
      message: 'All routed providers failed to read app state.',
      route,
      fallbackSuggested: true,
      fallbackProviders: fallbackProviderIds(candidates),
      capabilities: candidates.map((candidate) => candidate.capability),
    })
  }

  async executeAction(actionInput: ComputerUseActionInput, options: ExecuteActionOptions = {}): Promise<CanonicalReport> {
    const action = ComputerUseActionSchema.parse(actionInput)
    const candidates = await this.registry.route(action, options)
    const route = routeToReportSteps(candidates)
    const fallbackIds = fallbackProviderIds(candidates)
    const capabilities = candidates.map((candidate) => candidate.capability)
    const warnings: string[] = []

    if (candidates.length === 0) {
      return canonicalFailure({
        phase: 'route',
        action,
        target: actionTarget(action, options.target),
        code: 'no_provider_available',
        message: `No provider can handle action ${action.type}.`,
        route,
        fallbackSuggested: true,
        fallbackProviders: fallbackIds,
      })
    }

    for (const candidate of candidates) {
      const provider = candidate.provider
      const selector = selectorFromAction(action)
      let element: ElementNode | undefined

      try {
        if (selector) {
          element = await provider.findElement(selector, { background: !candidate.capability.requiresForeground }) ?? undefined
          if (!element) {
            warnings.push(`${provider.id}: selector was not found before ${action.type}.`)
            if (options.continueOnProviderFailure ?? true) continue
          }
        }

        const outcome = await dispatchAction(provider, action, element)
        const result = {
          ...outcome.result,
          providerId: outcome.result.providerId ?? provider.id,
          providerKind: outcome.result.providerKind ?? provider.kind,
          usedFallback: candidate.fallback || outcome.result.usedFallback,
          fallbackSuggested: outcome.result.fallbackSuggested ?? false,
          warnings: [...(outcome.result.warnings ?? []), ...warnings],
        }

        if (!result.ok) {
          warnings.push(`${provider.id}: ${result.error?.message ?? 'action failed'}`)
          if (options.continueOnProviderFailure ?? true) continue

          return canonicalFailure({
            phase: 'execute',
            providerId: provider.id,
            providerKind: provider.kind,
            action,
            target: actionTarget(action, options.target),
            result,
            capabilities,
            route,
            fallbackSuggested: true,
            fallbackProviders: fallbackIds,
            code: result.error?.code ?? 'action_failed',
            message: result.error?.message ?? `Provider ${provider.id} failed action ${action.type}.`,
            warnings,
          })
        }

        const verificationRequest = options.verify ?? defaultVerificationFor(action)
        if (!isVerificationSupported(candidate, verificationRequest)) {
          const failedResult = {
            ...result,
            ok: false,
            fallbackSuggested: true,
            fallbackReason: `Provider ${provider.id} does not support ${verificationRequest.mode} verification.`,
          }

          return canonicalFailure({
            phase: 'verify',
            providerId: provider.id,
            providerKind: provider.kind,
            action,
            target: actionTarget(action, options.target),
            result: failedResult,
            capabilities,
            route,
            fallbackSuggested: true,
            fallbackProviders: fallbackIds,
            code: 'verification_not_supported',
            message: failedResult.fallbackReason,
            warnings,
          })
        }

        const verification = await verifyAction({
          provider,
          action,
          request: verificationRequest,
          targetElement: result.targetElement ?? element,
        })

        if (!verification.ok) {
          const failedResult = {
            ...result,
            ok: false,
            verification,
            fallbackSuggested: true,
            fallbackReason: verification.message ?? 'Post-action verification failed.',
          }

          return canonicalFailure({
            phase: 'verify',
            providerId: provider.id,
            providerKind: provider.kind,
            action,
            target: actionTarget(action, options.target),
            result: failedResult,
            state: outcome.state,
            capabilities,
            verification,
            route,
            fallbackSuggested: true,
            fallbackProviders: fallbackIds,
            code: 'verification_failed',
            message: verification.message ?? 'Post-action verification failed.',
            warnings,
          })
        }

        return canonicalSuccess({
          phase: 'execute',
          providerId: provider.id,
          providerKind: provider.kind,
          action,
          target: actionTarget(action, options.target),
          result: { ...result, verification },
          state: outcome.state,
          verification,
          capabilities,
          route,
          warnings,
        })
      } catch (error) {
        warnings.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`)
        if (!(options.continueOnProviderFailure ?? true)) {
          return canonicalFailure({
            phase: 'execute',
            providerId: provider.id,
            providerKind: provider.kind,
            action,
            target: actionTarget(action, options.target),
            capabilities,
            route,
            fallbackSuggested: true,
            fallbackProviders: fallbackIds,
            code: 'provider_exception',
            message: error instanceof Error ? error.message : String(error),
            warnings,
          })
        }
      }
    }

    return canonicalFailure({
      phase: 'execute',
      action,
      target: actionTarget(action, options.target),
      capabilities,
      route,
      fallbackSuggested: true,
      fallbackProviders: fallbackIds,
      code: 'all_providers_failed',
      message: `All routed providers failed action ${action.type}.`,
      warnings,
    })
  }
}

export const defaultComputerUseRuntime = new ComputerUseRuntime(defaultProviderRegistry)
